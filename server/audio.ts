/**
 * Turning a YouTube video into a downloadable audio stream.
 *
 *   yt-dlp  ──(best audio on stdout)──▶  ffmpeg  ──(file on stdout)──▶  HTTP response
 *                                                                   or a file in the "Save to" folder
 *
 * ffmpeg either converts to MP3 (the default) or, for "original", just
 * repackages YouTube's own stream into a proper audio file without re-encoding.
 * No temporary files: the browser's download starts with the first chunk (or,
 * with a "Save to" folder, the file is written as the audio arrives).
 * Both binaries are fetched by `npm install` (youtube-dl-exec → yt-dlp,
 * ffmpeg-static → ffmpeg), so there's nothing to install system-wide.
 * Set FFMPEG_BIN to use a different ffmpeg.
 */
import { spawn, type ChildProcess } from "child_process";
import type { Readable } from "stream";
import ffmpegStatic from "ffmpeg-static";
import youtubedl from "youtube-dl-exec";
import type { DownloadFormat } from "@shared/routes";

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

export type AudioMetadata = {
  title: string;
  artist?: string;
  /**
   * The Spotify song this is, written into the file's tags so the playlist
   * panel recognises the file in the "Save to" folder, even after a rename.
   */
  spotifyId?: string;
};

/** What a download produces: the file extension, its MIME type, and the ffmpeg arguments. */
export type AudioOutput = { ext: string; contentType: string; ffmpegArgs: string[] };

type Container = { ext: string; contentType: string; muxerArgs: string[] };

/** yt-dlp arguments that write the chosen audio stream to stdout. */
export function ytDlpAudioArgs(videoUrl: string, format: string = AUDIO_FORMAT): string[] {
  return [
    videoUrl,
    ...ytDlpModule.args({ format, output: "-", quiet: true, ...YT_DLP_BASE_FLAGS }),
  ];
}

// Read audio on stdin, drop whatever tags the source container carried, and
// write our own title/artist (and the Spotify song, if it's one: an ID3
// "TXXX:spotify_id" frame, or a SPOTIFY_ID comment in Ogg and Matroska).
function ffmpegInputAndTags({ title, artist, spotifyId }: AudioMetadata): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn"];
  args.push("-map_metadata", "-1", "-metadata", `title=${title}`);
  if (artist) args.push("-metadata", `artist=${artist}`);
  if (spotifyId) args.push("-metadata", `spotify_id=${spotifyId}`);
  return args;
}

/** The Spotify song's link, the way it's written into a file's comment. */
export const spotifySongLink = (id: string) => `https://open.spotify.com/track/${id}`;

/** ffmpeg arguments that convert any audio on stdin to a tagged 320 kbps MP3 on stdout. */
export function ffmpegMp3Args(meta: AudioMetadata): string[] {
  return [
    ...ffmpegInputAndTags(meta),
    ...["-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-compression_level", LAME_QUALITY],
    // ID3v2.3 rather than ffmpeg's default v2.4: Windows Explorer and many
    // car/phone players only read v2.3 tags.
    ...["-id3v2_version", "3"],
    ...["-f", "mp3", "pipe:1"],
  ];
}

/**
 * Where to put YouTube's original stream so it's a normal, tagged audio file.
 * The audio itself is copied bit-for-bit (`-c:a copy`); only the container changes.
 */
export function originalContainer(acodec: string | undefined): Container {
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
  // Anything else YouTube might serve: Matroska audio holds any codec.
  return { ext: "mka", contentType: "audio/x-matroska", muxerArgs: ["-f", "matroska"] };
}

/** The file a download produces, for the requested format and the stream YouTube picked. */
export function audioOutput(
  format: DownloadFormat,
  meta: AudioMetadata,
  sourceAcodec?: string,
): AudioOutput {
  if (format === "mp3") {
    return { ext: "mp3", contentType: "audio/mpeg", ffmpegArgs: ffmpegMp3Args(meta) };
  }
  const { ext, contentType, muxerArgs } = originalContainer(sourceAcodec);
  // An .m4a can't hold a tag of our own, so the Spotify song goes in its comment.
  const songComment =
    ext === "m4a" && meta.spotifyId
      ? ["-metadata", `comment=${spotifySongLink(meta.spotifyId)}`]
      : [];
  return {
    ext,
    contentType,
    ffmpegArgs: [
      ...ffmpegInputAndTags(meta),
      ...songComment,
      "-c:a",
      "copy",
      ...muxerArgs,
      "pipe:1",
    ],
  };
}

export function spawnYtDlpAudio(videoUrl: string, format?: string) {
  return spawn(YT_DLP_PATH, ytDlpAudioArgs(videoUrl, format), { windowsHide: true });
}

export function spawnFfmpeg(args: string[]) {
  if (!FFMPEG_PATH) {
    throw new Error("No bundled ffmpeg for this platform. Set FFMPEG_BIN to an ffmpeg binary.");
  }
  return spawn(FFMPEG_PATH, args, { windowsHide: true });
}

/** What the metadata pass found out about a video's audio. */
export type AudioInfo = AudioMetadata & {
  /** The audio stream yt-dlp picked; the download is pinned to it. */
  formatId?: string;
  /** Its codec ("opus", "mp4a.40.2"…), which decides the "original" file type. */
  acodec?: string;
};

/**
 * The light metadata pass before a download: the title and artist (for the
 * file name and tags) and which audio stream YouTube will give us. A video
 * that can't be downloaded fails here, before any response or file is started.
 */
export async function fetchAudioInfo(videoUrl: string): Promise<AudioInfo> {
  let info: {
    title?: string;
    uploader?: string;
    channel?: string;
    format_id?: string;
    acodec?: string;
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
  return {
    title: info.title ?? "audio",
    artist: info.uploader ?? info.channel,
    formatId: info.format_id,
    acodec: info.acodec,
  };
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
 */
export function startAudioPipeline(
  videoUrl: string,
  formatId: string | undefined,
  ffmpegArgs: string[],
): AudioPipeline {
  // ffmpeg first: if it can't start (throws), no yt-dlp has been left running.
  const ffmpeg = spawnFfmpeg(ffmpegArgs);
  const ytdlp = spawnYtDlpAudio(videoUrl, formatId);
  const stop = () => {
    for (const p of [ytdlp, ffmpeg]) if (isRunning(p)) p.kill();
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
  ).finally(stop);
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

  return { audio: ffmpeg.stdout, stop, finished };
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
