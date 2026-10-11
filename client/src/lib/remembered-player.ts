/**
 * What the music player remembers between visits, so it can carry on where
 * it left off: the queue (the "Save to" folder's songs only — songs picked
 * on a device are gone once the page is) and where the current song was.
 * This browser keeps it (localStorage); nothing is sent anywhere.
 */
import { z } from "zod";
import { musicIdSchema, musicTrackSchema } from "@shared/schema";
import { folderTrack, type PlayerTrack, type Queue } from "@/lib/music";

/** The most songs remembered (a whole folder can be queued). */
export const MAX_REMEMBERED_SONGS = 1000;
/** Of those, how many already played (so Previous still goes back a little). */
const KEEP_PLAYED = 50;

const rememberedTrackSchema = musicTrackSchema.omit({ size: true }).extend({ id: musicIdSchema });
type RememberedTrack = z.infer<typeof rememberedTrackSchema>;

const rememberedQueueSchema = z.object({
  tracks: z.array(rememberedTrackSchema).min(1).max(MAX_REMEMBERED_SONGS),
  order: z.array(z.number().int().nonnegative()),
  position: z.number().int().nonnegative(),
});

const resumeSchema = z.object({ key: z.string(), time: z.number().nonnegative() });

/**
 * The part of the queue worth remembering: its folder songs, in the same
 * order, at most `MAX_REMEMBERED_SONGS` of them around the current one.
 * Null when there's nothing to remember (no song, or a song picked on a device).
 */
export function queueToRemember(queue: Queue): Queue | null {
  const inPlayOrder = queue.order
    .map((index, position) => ({ index, position }))
    .filter(({ index }) => queue.tracks[index]?.source === "folder");
  const at = inPlayOrder.findIndex(({ position }) => position === queue.position);
  if (at === -1) return null;
  const start = Math.max(0, Math.min(at - KEEP_PLAYED, inPlayOrder.length - MAX_REMEMBERED_SONGS));
  const kept = inPlayOrder.slice(start, start + MAX_REMEMBERED_SONGS);
  // The songs stay in their listed order, so turning shuffle off still works.
  const indexes = kept.map(({ index }) => index).sort((a, b) => a - b);
  const newIndex = new Map(indexes.map((index, i) => [index, i]));
  return {
    tracks: indexes.map((index) => queue.tracks[index]),
    order: kept.map(({ index }) => newIndex.get(index)!),
    position: at - start,
  };
}

const toRemembered = (track: PlayerTrack): RememberedTrack | null =>
  track.source === "folder"
    ? {
        id: track.id,
        path: track.fileName,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
        addedAt: new Date(track.addedAt).toISOString(),
      }
    : null;

/** The queue as text to store, or null if there's nothing to remember. */
export function rememberedQueueText(queue: Queue): string | null {
  const kept = queueToRemember(queue);
  if (!kept) return null;
  return JSON.stringify({
    tracks: kept.tracks.map(toRemembered),
    order: kept.order,
    position: kept.position,
  });
}

/** The stored queue, read back; null unless it's all there and makes sense. */
export function parseRememberedQueue(stored: string | null): Queue | null {
  if (!stored) return null;
  let data: unknown;
  try {
    data = JSON.parse(stored);
  } catch {
    return null;
  }
  const parsed = rememberedQueueSchema.safeParse(data);
  if (!parsed.success) return null;
  const { tracks, order, position } = parsed.data;
  // Every song once, in some order, and a current one.
  const isOrder =
    order.length === tracks.length &&
    new Set(order).size === order.length &&
    order.every((index) => index < tracks.length);
  if (!isOrder || position >= order.length) return null;
  return { tracks: tracks.map((track) => folderTrack({ ...track, size: 0 })), order, position };
}

/** Where the song with this key was, as text to store. */
export const resumeText = (key: string, time: number) =>
  JSON.stringify({ key, time: Math.max(0, Math.round(time * 10) / 10) });

/**
 * Where to carry on in `track`, from what was stored: 0 unless it's about this
 * song, and 0 again if the song had (nearly) finished.
 */
export function resumeTimeFor(stored: string | null, track: PlayerTrack): number {
  if (!stored) return 0;
  let data: unknown;
  try {
    data = JSON.parse(stored);
  } catch {
    return 0;
  }
  const parsed = resumeSchema.safeParse(data);
  if (!parsed.success || parsed.data.key !== track.key) return 0;
  const { time } = parsed.data;
  if (track.duration !== null && time >= track.duration - 1) return 0;
  return time;
}
