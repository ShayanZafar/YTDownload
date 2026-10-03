import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { readDeviceCover } from "@/lib/device-music";
import {
  RESTART_AFTER_SECONDS,
  folderSongCoverUrl,
  folderSongFlacUrl,
  folderSongUrl,
  nextPosition,
  previousPosition,
  repeatModes,
  shuffledOrder,
  type PlayerTrack,
  type Repeat,
} from "@/lib/music";

/**
 * The music player: one <audio> element for the whole page, so music keeps
 * playing while you search and download. A song plays as it is — the
 * browser decodes the file itself, untouched. A song from the "Save to"
 * folder that this browser can't play (WMA, APE, …) is played converted to
 * FLAC by the app instead: lossless, so it sounds just like the file. A song
 * picked on this device plays straight from it.
 *
 * Playing starts inside the click that asked for it (phones only let a page
 * start sound when you tap), and the same element plays every song after, so
 * the next song can start on its own.
 */

export type PlayerStatus = "idle" | "loading" | "playing" | "paused";

type Queue = {
  tracks: PlayerTrack[];
  /** The tracks' places in play order: as listed, or shuffled. */
  order: number[];
  /** Where in `order` the current song is. */
  position: number;
};

export type Player = {
  current: PlayerTrack | null;
  status: PlayerStatus;
  /** The app is converting the song for this browser (it can't play the file itself). */
  converting: boolean;
  /** Why the current song couldn't play. */
  error: string | null;
  /** The current song's cover picture, if it has one (a folder song's may turn out empty). */
  cover: string | null;
  shuffle: boolean;
  repeat: Repeat;
  volume: number;
  muted: boolean;
  hasNext: boolean;
  /** Plays `tracks` from `index` on — shuffled, if shuffle is on (or `shuffle` says so). */
  play: (tracks: PlayerTrack[], index: number, options?: { shuffle?: boolean }) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  /** Newer details of songs in the queue (tags read since, say). */
  refresh: (tracks: readonly PlayerTrack[]) => void;
  close: () => void;
};

const PlayerContext = createContext<Player | null>(null);
// Kept apart: it changes several times a second while a song plays.
const TimeContext = createContext<{ time: number; duration: number | null }>({
  time: 0,
  duration: null,
});

const EMPTY: Queue = { tracks: [], order: [], position: 0 };
// After a song fails, wait this long before moving on, so the reason can be read.
const SKIP_AFTER_FAILURE_MS = 2000;

// Per-browser conveniences, remembered when storage allows.
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; it still applies now.
  }
}

/** Can this browser play this kind of file itself? (Unknown kinds are worth a try.) */
const canPlay = (audio: HTMLAudioElement, check: string) =>
  check === "" || audio.canPlayType(check) !== "";

/** Why a song couldn't be loaded, in the app's words if it gave any. */
async function reasonFor(src: string): Promise<string | undefined> {
  if (src.startsWith("blob:")) return undefined;
  try {
    const res = await fetch(src, { headers: { Range: "bytes=0-0" } });
    if (res.ok) return undefined;
    const body: unknown = await res.json();
    const message = (body as { message?: unknown } | null)?.message;
    return typeof message === "string" ? message : undefined;
  } catch {
    return undefined;
  }
}

/** "a .wma file", for "This browser can't play …". */
function kindOf(track: PlayerTrack): string {
  const ext = /\.([^.\\/]+)$/.exec(track.fileName)?.[1];
  return ext ? `.${ext.toLowerCase()} files` : "this file";
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [queue, setQueueState] = useState<Queue>(EMPTY);
  const [status, setStatus] = useState<PlayerStatus>("idle");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [cover, setCover] = useState<string | null>(null);
  const [shuffle, setShuffleState] = useState(() => stored("player-shuffle") === "on");
  const [repeat, setRepeatState] = useState<Repeat>(() => {
    const saved = stored("player-repeat");
    return (repeatModes as readonly string[]).includes(saved ?? "") ? (saved as Repeat) : "off";
  });
  const [volume, setVolumeState] = useState(() => {
    const saved = Number(stored("player-volume") ?? "1");
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 1;
  });
  const [muted, setMuted] = useState(false);

  // The latest values, for the audio element's events and the media keys.
  const latest = useRef({ queue, shuffle, repeat });
  // What's loaded: which song, from which address, and whether that's the
  // app's conversion. A device song's address is an object URL to let go of.
  const loaded = useRef<{ key: string; src: string; converted: boolean } | null>(null);
  const objectUrl = useRef<string | null>(null);
  const failuresInARow = useRef(0);
  const skipTimer = useRef<ReturnType<typeof setTimeout>>();

  const current = queue.tracks[queue.order[queue.position]] ?? null;

  const actions = useMemo(() => {
    const audio = () => audioRef.current;
    const setQueue = (next: Queue) => {
      latest.current = { ...latest.current, queue: next };
      setQueueState(next);
    };
    const currentTrack = () => {
      const { tracks, order, position } = latest.current.queue;
      return tracks[order[position]] as PlayerTrack | undefined;
    };
    const letGoOfObjectUrl = () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
    const onPlayRefused = (err: unknown) => {
      // Not allowed to start by itself (a phone, say): it waits for Play.
      if (err instanceof DOMException && err.name === "NotAllowedError") setStatus("paused");
    };

    /** Loads a song into the audio element (and starts it, unless `autoplay` is false). */
    const load = (
      track: PlayerTrack,
      { autoplay = true, convert = false }: { autoplay?: boolean; convert?: boolean } = {},
    ) => {
      const element = audio();
      if (!element) return;
      clearTimeout(skipTimer.current);
      letGoOfObjectUrl();
      let src: string;
      let converted = false;
      if (track.source === "device") {
        src = URL.createObjectURL(track.file);
        objectUrl.current = src;
      } else {
        converted = convert || !canPlay(element, track.check);
        src = converted ? folderSongFlacUrl(track.id) : folderSongUrl(track.id);
      }
      loaded.current = { key: track.key, src, converted };
      setError(null);
      setTime(0);
      setDuration(track.duration);
      setConverting(converted);
      setStatus(autoplay ? "loading" : "paused");
      element.src = src;
      if (autoplay) element.play().catch(onPlayRefused);
    };

    const goTo = (position: number) => {
      const { queue: q } = latest.current;
      const track = q.tracks[q.order[position]];
      if (!track) return;
      setQueue({ ...q, position });
      load(track);
    };

    const next = () => {
      const { queue: q, repeat: r } = latest.current;
      const position = nextPosition(q.position, q.order.length, r, { skip: true });
      if (position !== null) goTo(position);
    };

    const previous = () => {
      const element = audio();
      const { queue: q, repeat: r } = latest.current;
      if (element && element.currentTime > RESTART_AFTER_SECONDS && loaded.current) {
        element.currentTime = 0;
        return;
      }
      goTo(previousPosition(q.position, q.order.length, r));
    };

    /** The song ended by itself: the next one, the same one again, or stop. */
    const ended = () => {
      const element = audio();
      const { queue: q, repeat: r } = latest.current;
      const position = nextPosition(q.position, q.order.length, r);
      if (position === null) {
        setStatus("paused");
      } else if (position === q.position && element) {
        element.currentTime = 0;
        element.play().catch(onPlayRefused);
      } else {
        goTo(position);
      }
    };

    /** The song couldn't be played: try the app's conversion, or say why and move on. */
    const failed = () => {
      const element = audio();
      const track = currentTrack();
      const attempt = loaded.current;
      if (!element?.error || element.error.code === MediaError.MEDIA_ERR_ABORTED) return;
      if (!track || !attempt || attempt.key !== track.key) return;
      if (track.source === "folder" && !attempt.converted) {
        load(track, { convert: true });
        return;
      }
      setStatus("paused");
      setConverting(false);
      setError(
        track.source === "device"
          ? `This browser can't play ${kindOf(track)}.`
          : "Couldn't play this song.",
      );
      void reasonFor(attempt.src).then((reason) => {
        if (reason && loaded.current === attempt) setError(reason);
      });
      // On to the next song — unless every song has failed.
      failuresInARow.current += 1;
      const { queue: q, repeat: r } = latest.current;
      if (failuresInARow.current >= q.order.length) return;
      const position = nextPosition(q.position, q.order.length, r === "one" ? "all" : r, {
        skip: true,
      });
      if (position === null) return;
      skipTimer.current = setTimeout(() => {
        if (loaded.current === attempt) goTo(position);
      }, SKIP_AFTER_FAILURE_MS);
    };

    const close = () => {
      clearTimeout(skipTimer.current);
      const element = audio();
      if (element) {
        element.pause();
        element.removeAttribute("src");
        element.load(); // lets go of the file
      }
      letGoOfObjectUrl();
      loaded.current = null;
      failuresInARow.current = 0;
      setQueue(EMPTY);
      setStatus("idle");
      setError(null);
      setConverting(false);
      setTime(0);
      setDuration(null);
    };

    return {
      play: (tracks: PlayerTrack[], index: number, options: { shuffle?: boolean } = {}) => {
        if (!tracks[index]) return;
        const shuffled = options.shuffle ?? latest.current.shuffle;
        if (options.shuffle !== undefined && options.shuffle !== latest.current.shuffle) {
          latest.current = { ...latest.current, shuffle: shuffled };
          setShuffleState(shuffled);
          store("player-shuffle", shuffled ? "on" : "off");
        }
        failuresInARow.current = 0;
        setQueue({
          tracks,
          order: shuffled ? shuffledOrder(tracks.length, index) : tracks.map((_, i) => i),
          position: shuffled ? 0 : index,
        });
        load(tracks[index]);
      },
      toggle: () => {
        const element = audio();
        const track = currentTrack();
        if (!element || !track) return;
        if (!element.paused) return element.pause();
        // Failed, or let go of: load it again.
        if (!loaded.current || loaded.current.key !== track.key || element.error) {
          failuresInARow.current = 0;
          return load(track);
        }
        element.play().catch(onPlayRefused);
      },
      next,
      previous,
      seek: (seconds: number) => {
        const element = audio();
        if (!element || !Number.isFinite(seconds)) return;
        const end = Number.isFinite(element.duration) ? element.duration : seconds;
        element.currentTime = Math.max(0, Math.min(seconds, end));
        setTime(element.currentTime);
      },
      setVolume: (value: number) => {
        const element = audio();
        if (!element) return;
        element.volume = Math.max(0, Math.min(1, value));
        if (value > 0) element.muted = false;
      },
      toggleMute: () => {
        const element = audio();
        if (element) element.muted = !element.muted;
      },
      toggleShuffle: () => {
        const { queue: q, shuffle: on } = latest.current;
        const playing = q.order[q.position] ?? 0;
        latest.current = { ...latest.current, shuffle: !on };
        setShuffleState(!on);
        store("player-shuffle", on ? "off" : "on");
        if (q.tracks.length === 0) return;
        // The song playing stays; the rest are shuffled, or back in their order.
        setQueue(
          on
            ? { ...q, order: q.tracks.map((_, i) => i), position: playing }
            : { ...q, order: shuffledOrder(q.tracks.length, playing), position: 0 },
        );
      },
      cycleRepeat: () => {
        const { repeat: r } = latest.current;
        const nextMode = repeatModes[(repeatModes.indexOf(r) + 1) % repeatModes.length];
        latest.current = { ...latest.current, repeat: nextMode };
        setRepeatState(nextMode);
        store("player-repeat", nextMode);
      },
      refresh: (tracks: readonly PlayerTrack[]) => {
        const { queue: q } = latest.current;
        if (q.tracks.length === 0) return;
        const byKey = new Map(tracks.map((track) => [track.key, track]));
        let changed = false;
        const updated = q.tracks.map((track) => {
          const newer = byKey.get(track.key);
          if (!newer || newer === track) return track;
          changed = true;
          return newer;
        });
        if (changed) setQueue({ ...q, tracks: updated });
      },
      close,
      // For the audio element's events (below).
      ended,
      failed,
    };
  }, []);

  // The audio element's events.
  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;
    element.volume = volume;
    const handlers: Record<string, () => void> = {
      playing: () => {
        failuresInARow.current = 0;
        setStatus("playing");
        setConverting(false);
      },
      // Changing songs pauses the old one; that's not a pause to show.
      pause: () => {
        if (element.paused && !element.ended) setStatus("paused");
      },
      waiting: () => setStatus("loading"),
      timeupdate: () => setTime(element.currentTime),
      durationchange: () => {
        if (Number.isFinite(element.duration)) setDuration(element.duration);
      },
      ended: actions.ended,
      error: actions.failed,
      volumechange: () => {
        setVolumeState(element.volume);
        setMuted(element.muted);
        store("player-volume", String(element.volume));
      },
    };
    Object.entries(handlers).forEach(([type, handler]) => element.addEventListener(type, handler));
    return () =>
      Object.entries(handlers).forEach(([type, handler]) =>
        element.removeEventListener(type, handler),
      );
    // The volume only matters when the element is first set up.
  }, [actions]);

  // Let go of the song's file when the page goes away.
  useEffect(() => () => actions.close(), [actions]);

  // The current song's cover picture.
  const currentKey = current?.key;
  useEffect(() => {
    if (!current) return setCover(null);
    if (current.source === "folder") return setCover(folderSongCoverUrl(current.id));
    setCover(null);
    let url: string | undefined;
    let cancelled = false;
    void readDeviceCover(current.file).then((blob) => {
      if (cancelled || !blob) return;
      url = URL.createObjectURL(blob);
      setCover(url);
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
    // Only a different song has a different cover.
  }, [currentKey]);

  // The system's media controls: media keys, the lock screen, Windows' media overlay.
  const session = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
  useEffect(() => {
    if (!session) return;
    const element = () => audioRef.current;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      // Play only ever starts (toggling would pause a song that's playing).
      ["play", () => element()?.paused && actions.toggle()],
      ["pause", () => element()?.pause()],
      ["previoustrack", actions.previous],
      ["nexttrack", actions.next],
      ["seekto", (details) => details.seekTime !== undefined && actions.seek(details.seekTime)],
      ["seekbackward", (d) => actions.seek((element()?.currentTime ?? 0) - (d.seekOffset ?? 10))],
      ["seekforward", (d) => actions.seek((element()?.currentTime ?? 0) + (d.seekOffset ?? 10))],
      ["stop", actions.close],
    ];
    // Browsers that don't know an action say so by throwing.
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Not supported here.
      }
    };
    handlers.forEach(([action, handler]) => set(action, handler));
    return () => handlers.forEach(([action]) => set(action, null));
  }, [session, actions]);

  useEffect(() => {
    if (!session) return;
    try {
      session.metadata = current
        ? new MediaMetadata({
            title: current.title,
            artist: current.artist ?? "",
            album: current.album ?? "",
            artwork: cover ? [{ src: cover }] : [],
          })
        : null;
    } catch {
      // No metadata here: the song still plays.
    }
  }, [session, current, cover]);

  useEffect(() => {
    if (!session) return;
    session.playbackState = !current ? "none" : status === "playing" ? "playing" : "paused";
  }, [session, current, status]);

  const second = Math.floor(time);
  useEffect(() => {
    if (!session?.setPositionState || duration === null || !current) return;
    try {
      session.setPositionState({ duration, position: Math.min(second, duration), playbackRate: 1 });
    } catch {
      // A length the system won't take: no progress bar there.
    }
  }, [session, current, second, duration]);

  const player: Player = useMemo(
    () => ({
      current,
      status,
      converting,
      error,
      cover,
      shuffle,
      repeat,
      volume,
      muted,
      hasNext: nextPosition(queue.position, queue.order.length, repeat, { skip: true }) !== null,
      play: actions.play,
      toggle: actions.toggle,
      next: actions.next,
      previous: actions.previous,
      seek: actions.seek,
      setVolume: actions.setVolume,
      toggleMute: actions.toggleMute,
      toggleShuffle: actions.toggleShuffle,
      cycleRepeat: actions.cycleRepeat,
      refresh: actions.refresh,
      close: actions.close,
    }),
    [current, status, converting, error, cover, shuffle, repeat, volume, muted, queue, actions],
  );
  const timeValue = useMemo(() => ({ time, duration }), [time, duration]);

  return (
    <PlayerContext.Provider value={player}>
      <TimeContext.Provider value={timeValue}>
        {children}
        <audio ref={audioRef} preload="auto" data-testid="music-player-audio" />
      </TimeContext.Provider>
    </PlayerContext.Provider>
  );
}

export function usePlayer(): Player {
  const player = useContext(PlayerContext);
  if (!player) throw new Error("usePlayer needs a PlayerProvider around it");
  return player;
}

/** Where the current song is, and how long it is. */
export const usePlayerTime = () => useContext(TimeContext);
