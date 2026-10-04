import { useCallback, useEffect, useRef, useState } from "react";
import { readDeviceTags, type DeviceTags } from "@/lib/device-music";
import { deviceTrack, isAudioFile, type PlayerTrack } from "@/lib/music";

/** Songs whose tags are read at the same time. */
const READ_AT_ONCE = 4;
/** How often the list takes in the tags read so far, while many are being read. */
const SHOW_TAGS_EVERY_MS = 250;

/**
 * Songs picked on this device for the player, for this visit (a page can't
 * keep files it was given). They stay on the device: their tags are read
 * here, and they play from here. Picking more adds to them.
 */
export function useDeviceMusic() {
  const [tracks, setTracks] = useState<PlayerTrack[]>([]);
  const [reading, setReading] = useState(0);
  const keys = useRef(new Set<string>());
  const pending = useRef(new Map<string, DeviceTags>());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);

  // Tags read so far go into the list together, not one re-render per song.
  const flush = useCallback(() => {
    flushTimer.current = undefined;
    const found = pending.current;
    if (found.size === 0) return;
    pending.current = new Map();
    setTracks((current) =>
      current.map((track) => {
        const tags = found.get(track.key);
        if (!tags || track.source !== "device") return track;
        return { ...track, ...tags, title: tags.title ?? track.title, tagsRead: true };
      }),
    );
  }, []);

  useEffect(() => () => clearTimeout(flushTimer.current), []);

  /** Adds the songs among `files` (other files are left out). Returns how many were new. */
  const add = useCallback(
    (files: Iterable<File> | ArrayLike<File>) => {
      const fresh = Array.from(files)
        .filter(isAudioFile)
        .map(deviceTrack)
        .filter((track) => {
          if (keys.current.has(track.key)) return false;
          keys.current.add(track.key);
          return true;
        });
      if (fresh.length === 0) return 0;
      setTracks((current) => [...current, ...fresh]);

      const run = generation.current;
      setReading((n) => n + fresh.length);
      let next = 0;
      const worker = async () => {
        while (next < fresh.length) {
          const track = fresh[next++];
          if (track.source !== "device") continue;
          const tags = await readDeviceTags(track.file);
          if (run !== generation.current) return; // cleared meanwhile
          pending.current.set(track.key, tags);
          setReading((n) => Math.max(0, n - 1));
          flushTimer.current ??= setTimeout(flush, SHOW_TAGS_EVERY_MS);
        }
      };
      Array.from({ length: Math.min(READ_AT_ONCE, fresh.length) }, worker);
      return fresh.length;
    },
    [flush],
  );

  const clear = useCallback(() => {
    generation.current += 1;
    keys.current = new Set();
    pending.current = new Map();
    clearTimeout(flushTimer.current);
    flushTimer.current = undefined;
    setTracks([]);
    setReading(0);
  }, []);

  return { tracks, add, clear, reading };
}
