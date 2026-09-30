/**
 * Turning a YouTube video into a downloadable audio stream.
 *
 *   yt-dlp  ──(best audio on stdout)──▶  ffmpeg  ──(file on stdout)──▶  HTTP response
 *
 * ffmpeg either converts to MP3 (the default) or, for "original", just
 * repackages YouTube's own stream into a proper audio file without re-encoding.
 * Nothing touches disk, and the browser's download starts with the first chunk.
 * Both binaries are fetched by `npm install` (youtube-dl-exec → yt-dlp,
 * ffmpeg-static → ffmpeg), so there's nothing to install system-wide.
 * Set FFMPEG_BIN to use a different ffmpeg.
 */
import { spawn } from "child_process";
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

export type AudioMetadata = { title: string; artist?: string };

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
// write our own title/artist.
function ffmpegInputAndTags({ title, artist }: AudioMetadata): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn"];
  args.push("-map_metadata", "-1", "-metadata", `title=${title}`);
  if (artist) args.push("-metadata", `artist=${artist}`);
  return args;
}

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
  return {
    ext,
    contentType,
    ffmpegArgs: [...ffmpegInputAndTags(meta), "-c:a", "copy", ...muxerArgs, "pipe:1"],
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
