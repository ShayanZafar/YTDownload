/**
 * Songs picked on this device (a phone, or any browser that isn't on the
 * computer running the app): their tags and cover pictures are read right
 * here in the browser, and they play straight from the device. Nothing is
 * sent anywhere. The tag reader (music-metadata) is only loaded once songs
 * are picked.
 */
import type { IAudioMetadata, IOptions } from "music-metadata";
import type { PlayerTrack } from "@/lib/music";

type Reader = {
  parseBlob: (blob: Blob, options?: IOptions) => Promise<IAudioMetadata>;
  selectCover: (pictures?: IAudioMetadata["common"]["picture"]) => {
    data: Uint8Array;
    format: string;
  } | null;
};

let reader: Promise<Reader> | undefined;
const loadReader = (): Promise<Reader> => (reader ??= import("music-metadata"));

export type DeviceTags = Pick<PlayerTrack, "artist" | "album" | "duration"> & { title?: string };

/** A picked song's tags. A file with none (or that can't be read) just keeps its file name. */
export async function readDeviceTags(file: File): Promise<DeviceTags> {
  try {
    const { parseBlob } = await loadReader();
    const { common, format } = await parseBlob(file, { duration: false, skipCovers: true });
    const artist = common.artists?.length ? common.artists.join(", ") : common.artist;
    const duration = format.duration;
    return {
      title: common.title?.trim() || undefined,
      artist: artist?.trim() || common.albumartist?.trim() || null,
      album: common.album?.trim() || null,
      duration:
        duration !== undefined && Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  } catch {
    return { artist: null, album: null, duration: null };
  }
}

// Only pictures are shown as pictures (a damaged file could claim anything).
const PICTURE_TYPE = /^image\/(jpeg|png|gif|webp|bmp)$/;

/** A picked song's cover picture, or undefined if it has none. */
export async function readDeviceCover(file: File): Promise<Blob | undefined> {
  try {
    const { parseBlob, selectCover } = await loadReader();
    const { common } = await parseBlob(file, { duration: false, skipCovers: false });
    const cover = selectCover(common.picture);
    if (!cover) return undefined;
    const type = cover.format.toLowerCase() === "image/jpg" ? "image/jpeg" : cover.format;
    // A copy: the picture's bytes may sit in a view of a bigger buffer, which a Blob won't take.
    return PICTURE_TYPE.test(type) ? new Blob([new Uint8Array(cover.data)], { type }) : undefined;
  } catch {
    return undefined;
  }
}
