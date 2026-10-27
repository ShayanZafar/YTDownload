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
import { formatDuration } from "@/lib/format";
import {
  EMPTY_QUEUE,
  RESTART_AFTER_SECONDS,
  currentOf,
  folderSongCoverUrl,
  folderSongFlacUrl,
  folderSongUrl,
  nextPosition,
  previousPosition,
  queueUntilCurrent,
  queueWith,
  queueWithout,
  queueWithoutSong,
  repeatModes,
  seekRanOffTheEnd,
  afterSeek,
  shuffledOrder,
  upNext,
  type PlayerTrack,
  type Queue,
  type Repeat,
} from "@/lib/music";
import {
  parseRememberedQueue,
  rememberedQueueText,
  resumeText,
  resumeTimeFor,
} from "@/lib/remembered-player";

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
 *
 * It remembers the queue of folder songs and where the song was, so the next
 * visit carries on from there (paused: it starts again when you press Play).
 */

export type PlayerStatus = "idle" | "loading" | "playing" | "paused";

export type Player = {
  current: PlayerTrack | null;
  status: PlayerStatus;
  /** The app is converting the song for this browser (it can't play the file itself). */
  converting: boolean;
  /** Why the current song couldn't play. */
  error: string | null;
  /** Something to know about the current song that doesn't stop it playing (its file stops early, say). */
  warning: string | null;
  /** The current song's cover picture, if it has one (a folder song's may turn out empty). */
  cover: string | null;
  shuffle: boolean;
  repeat: Repeat;
  volume: number;
  muted: boolean;
  hasNext: boolean;
  /** The songs after the current one, in play order, with their places in it (for `jump`, `remove`). */
  upNext: { track: PlayerTrack; position: number }[];
  /** Plays `tracks` from `index` on — shuffled, if shuffle is on (or `shuffle` says so). */
  play: (tracks: PlayerTrack[], index: number, options?: { shuffle?: boolean }) => void;
  /**
   * Adds songs right after the current one, or at the end. With nothing
   * playing, they start playing (so call it inside the click).
   */
  enqueue: (tracks: readonly PlayerTrack[], where: "next" | "last") => void;
  /** Plays the song at this place in the play order (from `upNext`). */
  jump: (position: number) => void;
  /** Takes the song at this place in the play order out of the queue. */
  remove: (position: number) => void;
  /** Takes every song after the current one out of the queue. */
  clearUpNext: () => void;
  /**
   * Takes this song out of the queue for good (it was deleted from the
   * folder), letting go of its file if it's the current one: the next song
   * carries on (playing, if this one was), else the player closes. Call it
   * inside the click.
   */
  discard: (key: string) => void;
  /** Is the Up next list open (above the player bar)? It shows what's added, so no note is needed. */
  upNextOpen: boolean;
  setUpNextOpen: (open: boolean) => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  /** Moves this many seconds on (or back, if negative). */
  seekBy: (seconds: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  /** Newer details of songs in the queue (tags read since, say). */
  refresh: (tracks: readonly PlayerTrack[]) => void;
  /**
   * Lets go of this song's file if it's the one loaded, because it's about to
   * change (trimmed): it stays the current song, paused, and loads afresh
   * from `at` seconds when played.
   */
  letGo: (key: string, at: number) => void;
  close: () => void;
};

const PlayerContext = createContext<Player | null>(null);
// Kept apart: it changes several times a second while a song plays.
const TimeContext = createContext<{ time: number; duration: number | null }>({
  time: 0,
  duration: null,
});

// After a song fails, wait this long before moving on, so the reason can be read.
const SKIP_AFTER_FAILURE_MS = 2000;
// WebKit doesn't end a song on a seek past where a cut-short file stops, as Chrome
// does: it lands short of the place asked for and stands still there (seen on Windows),
// says it got there and plays nothing (seen on Linux), or never finishes the seek.
// Not playing on this long after the seek (looked at again while it's still
// fetching, up to SEEK_LOOKS times), that's a file cut short.
const STUCK_SEEK_MS = 4000;

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
function forget(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing was stored, then.
  }
}

// Where the last visit left off: its queue, and where the song was.
const QUEUE_KEY = "player-queue";
const RESUME_KEY = "player-resume";

/** The last visit's queue and where to carry on, if there's one to carry on. */
function restoredPlayer(): { queue: Queue; time: number } | null {
  const queue = parseRememberedQueue(stored(QUEUE_KEY));
  const track = queue && currentOf(queue);
  if (!queue || !track) return null;
  return { queue, time: resumeTimeFor(stored(RESUME_KEY), track) };
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
  // Shown paused, not loaded: nothing is fetched until Play.
  const [restored] = useState(restoredPlayer);
  const [queue, setQueueState] = useState<Queue>(() => restored?.queue ?? EMPTY_QUEUE);
  const [status, setStatus] = useState<PlayerStatus>(restored ? "paused" : "idle");
  const [time, setTime] = useState(restored?.time ?? 0);
  const [duration, setDuration] = useState<number | null>(() =>
    restored ? (currentOf(restored.queue)?.duration ?? null) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
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
  const [upNextOpen, setUpNextOpen] = useState(false);

  // The latest values, for the audio element's events and the media keys.
  const latest = useRef({ queue, shuffle, repeat });
  // What's loaded: which song, from which address, and whether that's the
  // app's conversion, and where it was to start. A device song's address is
  // an object URL to let go of.
  const loaded = useRef<{
    key: string;
    src: string;
    converted: boolean;
    startAt: number;
  } | null>(null);
  const objectUrl = useRef<string | null>(null);
  const failuresInARow = useRef(0);
  // Where the current song starts when it's loaded (a remembered song, say).
  const resumeAt = useRef(restored?.time ?? 0);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Where the last seek asked to go, until the song gets there.
  const seekAsked = useRef<number | null>(null);
  // Where a seek landed short of where it was asked to (WebKit, a file cut short).
  const seekLanded = useRef<number | null>(null);
  const seekCheck = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Counts seeks, so a look at one that's been followed by another does nothing.
  const seeks = useRef(0);

  const current = currentOf(queue) ?? null;

  const actions = useMemo(() => {
    const audio = () => audioRef.current;
    const setQueue = (next: Queue) => {
      latest.current = { ...latest.current, queue: next };
      setQueueState(next);
    };
    const currentTrack = () => currentOf(latest.current.queue);
    const letGoOfObjectUrl = () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    };
    const onPlayRefused = (err: unknown) => {
      // Not allowed to start by itself (a phone, say): it waits for Play.
      if (err instanceof DOMException && err.name === "NotAllowedError") setStatus("paused");
    };

    /**
     * Loads a song into the audio element (and starts it, unless `autoplay`
     * is false), from `startAt` seconds in.
     */
    const load = (
      track: PlayerTrack,
      {
        autoplay = true,
        convert = false,
        startAt = 0,
      }: { autoplay?: boolean; convert?: boolean; startAt?: number } = {},
    ) => {
      const element = audio();
      if (!element) return;
      clearTimeout(skipTimer.current);
      clearTimeout(seekCheck.current);
      resumeAt.current = 0;
      seekAsked.current = null;
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
      const attempt = { key: track.key, src, converted, startAt };
      loaded.current = attempt;
      setError(null);
      setWarning(null);
      setTime(startAt);
      setDuration(track.duration);
      setConverting(converted);
      setStatus(autoplay ? "loading" : "paused");
      element.src = src;
      if (startAt > 0) {
        // It can only move there once it knows how long the song is.
        const moveOn = () => {
          if (loaded.current === attempt) element.currentTime = startAt;
        };
        element.addEventListener("loadedmetadata", moveOn, { once: true });
      }
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
      if (!loaded.current && resumeAt.current > RESTART_AFTER_SECONDS) {
        // Remembered part-way through, not loaded yet: back to its start.
        resumeAt.current = 0;
        setTime(0);
        return;
      }
      goTo(previousPosition(q.position, q.order.length, r));
    };

    /** The file stops before where the seek asked for: it stays on this song, and says so. */
    const cutShort = (asked: number) => {
      setStatus("paused");
      setWarning(
        `The file stops before ${formatDuration(asked)} (cut short?): pick an earlier point.`,
      );
    };

    /**
     * A seek got somewhere: where it was asked to, or (a file cut short) the end, which
     * `ended` follows, or short of it, which the check after the seek looks into.
     */
    const seeked = () => {
      const element = audio();
      const asked = seekAsked.current;
      if (!element || asked === null) return;
      if (Math.abs(element.currentTime - asked) <= 1) seekAsked.current = null;
      else if (!seekRanOffTheEnd(asked, element.currentTime, element.duration))
        seekLanded.current = element.currentTime;
    };

    /** The song ended by itself: the next one, the same one again, or stop. */
    const ended = () => {
      const element = audio();
      const asked = seekAsked.current;
      seekAsked.current = null;
      if (
        element &&
        asked !== null &&
        seekRanOffTheEnd(asked, element.currentTime, element.duration)
      ) {
        cutShort(asked);
        return;
      }
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
        load(track, { convert: true, startAt: element.currentTime || attempt.startAt });
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
      resumeAt.current = 0;
      failuresInARow.current = 0;
      setQueue(EMPTY_QUEUE);
      setUpNextOpen(false);
      setStatus("idle");
      setError(null);
      setWarning(null);
      setConverting(false);
      setTime(0);
      setDuration(null);
    };

    const play = (tracks: PlayerTrack[], index: number, options: { shuffle?: boolean } = {}) => {
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
    };

    const seek = (seconds: number) => {
      const element = audio();
      if (!element || !Number.isFinite(seconds)) return;
      const track = currentTrack();
      if (!loaded.current && track) {
        // Not loaded yet: it starts there when it is.
        resumeAt.current = Math.max(0, Math.min(seconds, track.duration ?? seconds));
        setTime(resumeAt.current);
        return;
      }
      const end = Number.isFinite(element.duration) ? element.duration : seconds;
      const asked = Math.max(0, Math.min(seconds, end));
      seekAsked.current = asked;
      seekLanded.current = null;
      element.currentTime = asked;
      setTime(element.currentTime);
      clearTimeout(seekCheck.current);
      const seekNumber = ++seeks.current;
      let from: number | null = null;
      let looks = 0;
      // Judged by whether the song plays on, not by the seek's events: WebKit can
      // say a seek past a cut-short file's end got there, then play nothing.
      const check = () => {
        if (seeks.current !== seekNumber || element.paused) return;
        looks += 1;
        const verdict = afterSeek({
          from: from ?? seekLanded.current ?? asked,
          now: element.currentTime,
          fetching: element.networkState === HTMLMediaElement.NETWORK_LOADING,
          looks,
        });
        from = element.currentTime;
        if (verdict === "look-again") {
          seekCheck.current = setTimeout(check, STUCK_SEEK_MS);
          return;
        }
        if (seekAsked.current === asked) seekAsked.current = null;
        if (verdict === "cut-short") {
          element.pause();
          cutShort(asked);
        }
      };
      seekCheck.current = setTimeout(check, STUCK_SEEK_MS);
    };

    return {
      play,
      enqueue: (tracks: readonly PlayerTrack[], where: "next" | "last") => {
        if (tracks.length === 0) return;
        const { queue: q } = latest.current;
        // Nothing to add them to: they play, in the order given.
        if (!currentOf(q)) return play([...tracks], 0, { shuffle: false });
        setQueue(queueWith(q, tracks, where));
      },
      jump: (position: number) => {
        failuresInARow.current = 0;
        goTo(position);
      },
      remove: (position: number) => setQueue(queueWithout(latest.current.queue, position)),
      clearUpNext: () => setQueue(queueUntilCurrent(latest.current.queue)),
      discard: (key: string) => {
        const { queue: q } = latest.current;
        const { queue: rest, current: then } = queueWithoutSong(q, key);
        if (then === "same") return setQueue(rest);
        if (then === "none") return close();
        const element = audio();
        const wasPlaying = !!element && !element.paused;
        const track = currentOf(rest);
        setQueue(rest);
        failuresInARow.current = 0;
        if (track) load(track, { autoplay: then === "next" && wasPlaying });
      },
      toggle: () => {
        const element = audio();
        const track = currentTrack();
        if (!element || !track) return;
        if (!element.paused) return element.pause();
        // Not loaded yet (remembered from last time), failed, or let go of: load it.
        if (!loaded.current || loaded.current.key !== track.key || element.error) {
          failuresInARow.current = 0;
          return load(track, { startAt: resumeAt.current });
        }
        element.play().catch(onPlayRefused);
      },
      next,
      previous,
      seek,
      seekBy: (seconds: number) => {
        const element = audio();
        if (!element) return;
        seek((loaded.current ? element.currentTime : resumeAt.current) + seconds);
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
      letGo: (key: string, at: number) => {
        const element = audio();
        if (!element || loaded.current?.key !== key) return;
        element.pause();
        element.removeAttribute("src");
        element.load(); // lets go of the file
        loaded.current = null;
        resumeAt.current = Math.max(0, at);
        setStatus("paused");
        setTime(resumeAt.current);
      },
      close,
      // For the audio element's events (below).
      seeked,
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
        setWarning(null);
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
      seeked: actions.seeked,
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

  // Remember the queue for next time (its folder songs).
  useEffect(() => {
    const text = rememberedQueueText(queue);
    if (text) return store(QUEUE_KEY, text);
    forget(QUEUE_KEY);
    forget(RESUME_KEY);
  }, [queue]);

  // And where the song is: every few seconds while it plays, when it stops,
  // and when the page goes away.
  const currentKey = current?.key;
  const second = Math.floor(time);
  useEffect(() => {
    if (!currentKey || (status === "playing" && second % 5 !== 0)) return;
    store(RESUME_KEY, resumeText(currentKey, second));
  }, [currentKey, second, status]);
  useEffect(() => {
    const onPageHide = () => {
      const track = currentOf(latest.current.queue);
      const element = audioRef.current;
      if (!track || !element) return;
      const at = loaded.current?.key === track.key ? element.currentTime : resumeAt.current;
      store(RESUME_KEY, resumeText(track.key, at));
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // The current song's cover picture.
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
      warning,
      cover,
      shuffle,
      repeat,
      volume,
      muted,
      hasNext: nextPosition(queue.position, queue.order.length, repeat, { skip: true }) !== null,
      upNext: upNext(queue),
      play: actions.play,
      enqueue: actions.enqueue,
      jump: actions.jump,
      remove: actions.remove,
      clearUpNext: actions.clearUpNext,
      discard: actions.discard,
      upNextOpen,
      setUpNextOpen,
      toggle: actions.toggle,
      next: actions.next,
      previous: actions.previous,
      seek: actions.seek,
      seekBy: actions.seekBy,
      setVolume: actions.setVolume,
      toggleMute: actions.toggleMute,
      toggleShuffle: actions.toggleShuffle,
      cycleRepeat: actions.cycleRepeat,
      refresh: actions.refresh,
      letGo: actions.letGo,
      close: actions.close,
    }),
    [
      current,
      status,
      converting,
      error,
      warning,
      cover,
      shuffle,
      repeat,
      volume,
      muted,
      queue,
      upNextOpen,
      actions,
    ],
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
