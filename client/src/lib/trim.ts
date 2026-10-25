/**
 * Trimming a song in the "Save to" folder: asking the app for its waveform,
 * cutting a part out (dead air, say), and Undo — plus the times shown and
 * typed in the trim window, and where its preview skips the cut.
 */
import { api, buildUrl } from "@shared/routes";
import { audioTypeOf, extensionOf } from "@shared/audio-types";
import { trimmedSongSchema, waveformSchema, type TimeRange } from "@shared/schema";
import { requestJson } from "@/lib/save-to-folder";

/** Can the app trim this song? Any it plays, but .ape (ffmpeg can't write those). */
export const canTrimFile = (fileName: string) =>
  audioTypeOf(fileName) !== undefined && extensionOf(fileName) !== ".ape";

/** The song's waveform and quiet stretches. */
export function fetchWaveform(id: string, signal?: AbortSignal) {
  return requestJson(waveformSchema, buildUrl(api.music.waveform.path, { id }), { signal });
}

/** Cuts `cut` out of the song; answers with what Undo needs. */
export function trimSong(id: string, cut: TimeRange) {
  return requestJson(trimmedSongSchema, buildUrl(api.music.trim.path, { id }), {
    method: api.music.trim.method,
    json: cut,
  });
}

/** Puts a trimmed song's original back. */
export function undoTrim(undo: string) {
  return requestJson(api.music.undoTrim.responses[200], api.music.undoTrim.path, {
    method: api.music.undoTrim.method,
    json: { undo },
  });
}

/** Seconds with tenths, as a clock: 83.45 → "1:23.5", 3723 → "1:02:03.0". */
export function formatCutTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  const h = Math.floor(tenths / 36_000);
  const m = Math.floor((tenths % 36_000) / 600);
  const s = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A typed time in seconds — "83.5", "1:23.5" or "1:02:03" — or undefined if it isn't one. */
export function parseCutTime(text: string): number | undefined {
  const parts = text.trim().replace(",", ".").split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d*)?$/.test(part))) return undefined;
  if (parts.slice(0, -1).some((part) => part.includes("."))) return undefined;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

/** The shortest part the trim window lets you cut (seconds). */
export const MIN_CUT = 0.1;

/**
 * The cut moved so it stays inside the song, with its start before its end:
 * moving one handle past the other pushes that one along.
 */
export function clampCut(cut: TimeRange, duration: number, moved: "start" | "end"): TimeRange {
  const start = Math.min(Math.max(0, cut.start), Math.max(0, duration - MIN_CUT));
  const end = Math.max(Math.min(duration, cut.end), Math.min(duration, MIN_CUT));
  if (end - start >= MIN_CUT) return { start, end };
  return moved === "start"
    ? { start, end: Math.min(duration, start + MIN_CUT) }
    : { start: Math.max(0, end - MIN_CUT), end };
}

/** Where the preview goes from `time`: past the cut, if it's in it (so you hear the song as it'll be). */
export function skipCut(time: number, cut: TimeRange): number | undefined {
  return time >= cut.start && time < cut.end - 0.01 ? cut.end : undefined;
}

/** How long the song will be without the cut. */
export const lengthWithout = (cut: TimeRange, duration: number) =>
  Math.max(0, duration - (Math.min(cut.end, duration) - Math.max(0, cut.start)));
