import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkReason,
  confidentMatch,
  downloadSongs,
  marksWhere,
  uniqueSongs,
  type DownloadAllCalls,
  type SongStatus,
} from "../../client/src/hooks/use-download-all";
import { ApiError } from "../../client/src/lib/save-to-folder";
import { spotifyFileName } from "../../shared/spotify-names";
import type { SearchResult, SpotifyPlaylistTrack } from "../../shared/schema";

const result = (id: string, duration: number | null): SearchResult => ({
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  title: id,
  channel: "Someone",
  duration,
  thumbnail: "",
  official: true,
});

describe("marksWhere", () => {
  // Opening another playlist forgets the last run's marks, but a run still
  // going keeps going, with the marks of the songs it's working on.
  it("keeps the songs still being downloaded, or only the ones done with", () => {
    const statuses: Record<string, SongStatus> = {
      a: { state: "waiting" },
      b: { state: "finding" },
      c: { state: "saving", bytes: 10 },
      d: { state: "saved", file: "d.mp3" },
      e: { state: "check", reason: "?" },
      f: { state: "failed", reason: "!" },
    };
    expect(Object.keys(marksWhere(statuses, true))).toEqual(["a", "b", "c"]);
    expect(Object.keys(marksWhere(statuses, false))).toEqual(["d", "e", "f"]);
    expect(marksWhere(statuses, true).c).toEqual({ state: "saving", bytes: 10 });
  });
});

describe("confidentMatch", () => {
  it("takes the best match when it's the same length as the song on Spotify", () => {
    const best = result("aaaaaaaaaaa", 356);
    expect(confidentMatch([best, result("bbbbbbbbbbb", 354)], 354)).toBe(best);
    expect(confidentMatch([result("aaaaaaaaaaa", 349)], 354)?.id).toBe("aaaaaaaaaaa");
  });

  it("takes nothing when the best match isn't — even if a worse one is", () => {
    expect(confidentMatch([result("aaaaaaaaaaa", 400), result("bbbbbbbbbbb", 354)], 354)).toBe(
      undefined,
    );
  });

  it("takes nothing without lengths to compare, or without results", () => {
    expect(confidentMatch([result("aaaaaaaaaaa", 354)], null)).toBeUndefined();
    expect(confidentMatch([result("aaaaaaaaaaa", null)], 354)).toBeUndefined();
    expect(confidentMatch([], 354)).toBeUndefined();
  });

  it("says why, for the song's “check” mark", () => {
    expect(checkReason([], 354)).toMatch(/no uploads/i);
    expect(checkReason([result("aaaaaaaaaaa", 400)], 354)).toMatch(/same length/i);
    // Spotify's fallback knows a song's title, not its length: nothing to match by.
    expect(checkReason([result("aaaaaaaaaaa", 354)], null)).toMatch(/didn't say how long/i);
  });
});

describe("downloadSongs", () => {
  afterEach(() => vi.useRealTimers());

  const song = (id: string, duration: number | null = 354): SpotifyPlaylistTrack => ({
    id,
    url: `https://open.spotify.com/track/${id}`,
    title: `Song ${id}`,
    artists: "Someone",
    duration,
    explicit: false,
  });
  const A = song("AAAAAAAAAAAAAAAAAAAAAA");
  const B = song("BBBBBBBBBBBBBBBBBBBBBB");
  const C = song("CCCCCCCCCCCCCCCCCCCCCC", null); // its length isn't known

  /** Stand-ins for the app: each song's search answer (or error), and saves that work. */
  function app(answers: Record<string, SearchResult[] | Error>, failSave?: Error) {
    const calls: DownloadAllCalls = {
      search: vi.fn(async (query: string) => {
        const answer = answers[query];
        if (answer instanceof Error) throw answer;
        return { results: answer ?? [], source: "youtube" as const };
      }),
      save: vi.fn(async (request: { name?: string }) => {
        if (failSave) throw failSave;
        return {
          type: "done" as const,
          fileName: `${request.name}.mp3`,
          folder: "/Music",
          path: `/Music/${request.name}.mp3`,
          bytes: 1,
        };
      }),
    };
    return calls;
  }

  const run = (
    queue: SpotifyPlaylistTrack[],
    calls: DownloadAllCalls,
    { atOnce = 4, signal = new AbortController().signal } = {},
  ) => {
    const finished: [string, SongStatus][] = [];
    const summary = downloadSongs(
      queue,
      {
        source: "spotify",
        format: "mp3",
        atOnce,
        signal,
        report: () => {},
        finished: (s, status) => finished.push([s.id, status]),
      },
      calls,
    );
    /** How each song ended, by its id (songs in flight together finish in any order). */
    const byId = () => Object.fromEntries(finished);
    return { summary, finished, byId };
  };

  it("marks a song every source failed as failed, and moves straight on", async () => {
    // Fake timers: anything that waited (a back-off, a retry delay) would never finish.
    vi.useFakeTimers();
    const bothFailed = new ApiError("Search failed: no connection.", 502);
    const calls = app({ [A.url]: bothFailed, [B.url]: [result("bbbbbbbbbbb", 355)] });
    const { summary, byId } = run([A, B], calls);
    expect(await summary).toEqual({ saved: 1, check: 0, failed: 1, stopped: false });
    expect(byId()).toEqual({
      [A.id]: { state: "failed", reason: bothFailed.message },
      [B.id]: { state: "saved", file: "Someone - Song BBBBBBBBBBBBBBBBBBBBBB.mp3" },
    });
    expect(calls.search).toHaveBeenCalledTimes(2); // A's search wasn't tried again
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves on after a save YouTube refused, too", async () => {
    vi.useFakeTimers();
    const refused = new ApiError("YouTube is limiting this computer right now.", 502, true);
    const calls = app({ [A.url]: [result("aaaaaaaaaaa", 354)], [B.url]: [] }, refused);
    const { summary, byId } = run([A, B], calls);
    expect(await summary).toEqual({ saved: 0, check: 1, failed: 1, stopped: false });
    expect(byId()).toEqual({
      [A.id]: { state: "failed", reason: refused.message },
      [B.id]: { state: "check", reason: checkReason([], 354) },
    });
  });

  it("switches to SoundCloud alone, at once, for a song whose save YouTube refused", async () => {
    vi.useFakeTimers();
    const refused = new ApiError("YouTube is refusing this computer right now.", 502, true);
    const onSoundCloud: SearchResult = {
      ...result("x", 355),
      id: "soundcloud:tracks:254112129",
      url: "https://api.soundcloud.com/tracks/254112129",
      official: false,
      source: "soundcloud",
    };
    const calls: DownloadAllCalls = {
      search: vi.fn(async (_query: string, _signal?: AbortSignal, options?) =>
        options?.soundCloudOnly
          ? { results: [onSoundCloud], source: "soundcloud" as const }
          : {
              results: [{ ...result("aaaaaaaaaaa", 354), source: "youtube" as const }],
              source: "youtube" as const,
            },
      ),
      save: vi.fn(async (request: { url: string; name?: string }) => {
        if (request.url.startsWith("https://www.youtube.com/")) throw refused;
        return {
          type: "done" as const,
          fileName: `${request.name}.mp3`,
          folder: "/Music",
          path: `/Music/${request.name}.mp3`,
          bytes: 1,
        };
      }),
    };
    const { summary, finished } = run([A], calls);
    expect(await summary).toEqual({ saved: 1, check: 0, failed: 0, stopped: false });
    expect(finished).toEqual([
      [
        A.id,
        { state: "saved", file: "Someone - Song AAAAAAAAAAAAAAAAAAAAAA.mp3", source: "soundcloud" },
      ],
    ]);
    expect(calls.search).toHaveBeenLastCalledWith(A.url, expect.any(AbortSignal), {
      soundCloudOnly: true,
    });
    expect(calls.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ url: onSoundCloud.url, spotifyId: A.id }),
      expect.anything(),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("marks a song whose length isn't known “check”, rather than guess", async () => {
    const calls = app({ [C.url]: [result("ccccccccccc", 200)] });
    const { summary, finished } = run([C], calls);
    expect(await summary).toMatchObject({ saved: 0, check: 1 });
    expect(finished[0][1]).toEqual({
      state: "check",
      reason: checkReason([result("ccccccccccc", 200)], null),
    });
    expect(calls.save).not.toHaveBeenCalled();
  });

  it("stops at a problem with the folder, which every other song would hit too", async () => {
    const gone = new ApiError("That folder doesn't exist any more.", 404);
    const calls = app({ [A.url]: [result("aaaaaaaaaaa", 354)], [B.url]: [result("b", 354)] }, gone);
    const { summary, finished } = run([A, B], calls, { atOnce: 1 });
    expect(await summary).toEqual({
      saved: 0,
      check: 0,
      failed: 1,
      stopped: true,
      problem: gone.message,
    });
    expect(finished).toHaveLength(1);
    expect(calls.search).toHaveBeenCalledTimes(1); // B was never started
  });
});

describe("downloadSongs, as many songs at once as the app's computer has cores", () => {
  const song = (n: number, title = `Song ${n}`): SpotifyPlaylistTrack => ({
    id: String.fromCharCode(64 + n).repeat(22), // "AAAA…", "BBBB…"
    url: `https://open.spotify.com/track/${String.fromCharCode(64 + n).repeat(22)}`,
    title,
    artists: "Someone",
    duration: 200,
    explicit: false,
  });
  const songs = [1, 2, 3, 4, 5].map((n) => song(n));
  const sameLength = (n: number) => [result(`video${n}`.padEnd(11, "x"), 200)];

  /**
   * The app at work on several songs: every search finds a match the same
   * length as the song, and every save waits until the test says how it ends
   * (`saves`, by song id) — or until it's cancelled, as a real one is.
   */
  function busyApp(answers: Record<string, SearchResult[]> = {}) {
    const saves = new Map<
      string,
      {
        name?: string;
        signal: AbortSignal;
        done: (fileName?: string) => void;
        fail: (err: Error) => void;
      }
    >();
    let inFlight = 0;
    let mostAtOnce = 0;
    const calls: DownloadAllCalls = {
      search: vi.fn(async (query: string) => {
        const n = songs.findIndex((s) => s.url === query) + 1;
        return { results: answers[query] ?? sameLength(n), source: "youtube" as const };
      }),
      save: vi.fn(
        (
          request: { name?: string; spotifyId?: string },
          { signal }: { signal?: AbortSignal } = {},
        ) =>
          new Promise((resolve, reject) => {
            inFlight++;
            mostAtOnce = Math.max(mostAtOnce, inFlight);
            const id = request.spotifyId!;
            const settle = () => {
              inFlight--;
              saves.delete(id);
            };
            signal!.addEventListener("abort", () => {
              settle();
              reject(new DOMException("The user aborted a request.", "AbortError"));
            });
            saves.set(id, {
              name: request.name,
              signal: signal!,
              done: (fileName = `${request.name}.mp3`) => {
                settle();
                resolve({
                  type: "done" as const,
                  fileName,
                  folder: "/Music",
                  path: `/Music/${fileName}`,
                  bytes: 1,
                });
              },
              fail: (err) => {
                settle();
                reject(err);
              },
            });
          }),
      ),
    };
    /** Settles once `count` saves are under way. */
    const whenSaving = (count: number) =>
      vi.waitFor(() => expect(saves.size).toBe(count), { timeout: 5_000, interval: 5 });
    return { calls, saves, whenSaving, mostAtOnce: () => mostAtOnce };
  }

  function start(
    queue: SpotifyPlaylistTrack[],
    calls: DownloadAllCalls,
    atOnce: number,
    controller = new AbortController(),
  ) {
    const finished: [string, SongStatus][] = [];
    const summary = downloadSongs(
      queue,
      {
        source: "spotify",
        format: "mp3",
        atOnce,
        signal: controller.signal,
        report: () => {},
        finished: (s, status) => finished.push([s.id, status]),
      },
      calls,
    );
    return { summary, finished, controller };
  }

  it("works on that many songs at once, starting the next the moment one is done", async () => {
    const app = busyApp();
    const { summary, finished } = start(songs, app.calls, 3);
    await app.whenSaving(3);
    expect([...app.saves.keys()]).toEqual([songs[0].id, songs[1].id, songs[2].id]);
    expect(app.calls.search).toHaveBeenCalledTimes(3); // the other two wait their turn

    app.saves.get(songs[1].id)!.done();
    await app.whenSaving(3); // the fourth song took its place
    expect(app.saves.has(songs[3].id)).toBe(true);
    for (let left = 4; left > 0; left--) {
      await app.whenSaving(Math.min(left, 3));
      app.saves.values().next().value!.done();
    }
    expect(await summary).toEqual({ saved: 5, check: 0, failed: 0, stopped: false });
    expect(finished).toHaveLength(5);
    expect(new Set(finished.map(([id]) => id)).size).toBe(5); // each song once
    expect(app.mostAtOnce()).toBe(3);
  });

  it("Stop cancels every song in flight, and starts no more", async () => {
    const app = busyApp();
    const { summary, finished, controller } = start(songs, app.calls, 2);
    await app.whenSaving(2);
    const inFlight = [...app.saves.values()].map((save) => save.signal);
    controller.abort();
    expect(await summary).toEqual({ saved: 0, check: 0, failed: 0, stopped: true });
    expect(inFlight.every((signal) => signal.aborted)).toBe(true); // both saves were cancelled
    expect(app.calls.save).toHaveBeenCalledTimes(2);
    expect(finished).toEqual([]); // neither was done with, so neither counts
  });

  it("a problem with the folder stops the whole run, cancelling the songs in flight", async () => {
    const app = busyApp();
    const { summary, finished } = start(songs, app.calls, 3);
    await app.whenSaving(3);
    const others = [songs[1], songs[2]].map((s) => app.saves.get(s.id)!.signal);
    const full = new ApiError("The drive with “Music” is full.", 507);
    app.saves.get(songs[0].id)!.fail(full);
    expect(await summary).toEqual({
      saved: 0,
      check: 0,
      failed: 1,
      stopped: true,
      problem: full.message,
    });
    expect(others.every((signal) => signal.aborted)).toBe(true);
    expect(finished).toEqual([[songs[0].id, { state: "failed", reason: full.message }]]);
    expect(app.calls.search).toHaveBeenCalledTimes(3); // songs 4 and 5 were never started
  });

  it("downloads a song that's in the list twice once", async () => {
    const app = busyApp();
    const { summary } = start([songs[0], songs[1], songs[0]], app.calls, 4);
    await app.whenSaving(2);
    for (const save of [...app.saves.values()]) save.done();
    expect(await summary).toEqual({ saved: 2, check: 0, failed: 0, stopped: false });
    expect(app.calls.search).toHaveBeenCalledTimes(2);
    expect(app.calls.save).toHaveBeenCalledTimes(2);
    expect(uniqueSongs([songs[0], songs[1], songs[0]])).toEqual([songs[0], songs[1]]);
  });

  it("saves two songs with the same name at the same time, each under the name the app gave it", async () => {
    // Two Spotify songs that are both "Someone - Same Song" (the same song on two albums).
    const twins = [song(1, "Same Song"), song(2, "Same Song")];
    const app = busyApp();
    const { summary, finished } = start(twins, app.calls, 2);
    await app.whenSaving(2);
    const [first, second] = [...app.saves.values()];
    expect([first.name, second.name]).toEqual(["Someone - Same Song", "Someone - Same Song"]);
    // The app claims a free name for each as it finishes (server/folders.ts: claimNewName()).
    second.done("Someone - Same Song.mp3");
    first.done("Someone - Same Song (1).mp3");
    expect(await summary).toMatchObject({ saved: 2 });
    expect(Object.fromEntries(finished)).toEqual({
      [twins[0].id]: { state: "saved", file: "Someone - Same Song (1).mp3" },
      [twins[1].id]: { state: "saved", file: "Someone - Same Song.mp3" },
    });
  });

  it("keeps the counts right as songs finish in any order", async () => {
    const app = busyApp({
      [songs[1].url]: [result("longerxxxxx", 260)], // not the same length: check
    });
    const { summary, finished } = start(songs.slice(0, 4), app.calls, 4);
    await app.whenSaving(3);
    app.saves.get(songs[3].id)!.done();
    app.saves.get(songs[2].id)!.fail(new ApiError("Couldn't download the audio: gone", 502));
    app.saves.get(songs[0].id)!.done();
    expect(await summary).toEqual({ saved: 2, check: 1, failed: 1, stopped: false });
    expect(finished.map(([id]) => id).sort()).toEqual(
      songs
        .slice(0, 4)
        .map((s) => s.id)
        .sort(),
    );
  });

  it("works on a single song when it's told one, and on all of them if there are fewer", async () => {
    const one = busyApp();
    const sequential = start(songs.slice(0, 2), one.calls, 1);
    await one.whenSaving(1);
    one.saves.values().next().value!.done();
    await one.whenSaving(1);
    one.saves.values().next().value!.done();
    expect(await sequential.summary).toMatchObject({ saved: 2 });
    expect(one.mostAtOnce()).toBe(1);

    const wide = busyApp();
    const few = start(songs.slice(0, 2), wide.calls, 64);
    await wide.whenSaving(2);
    for (const save of [...wide.saves.values()]) save.done();
    expect(await few.summary).toMatchObject({ saved: 2 });
  });
});

describe("spotifyFileName", () => {
  it("names a song “Artists - Title”, without release notes or featured artists in the title", () => {
    expect(
      spotifyFileName({ title: "Bohemian Rhapsody - Remastered 2011", artists: "Queen" }),
    ).toBe("Queen - Bohemian Rhapsody");
    expect(
      spotifyFileName({
        title: "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
        artists: ["Daft Punk", "Pharrell Williams", "Nile Rodgers"],
      }),
    ).toBe("Daft Punk, Pharrell Williams, Nile Rodgers - Get Lucky");
    expect(spotifyFileName({ title: "Hotel California - Live", artists: "Eagles" })).toBe(
      "Eagles - Hotel California - Live",
    );
  });

  it("is just the title when there are no artists", () => {
    expect(spotifyFileName({ title: "Song", artists: [] })).toBe("Song");
    expect(spotifyFileName({ title: "Song", artists: " " })).toBe("Song");
  });
});
