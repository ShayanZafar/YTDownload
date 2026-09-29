/**
 * Turning a YouTube video into an MP3 stream.
 *
 *   yt-dlp  ──(WebM/Opus on stdout)──▶  ffmpeg  ──(MP3 on stdout)──▶  HTTP response
 *
 * Nothing touches disk, and the browser's download starts as soon as ffmpeg has
 * encoded the first frames. Both binaries are fetched by `npm install`
 * (youtube-dl-exec → yt-dlp, ffmpeg-static → ffmpeg), so there's nothing to
 * install system-wide. Set FFMPEG_BIN to use a different ffmpeg.
 */
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import youtubedl from "youtube-dl-exec";

// Flags shared by every yt-dlp call.
// `jsRuntimes: "node"` — since late 2025 yt-dlp needs a JavaScript runtime to
// solve YouTube's player challenges, and only Deno is enabled by default.
// Node is always present (it's running this server), so let yt-dlp use it.
export const YT_DLP_BASE_FLAGS = {
  noWarnings: true,
  noPlaylist: true,
  jsRuntimes: "node",
} as const;

// Prefer WebM/Opus: Matroska streams cleanly through a pipe. M4A is the fallback.
export const AUDIO_FORMAT = "bestaudio[ext=webm]/bestaudio";

// Constant bitrate on purpose: the MP3 is streamed while it's encoded, so ffmpeg
// can't go back and write the seek header a VBR file needs — without it, players
// show the wrong duration. With CBR, duration is simply size ÷ bitrate.
export const MP3_BITRATE = "192k";

// youtube-dl-exec's typings leave these out, but the module does export them.
const ytDlpModule = youtubedl as unknown as {
  constants: { YOUTUBE_DL_PATH: string };
  args: (flags: Record<string, unknown>) => string[];
};

export const YT_DLP_PATH = ytDlpModule.constants.YOUTUBE_DL_PATH;
export const FFMPEG_PATH = ffmpegStatic; // null only on platforms ffmpeg-static doesn't cover

export type Mp3Metadata = { title: string; artist?: string };

/** yt-dlp arguments that write the video's best audio stream to stdout. */
export function ytDlpAudioArgs(videoUrl: string): string[] {
  return [
    videoUrl,
    ...ytDlpModule.args({ format: AUDIO_FORMAT, output: "-", quiet: true, ...YT_DLP_BASE_FLAGS }),
  ];
}

/** ffmpeg arguments that read any audio on stdin and write a tagged MP3 to stdout. */
export function ffmpegMp3Args({ title, artist }: Mp3Metadata): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn"];
  // Drop whatever tags the source container carried and write our own.
  args.push("-map_metadata", "-1", "-metadata", `title=${title}`);
  if (artist) args.push("-metadata", `artist=${artist}`);
  // ID3v2.3 rather than ffmpeg's default v2.4: Windows Explorer and many car/phone
  // players only read v2.3 tags.
  args.push("-c:a", "libmp3lame", "-b:a", MP3_BITRATE, "-id3v2_version", "3");
  args.push("-f", "mp3", "pipe:1");
  return args;
}

export function spawnYtDlpAudio(videoUrl: string) {
  return spawn(YT_DLP_PATH, ytDlpAudioArgs(videoUrl), { windowsHide: true });
}

export function spawnFfmpegMp3(meta: Mp3Metadata) {
  if (!FFMPEG_PATH) {
    throw new Error("No bundled ffmpeg for this platform. Set FFMPEG_BIN to an ffmpeg binary.");
  }
  return spawn(FFMPEG_PATH, ffmpegMp3Args(meta), { windowsHide: true });
}
