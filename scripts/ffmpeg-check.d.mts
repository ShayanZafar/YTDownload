// Types for scripts/ffmpeg-check.mjs (plain JavaScript, so it runs straight after npm install).
export const FFMPEG_SHA256: Record<string, Record<string, string>>;
export function sha256Of(file: string): Promise<string>;
export function expectedFfmpegHash(
  release: string,
  platform: string,
  arch: string,
): string | undefined;
export function checkFfmpeg(
  binary: string,
  release: string,
  platform: string,
  arch: string,
): Promise<"ok" | "unchecked" | "deleted">;
