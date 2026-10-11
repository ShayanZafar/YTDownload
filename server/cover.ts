/**
 * Cover art for downloads: the album cover from Spotify for a Spotify song,
 * otherwise the video's thumbnail from YouTube, cut to a square (the middle
 * of the picture — for a YouTube Music upload, that's exactly the album
 * cover) and made a JPEG of at most 600×600, which every player shows.
 *
 * Only YouTube's thumbnail host (at an address built from the validated video
 * id) and Spotify's image hosts are ever fetched. A cover that can't be had
 * quickly is simply left out: the download never waits on it for long or
 * fails because of it.
 */
import { spawn } from "child_process";
import { FFMPEG_PATH } from "./audio";
import { jpegSize } from "./tags";

/** The cover's largest side, in pixels. */
export const COVER_SIZE = 600;
const FETCH_TIMEOUT_MS = 5_000;
const CONVERT_TIMEOUT_MS = 10_000;
/** Bigger pictures than this aren't covers (YouTube's largest thumbnails are ~200 KB). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SPOTIFY_COVER_RE =
  /^https:\/\/(?:i\.scdn\.co|image-cdn-[a-z]{2}\.spotifycdn\.com)\/image\/[a-f0-9]{16,64}$/;

/** Where a cover can come from: a Spotify album cover, or a YouTube video's thumbnails. */
export type CoverSource = { kind: "spotify"; url: string } | { kind: "youtube"; videoId: string };

/** Is this the address of a Spotify cover picture (so the app may fetch it)? */
export const isSpotifyCoverUrl = (url: string) => SPOTIFY_COVER_RE.test(url);

/**
 * A video's thumbnails, best first: 1280×720 (not every video has it), then
 * 640×480 and 480×360 (both letterboxed 16:9 pictures).
 */
export function youtubeThumbnailUrls(videoId: string): string[] {
  if (!VIDEO_ID_RE.test(videoId)) return [];
  return ["maxresdefault", "sddefault", "hqdefault"].map(
    (name) => `https://i.ytimg.com/vi/${videoId}/${name}.jpg`,
  );
}

/**
 * ffmpeg's filter that makes a picture a square cover: the middle square of a
 * 16:9 video picture (inside the black bars of a 4:3 thumbnail), or a Spotify
 * cover as it is (already square), no bigger than COVER_SIZE.
 */
export function coverFilter(kind: CoverSource["kind"]): string {
  // Commas inside an expression are escaped: in a filter they separate filters.
  const side = kind === "youtube" ? "min(min(iw\\,ih)\\,iw*9/16)" : "min(iw\\,ih)";
  return `crop=${side}:${side},scale='min(${COVER_SIZE}\\,iw)':-2`;
}

/** ffmpeg arguments that turn a picture on stdin into a square JPEG cover on stdout. */
export function coverArgs(kind: CoverSource["kind"]): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error", "-i", "pipe:0"],
    ...["-vf", coverFilter(kind), "-frames:v", "1", "-q:v", "3"],
    ...["-f", "mjpeg", "pipe:1"],
  ];
}

/** The cover for a download, as a JPEG, or undefined if there's none to be had. */
export async function fetchCover(source: CoverSource): Promise<Buffer | undefined> {
  const urls =
    source.kind === "youtube"
      ? youtubeThumbnailUrls(source.videoId)
      : isSpotifyCoverUrl(source.url)
        ? [source.url]
        : [];
  for (const url of urls) {
    const picture = await fetchImage(url);
    if (picture) return squareJpeg(picture, source.kind).catch(() => undefined);
  }
  return undefined;
}

async function fetchImage(url: string): Promise<Buffer | undefined> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // YouTube answers a missing thumbnail with a 404 (and a grey picture).
    if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/** Runs ffmpeg on a picture to make it a square JPEG cover. */
export function squareJpeg(picture: Buffer, kind: CoverSource["kind"]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!FFMPEG_PATH) return reject(new Error("No ffmpeg"));
    const ffmpeg = spawn(FFMPEG_PATH, coverArgs(kind), { windowsHide: true });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => ffmpeg.kill(), CONVERT_TIMEOUT_MS);
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stdin.on("error", () => {}); // ffmpeg may stop reading early
    ffmpeg.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ffmpeg.on("close", (code) => {
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      if (code === 0 && jpegSize(jpeg)) resolve(jpeg);
      else reject(new Error(`ffmpeg couldn't make the cover (exit code ${code})`));
    });
    ffmpeg.stdin.end(picture);
  });
}

/** The longest a download waits for its cover (beyond the YouTube lookup it runs alongside). */
const COVER_WAIT_MS = 10_000;

/**
 * The cover for a download of this video: the Spotify album cover when the
 * song's Spotify details have one, otherwise the video's thumbnail (if it's a
 * video) — or undefined if neither comes within COVER_WAIT_MS. Never fails.
 */
export function coverFor(
  videoId: string | undefined,
  spotify?: Promise<{ coverUrl?: string } | undefined>,
): Promise<Buffer | undefined> {
  const find = async () => {
    const url = (await spotify)?.coverUrl;
    return (
      (url ? await fetchCover({ kind: "spotify", url }) : undefined) ??
      (videoId ? await fetchCover({ kind: "youtube", videoId }) : undefined)
    );
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), COVER_WAIT_MS);
  });
  return Promise.race([find().catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}
