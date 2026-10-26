/**
 * Turning a YouTube video (or a SoundCloud track: the same pipeline) into a
 * downloadable audio stream.
 *
 *   yt-dlp  ──(best audio on stdout)──▶  ffmpeg  ──(file on stdout)──▶  HTTP response
 *                                                                   or a file in the "Save to" folder
 *
 * ffmpeg either converts to MP3 (the default) or, for "original", just
 * repackages the source's own stream into a proper audio file without
 * re-encoding.
 * No temporary files: the browser's download starts with the first chunk (or,
 * with a "Save to" folder, the file is written as the audio arrives).
 * Both binaries are fetched by `npm install` (youtube-dl-exec → yt-dlp,
 * ffmpeg-static → ffmpeg), so there's nothing to install system-wide.
 * Set FFMPEG_BIN to use a different ffmpeg.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Transform, type Readable } from "stream";
import ffmpegStatic from "ffmpeg-static";
import youtubedl from "youtube-dl-exec";
import type { DownloadFormat } from "@shared/routes";
import { soundCloudArtworkUrl } from "@shared/soundcloud-link";
import type { LateDetails } from "./download-details";
import { retryWhenBusy } from "./retry-when-busy";
import { ffmetadataValue, flacPictureBlock, id3v2Tag, type SongTags } from "./tags";
import { pickThumbnail, type ThumbnailLike } from "./youtube-url";

// Flags shared by every yt-dlp call.
// `jsRuntimes: "node"` — since late 2025 yt-dlp needs a JavaScript runtime to
// solve YouTube's player challenges, and only Deno is enabled by default.
// Node is always present (it's running this server), so let yt-dlp use it.
export const YT_DLP_BASE_FLAGS = {
  noWarnings: true,
  noPlaylist: true,
  jsRuntimes: "node",
} as const;

// The best audio stream YouTube serves without an account. yt-dlp ranks the
// streams by quality: for most videos that's Opus at ~130 kbps (format 251),
// with AAC (140) as the fallback, and it skips the volume-compressed "DRC"
// variants. (Higher-bitrate streams exist only for YouTube Premium; we don't
// use them.) Both Opus/WebM and AAC/M4A stream fine through the ffmpeg pipe.
export const AUDIO_FORMAT = "bestaudio";

// 320 kbps is the highest bitrate MP3 supports, so converting loses as little
// as possible of the source. Constant bitrate on purpose: the MP3 is streamed
// while it's encoded, so ffmpeg can't go back and write the seek header a VBR
// file needs — without it, players show the wrong duration.
export const MP3_BITRATE = "320k";

// LAME's quality setting (0 = best/slowest … 9 = fastest). 2 is what LAME
// recommends for high quality; 0 and 1 are over twice as slow again for no
// audible gain. Encodes at roughly 15× real time on a typical PC.
export const LAME_QUALITY = "2";

// youtube-dl-exec's typings leave these out, but the module does export them.
const ytDlpModule = youtubedl as unknown as {
  constants: { YOUTUBE_DL_PATH: string };
  args: (flags: Record<string, unknown>) => string[];
};

export const YT_DLP_PATH = ytDlpModule.constants.YOUTUBE_DL_PATH;
export const FFMPEG_PATH = ffmpegStatic; // null only on platforms ffmpeg-static doesn't cover

/**
 * A download's tags: title, artist, album, genre, date, track number, and the
 * Spotify song it is (`spotifyId`), written into the file so the playlist
 * panel recognises it in the "Save to" folder, even after a rename.
 */
export type AudioMetadata = SongTags;

/**
 * What a download produces: the file extension, its MIME type, the ffmpeg
 * arguments, and for an MP3, the tag that goes in front of ffmpeg's audio.
 */
export type AudioOutput = {
  ext: string;
  contentType: string;
  ffmpegArgs: string[];
  prefix?: Buffer;
};

/**
 * The download's cover (a JPEG), and the files ffmpeg reads it from where the
 * cover can't go on its command line: a Matroska attachment (`file`), and an
 * Opus file's METADATA_BLOCK_PICTURE comment (`tagsFile`, ffmpeg's metadata
 * file — a cover is far longer than a Windows command line allows).
 */
export type CoverFiles = { jpeg: Buffer; file?: string; tagsFile?: string };

type Container = { ext: string; contentType: string; muxerArgs: string[] };

/** yt-dlp arguments that write the chosen audio stream to stdout. */
export function ytDlpAudioArgs(videoUrl: string, format: string = AUDIO_FORMAT): string[] {
  return [
    videoUrl,
    ...ytDlpModule.args({ format, output: "-", quiet: true, ...YT_DLP_BASE_FLAGS }),
  ];
}

// Read audio on stdin, drop whatever tags the source container carried, and
// write our own: title, artist, album, genre, date, track number, and the Spotify
// song if it's one (a SPOTIFY_ID comment in Ogg and Matroska). An Opus file's
// cover comes from ffmpeg's metadata file, read as a second input.
function ffmpegInputAndTags(
  { title, artist, album, genre, date, track, spotifyId }: AudioMetadata,
  tagsFile?: string,
): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0"];
  if (tagsFile) args.push("-f", "ffmetadata", "-i", tagsFile, "-map", "0:a");
  args.push("-vn", "-map_metadata", tagsFile ? "1" : "-1", "-metadata", `title=${title}`);
  if (artist) args.push("-metadata", `artist=${artist}`);
  if (album) args.push("-metadata", `album=${album}`);
  if (genre) args.push("-metadata", `genre=${genre}`);
  if (date) args.push("-metadata", `date=${date}`);
  if (track) args.push("-metadata", `track=${track}`);
  if (spotifyId) args.push("-metadata", `spotify_id=${spotifyId}`);
  return args;
}

/** The Spotify song's link, the way it's written into a file's comment. */
export const spotifySongLink = (id: string) => `https://open.spotify.com/track/${id}`;

/**
 * ffmpeg arguments that convert any audio on stdin to a 320 kbps MP3 on
 * stdout, without tags: the app writes the MP3's tag itself (`id3v2Tag()`),
 * since ffmpeg can't stream one with a cover.
 */
export function ffmpegMp3Args(): string[] {
  return [
    ...["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-map_metadata", "-1"],
    ...["-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-compression_level", LAME_QUALITY],
    // No tag of ffmpeg's own: `-id3v2_version 0` (the mp3 muxer has no
    // "-write_id3v2", and ignores it — leaving a second ID3v2.4 tag after the app's).
    ...["-id3v2_version", "0", "-f", "mp3", "pipe:1"],
  ];
}

/**
 * Where to put the source's original stream so it's a normal, tagged audio
 * file. The audio itself is copied bit-for-bit (`-c:a copy`); only the
 * container changes.
 */
export function originalContainer(acodec: string | undefined): Container {
  if (acodec?.startsWith("mp3")) {
    // MP3 (what SoundCloud often streams) stays an .mp3, with the same
    // ID3v2.3 tags as a converted one.
    return {
      ext: "mp3",
      contentType: "audio/mpeg",
      muxerArgs: ["-id3v2_version", "3", "-f", "mp3"],
    };
  }
  if (acodec?.startsWith("opus")) {
    // Ogg Opus (.opus) — the standard file for Opus audio. Players treat it as
    // music (a .webm is often mistaken for video) and show its tags.
    return { ext: "opus", contentType: "audio/ogg", muxerArgs: ["-f", "opus"] };
  }
  if (acodec?.startsWith("mp4a")) {
    // AAC → .m4a. Written as a fragmented MP4 because a regular one needs to
    // seek back to the start of the file, which a stream can't do.
    return {
      ext: "m4a",
      contentType: "audio/mp4",
      muxerArgs: [
        "-f",
        "ipod",
        "-movflags",
        "empty_moov+default_base_moof",
        "-frag_duration",
        "2000000",
      ],
    };
  }
  // Anything else a source might serve: Matroska audio holds any codec.
  return { ext: "mka", contentType: "audio/x-matroska", muxerArgs: ["-f", "matroska"] };
}

/** The file a download produces, for the requested format and the stream the source picked. */
export function audioOutput(
  format: DownloadFormat,
  meta: AudioMetadata,
  sourceAcodec?: string,
  cover?: CoverFiles,
): AudioOutput {
  if (format === "mp3") {
    return {
      ext: "mp3",
      contentType: "audio/mpeg",
      ffmpegArgs: ffmpegMp3Args(),
      prefix: id3v2Tag(meta, cover?.jpeg),
    };
  }
  const { ext, contentType, muxerArgs } = originalContainer(sourceAcodec);
  // An .m4a can't hold a tag of our own, so the Spotify song goes in its comment.
  const songComment =
    ext === "m4a" && meta.spotifyId
      ? ["-metadata", `comment=${spotifySongLink(meta.spotifyId)}`]
      : [];
  // Matroska keeps a cover as an attached file named "cover.jpg". (A streamed
  // .m4a can't hold one: its header is written before any picture arrives.)
  const attachment =
    ext === "mka" && cover?.file
      ? [
          ...["-attach", cover.file],
          ...["-metadata:s:t:0", "mimetype=image/jpeg", "-metadata:s:t:0", "filename=cover.jpg"],
        ]
      : [];
  return {
    ext,
    contentType,
    ffmpegArgs: [
      ...ffmpegInputAndTags(meta, ext === "opus" ? cover?.tagsFile : undefined),
      ...songComment,
      ...attachment,
      "-c:a",
      "copy",
      ...muxerArgs,
      "pipe:1",
    ],
  };
}

/**
 * A download's output, and a way to delete the cover files made for it once
 * ffmpeg is done. An MP3's tag may still be on its way (`prefix` a promise):
 * it goes out with the first audio.
 */
export type PreparedOutput = Omit<AudioOutput, "prefix"> & {
  prefix?: Buffer | Promise<Buffer>;
  cleanup: () => Promise<void>;
};

/**
 * `audioOutput()` with a cover: for the containers that need it, the cover is
 * written into a temp folder for ffmpeg to read (deleted by `cleanup()`).
 *
 * `later` is what the music catalogues add (download-details.ts), which never
 * fails. An MP3's tag waits for it while ffmpeg starts on the audio; the other
 * files carry their tags in ffmpeg's arguments, so they wait for it first.
 */
export async function prepareAudioOutput(
  format: DownloadFormat,
  meta: AudioMetadata,
  sourceAcodec?: string,
  cover?: Buffer,
  later?: Promise<LateDetails>,
): Promise<PreparedOutput> {
  if (later && format === "mp3") {
    const output = audioOutput(format, meta, sourceAcodec);
    const prefix = later.then(
      (found) => id3v2Tag({ ...meta, ...found.tags }, cover ?? found.cover),
      () => id3v2Tag(meta, cover),
    );
    return { ...output, prefix, cleanup: async () => {} };
  }
  if (later) {
    const found = await later.catch(() => ({ tags: {}, cover: undefined }));
    meta = { ...meta, ...found.tags };
    cover ??= found.cover;
  }
  const ext = format === "mp3" ? "mp3" : originalContainer(sourceAcodec).ext;
  if (!cover || (ext !== "opus" && ext !== "mka")) {
    const files = cover ? { jpeg: cover } : undefined;
    return { ...audioOutput(format, meta, sourceAcodec, files), cleanup: async () => {} };
  }
  // Named unlike the tests' temp files, so `npm run clean` leaves it alone.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ytdownload-cover-"));
  const cleanup = () =>
    retryWhenBusy(() => fs.rm(dir, { recursive: true, force: true })).catch(() => {});
  try {
    const files: CoverFiles = { jpeg: cover };
    if (ext === "opus") {
      files.tagsFile = path.join(dir, "tags.txt");
      const picture = ffmetadataValue(flacPictureBlock(cover));
      await fs.writeFile(files.tagsFile, `;FFMETADATA1\nMETADATA_BLOCK_PICTURE=${picture}\n`);
    } else {
      files.file = path.join(dir, "cover.jpg");
      await fs.writeFile(files.file, cover);
    }
    return { ...audioOutput(format, meta, sourceAcodec, files), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export function spawnYtDlpAudio(videoUrl: string, format?: string): ChildProcessWithoutNullStreams {
  return spawn(YT_DLP_PATH, ytDlpAudioArgs(videoUrl, format), { windowsHide: true });
}

const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Runs yt-dlp directly — never through a shell — so text from the search box
 * can't be interpreted as a command, and parses its JSON output (a search's or
 * a playlist's flat listing).
 */
export function runYtDlpJson(args: string[], timeoutMs = SEARCH_TIMEOUT_MS): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_PATH, args, { windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const message = Buffer.concat(err).toString("utf8").trim().split(/\r?\n/).pop();
        return reject(new Error(message || `yt-dlp exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch {
        reject(new Error("yt-dlp returned unexpected search output"));
      }
    });
  });
}

/**
 * What the page shows for a pasted link before downloading: the title, a
 * thumbnail, and the channel (the name it's saved as comes from the title and
 * the channel: shared/song-name.ts).
 */
export type VideoInfo = { title: string; thumbnail: string; channel?: string };

/**
 * A YouTube video's title, thumbnail and channel. Only those are kept: yt-dlp's
 * whole answer lists every format and runs to hundreds of KB.
 */
export async function fetchVideoInfo(videoUrl: string): Promise<VideoInfo> {
  let info: ThumbnailLike & { title?: string; uploader?: string; channel?: string };
  try {
    info = (await youtubedl(videoUrl, {
      dumpSingleJson: true,
      skipDownload: true,
      ...YT_DLP_BASE_FLAGS,
    })) as typeof info;
  } catch (err) {
    throw new Error(ytDlpFailure(err), { cause: err });
  }
  // The same channel name the download goes by (fetchAudioInfo).
  const channel = info.uploader ?? info.channel;
  return {
    title: info.title ?? "Untitled",
    thumbnail: pickThumbnail(info),
    ...(channel ? { channel } : {}),
  };
}

export function spawnFfmpeg(args: string[]) {
  if (!FFMPEG_PATH) {
    throw new Error("No bundled ffmpeg for this platform. Set FFMPEG_BIN to an ffmpeg binary.");
  }
  return spawn(FFMPEG_PATH, args, { windowsHide: true });
}

/** What the metadata pass found out about a video's (or a track's) audio. */
export type AudioInfo = AudioMetadata & {
  /**
   * The audio stream yt-dlp picked; the download is pinned to it. (SoundCloud's
   * 30-second previews end in "_preview": see soundcloud.ts.)
   */
  formatId?: string;
  /** Its codec ("opus", "mp4a.40.2", "mp3"…), which decides the "original" file type. */
  acodec?: string;
  /** A SoundCloud track's artwork, 500×500 (for its cover); a YouTube video has none here. */
  artwork?: string;
  /** Its length in seconds (to tell the song from other recordings in the music catalogues). */
  duration?: number;
};

/**
 * A stream's codec: yt-dlp's `acodec` — or, where it doesn't say (SoundCloud's
 * MP3 and Opus streams can leave it out), what the stream's file type means.
 */
export function codecOf({ acodec, ext }: { acodec?: string; ext?: string }): string | undefined {
  if (acodec && acodec !== "none") return acodec;
  return ext === "mp3" || ext === "opus" ? ext : undefined;
}

/**
 * The light metadata pass before a download: the title and artist (for the
 * file name and tags) and which audio stream the source (YouTube, or
 * SoundCloud) will give us. Audio that can't be downloaded fails here, before
 * any response or file is started. `videoUrl` is always a canonical link
 * (shared/soundcloud-link.ts: `audioLinkOf()`).
 */
export async function fetchAudioInfo(videoUrl: string): Promise<AudioInfo> {
  let info: {
    title?: string;
    uploader?: string;
    channel?: string;
    format_id?: string;
    acodec?: string;
    album?: string;
    release_year?: number;
    release_date?: string;
    ext?: string;
    thumbnail?: string;
    duration?: number;
  };
  try {
    info = (await youtubedl(videoUrl, {
      dumpSingleJson: true,
      skipDownload: true,
      format: AUDIO_FORMAT,
      ...YT_DLP_BASE_FLAGS,
    })) as typeof info;
  } catch (err) {
    throw new Error(ytDlpFailure(err), { cause: err });
  }
  const artwork = soundCloudArtworkUrl(info.thumbnail);
  return {
    title: info.title ?? "audio",
    artist: info.uploader ?? info.channel,
    // YouTube Music's uploads say which album the song is from, and when it came out.
    ...youtubeAlbumTags(info),
    formatId: info.format_id,
    acodec: codecOf(info),
    // SoundCloud's artwork, at the size its cover is made from (YouTube's
    // covers come from the video id instead: cover.ts).
    ...(artwork ? { artwork } : {}),
    ...(typeof info.duration === "number" && info.duration > 0 ? { duration: info.duration } : {}),
  };
}

/** The album and release date yt-dlp found for a video (YouTube Music uploads have them). */
export function youtubeAlbumTags(info: {
  album?: unknown;
  release_year?: unknown;
  release_date?: unknown;
}): Pick<AudioMetadata, "album" | "date"> {
  const tags: Pick<AudioMetadata, "album" | "date"> = {};
  if (typeof info.album === "string" && info.album.trim()) tags.album = info.album.trim();
  const date = typeof info.release_date === "string" ? info.release_date : "";
  if (/^\d{8}$/.test(date)) tags.date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
  else if (typeof info.release_year === "number" && info.release_year > 1000) {
    tags.date = String(info.release_year);
  }
  return tags;
}

export type AudioPipeline = {
  /** The finished audio file as ffmpeg writes it — pipe it to the response or a file. */
  audio: Readable;
  /** Kills both processes (a cancelled download). Safe to call at any time. */
  stop: () => void;
  /**
   * Settles once both processes have exited: `ok` when both succeeded; if not,
   * `reason` is the most useful error line (yt-dlp's, when it has one).
   */
  finished: Promise<{ ok: boolean; reason: string }>;
};

/**
 * Starts yt-dlp → ffmpeg for one video: yt-dlp fetches the audio stream the
 * metadata pass picked, and ffmpeg turns it into the file `ffmpegArgs` describe.
 * `spawnSource` stands in for yt-dlp in tests (a process that writes audio to
 * its stdout), so the pipeline's cancel paths are tested without the network.
 */
export function startAudioPipeline(
  videoUrl: string,
  formatId: string | undefined,
  ffmpegArgs: string[],
  prefix?: Buffer | Promise<Buffer>,
  { spawnSource = spawnYtDlpAudio }: { spawnSource?: typeof spawnYtDlpAudio } = {},
): AudioPipeline {
  // ffmpeg first: if it can't start (throws), no yt-dlp has been left running.
  const ffmpeg = spawnFfmpeg(ffmpegArgs);
  // What the caller reads: ffmpeg's output, with an MP3's tag in front of it.
  const audio = prefix ? withPrefix(ffmpeg.stdout, prefix) : ffmpeg.stdout;
  const ytdlp = spawnSource(videoUrl, formatId);
  const kill = () => {
    for (const p of [ytdlp, ffmpeg]) if (isRunning(p)) p.kill();
  };
  let draining = false;
  const stop = () => {
    kill();
    if (draining) return;
    draining = true;
    // Whoever was reading the audio may be gone — a cancelled download's
    // response unpipes it, which pauses it, as the response closes. Let it run
    // dry instead, even if something pauses it on the way out: an ffmpeg
    // blocked writing to a full pipe (or to a full prefix stream) never gets
    // to act on its signal (macOS, Linux), and a process whose output is
    // never read never "closes".
    const drain = () => process.nextTick(() => audio.resume());
    audio.on("pause", drain);
    drain();
  };

  const errors = { ytdlp: "", ffmpeg: "", spawn: "" };
  ytdlp.stderr.on("data", (chunk) => (errors.ytdlp = (errors.ytdlp + chunk).slice(-4000)));
  ffmpeg.stderr.on("data", (chunk) => (errors.ffmpeg = (errors.ffmpeg + chunk).slice(-4000)));
  ytdlp.on("error", (e) => {
    errors.spawn ||= `yt-dlp failed to start: ${e.message}`;
    stop();
  });
  ffmpeg.on("error", (e) => {
    errors.spawn ||= `ffmpeg failed to start: ${e.message}`;
    stop();
  });
  // If ffmpeg exits first, yt-dlp's remaining writes hit a closed pipe
  // (EPIPE). That's expected — but unhandled, the error would crash the server.
  ffmpeg.stdin.on("error", () => {});
  ytdlp.stdout.pipe(ffmpeg.stdin);

  // ffmpeg is done once its output has all been read ("close"). Whatever the
  // reason it ended, make sure yt-dlp isn't left running.
  const ffmpegCode = new Promise<number | null>((resolve) =>
    ffmpeg.once("close", (code) => resolve(code)),
  ).finally(kill);
  const finished = Promise.all([exitCode(ytdlp), ffmpegCode]).then(([ytdlpCode, ffCode]) => {
    const ok = ytdlpCode === 0 && ffCode === 0 && !errors.spawn;
    const reason = ok
      ? ""
      : errors.spawn ||
        ytDlpErrorLine(errors.ytdlp) ||
        lastLine(errors.ffmpeg) ||
        (ytdlpCode !== 0
          ? `yt-dlp exited with code ${ytdlpCode}`
          : `ffmpeg exited with code ${ffCode}`);
    return { ok, reason };
  });

  return { audio, stop, finished };
}

/**
 * The audio with `prefix` (an MP3's tag) in front of it, sent together with
 * the first chunk of audio: the routes treat the first data as the sign that
 * the download has really started, so nothing may come before it. A prefix
 * still on its way holds the first chunk until it's there (it never fails:
 * prepareAudioOutput()).
 */
export function withPrefix(audio: Readable, prefix: Buffer | Promise<Buffer>): Readable {
  let first = true;
  const out = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!first) return done(null, chunk);
      first = false;
      Promise.resolve(prefix).then(
        (tag) => done(null, Buffer.concat([tag, chunk])),
        () => done(null, chunk),
      );
    },
  });
  return audio.pipe(out);
}

const isRunning = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? "";

/**
 * The part of yt-dlp's error output worth showing someone: its last "ERROR:"
 * line, without the prefixes. "ERROR: [youtube] jNQXAC9IVRw: Video unavailable"
 * → "Video unavailable".
 */
export function ytDlpErrorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.filter((l) => l.startsWith("ERROR:")).pop() ?? lines.pop() ?? "";
  return line.replace(/^ERROR:\s*/, "").replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, "");
}

/** Why a youtube-dl-exec call failed, from yt-dlp's own error output when there is some. */
export function ytDlpFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  return (
    (typeof stderr === "string" && ytDlpErrorLine(stderr)) ||
    (err instanceof Error ? err.message : "yt-dlp failed")
  );
}

/**
 * A process's exit code (null if it was killed) once it has exited and its
 * output has been read. yt-dlp.exe on Windows does its work in a second
 * process of its own, which could hold the output open after we kill the
 * first — so after the exit, stop waiting for the output within a moment.
 */
function exitCode(p: ChildProcess, graceMs = 2_000): Promise<number | null> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      resolve(p.exitCode);
    };
    p.once("close", done);
    p.once("exit", () => {
      timer = setTimeout(done, graceMs);
    });
    // Never started at all (e.g. the binary is missing): there's no exit to wait for.
    p.once("error", () => {
      if (p.pid === undefined) done();
    });
  });
}
