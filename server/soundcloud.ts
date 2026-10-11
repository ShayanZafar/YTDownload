/**
 * SoundCloud: the fallback for audio. A search asks it when YouTube's search
 * fails or finds nothing — and at the same time as YouTube while YouTube has
 * been refusing this computer (`searchSongs()` in search.ts) — and a
 * SoundCloud result is downloaded and saved through the same yt-dlp → ffmpeg
 * pipeline as a YouTube video.
 *
 * yt-dlp does the talking, with no account or key (it uses SoundCloud's own
 * web client id). Only canonical track links (shared/soundcloud-link.ts) are
 * made from what yt-dlp lists, and only those are given back to yt-dlp. Every
 * attempt is recorded as `soundcloud` in the source-health report.
 *
 * Some tracks only subscribers can hear in full: to everyone else SoundCloud
 * gives a 30-second preview. A search lists such a track as 30 seconds long
 * (ranked last), and the look-up before a download refuses it — yt-dlp names
 * the stream "…_preview" — rather than save 30 seconds of a song.
 */
import type { SearchResult } from "@shared/schema";
import { parseSoundCloudLink, soundCloudTrackLink } from "@shared/soundcloud-link";
import { fetchAudioInfo, type AudioInfo } from "./audio";
import type { RawSearchEntry } from "./search";
import { sourceHealth, type SourceHealthStore } from "./source-health";
import { classifyYtDlpError, failureKindOf } from "./youtube-limits";

// SoundCloud's artwork lives on its image host (i1.sndcdn.com…): nothing else
// goes into the page as a picture.
const ARTWORK_RE = /^https:\/\/[a-z0-9-]+\.sndcdn\.com\/[^\s"'<>]+$/;
/** The artwork size the results list shows best (SoundCloud's are square: "t300x300"). */
const ARTWORK_WIDTH = 300;

/** A track's artwork from its listing: about 300 px wide if there's one, else the biggest there is. */
function artworkOf(entry: RawSearchEntry): string {
  const sized = (Array.isArray(entry.thumbnails) ? entry.thumbnails : [])
    .filter((t): t is { url: string; width?: unknown } => typeof t?.url === "string")
    .map((t) => ({ url: t.url, width: typeof t.width === "number" ? t.width : 0 }))
    .filter((t) => ARTWORK_RE.test(t.url))
    .sort((a, b) => a.width - b.width);
  const best = sized.find((t) => t.width >= ARTWORK_WIDTH) ?? sized.at(-1);
  if (best) return best.url;
  return typeof entry.thumbnail === "string" && ARTWORK_RE.test(entry.thumbnail)
    ? entry.thumbnail
    : "";
}

/**
 * The track's canonical link: from its `url` (the URN form yt-dlp lists, or
 * already canonical), else from its `id` if that's a plain track number.
 */
function trackLinkOf(entry: RawSearchEntry): string | undefined {
  const fromUrl = parseSoundCloudLink(entry.url);
  if (fromUrl) return fromUrl;
  const id = typeof entry.id === "number" ? String(entry.id) : entry.id;
  return typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id)
    ? soundCloudTrackLink(id)
    : undefined;
}

/**
 * A SoundCloud search entry as a result: its canonical track link, title,
 * uploader, length and artwork, with `source: "soundcloud"` — or undefined if
 * it has no usable link. Never "official": the listing doesn't say who
 * uploaded it on whose behalf.
 */
export function soundCloudResult(entry: RawSearchEntry): SearchResult | undefined {
  const url = trackLinkOf(entry);
  if (!url) return undefined;
  return {
    // SoundCloud's own name for the track: its URN.
    id: `soundcloud:tracks:${url.slice(url.lastIndexOf("/") + 1)}`,
    url,
    title: entry.title?.trim() || "Untitled",
    channel: (entry.uploader ?? entry.channel ?? "").trim(),
    duration: typeof entry.duration === "number" ? Math.round(entry.duration) : null,
    thumbnail: artworkOf(entry),
    official: false,
    source: "soundcloud",
  };
}

/** How long SoundCloud's preview of a subscribers-only track is. */
export const PREVIEW_SECONDS = 30;

/**
 * Does a search entry look like a 30-second preview? SoundCloud lists such a
 * track with the preview's length (exactly 30 s) instead of the song's. Ranked
 * last among SoundCloud's results; never a confident match for a song.
 */
export const looksLikePreview = (entry: RawSearchEntry) =>
  typeof entry.duration === "number" && Math.abs(entry.duration - PREVIEW_SECONDS) < 0.5;

/** What the look-up says about a track SoundCloud only shares a preview of. */
export const PREVIEW_ONLY =
  "SoundCloud shares only a 30-second preview of this track (the whole song is for its subscribers). Pick another result.";

/**
 * Is the stream yt-dlp picked a 30-second preview? yt-dlp ends such a
 * stream's format id with "_preview" ("http_mp3_1_0_preview", say); for a
 * track SoundCloud only previews, that's the best audio there is.
 */
export const isPreview = (info: Pick<AudioInfo, "formatId">) =>
  /(?:^|_)preview(?:_|$)/i.test(info.formatId ?? "");

/** Records how a SoundCloud attempt went, for the source-health report. */
export function recordSoundCloud(
  ok: boolean,
  reason = "",
  health: Pick<SourceHealthStore, "record"> = sourceHealth,
) {
  const kind = ok ? undefined : classifyYtDlpError(reason);
  // A track that's gone or private is SoundCloud answering properly, not failing us.
  if (ok || kind === "unavailable") return health.record("soundcloud", true);
  health.record("soundcloud", false, { kind: failureKindOf(kind!), note: reason });
}

/**
 * The look-up before downloading a SoundCloud track (`url`: a canonical
 * link): its title, uploader and the stream yt-dlp picks — recorded. A track
 * SoundCloud only previews fails here, before any file is started.
 */
export async function lookUpSoundCloud(
  url: string,
  {
    lookUp = fetchAudioInfo,
    health = sourceHealth,
  }: {
    lookUp?: (url: string) => Promise<AudioInfo>;
    health?: Pick<SourceHealthStore, "record">;
  } = {},
): Promise<AudioInfo> {
  let info: AudioInfo;
  try {
    info = await lookUp(url);
  } catch (err) {
    recordSoundCloud(false, err instanceof Error ? err.message : String(err), health);
    throw err;
  }
  recordSoundCloud(true, "", health);
  if (isPreview(info)) throw new Error(PREVIEW_ONLY);
  return info;
}
