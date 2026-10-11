import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkReason,
  confidentMatch,
  downloadSongs,
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

  const run = (queue: SpotifyPlaylistTrack[], calls: DownloadAllCalls) => {
    const finished: [string, SongStatus][] = [];
    const summary = downloadSongs(
      queue,
      {
        source: "spotify",
        format: "mp3",
        signal: new AbortController().signal,
        report: () => {},
        finished: (s, status) => finished.push([s.id, status]),
      },
      calls,
    );
    return { summary, finished };
  };

  it("marks a song every source failed as failed, and moves straight on to the next", async () => {
    // Fake timers: anything that waited (a back-off, a retry delay) would never finish.
    vi.useFakeTimers();
    const bothFailed = new ApiError("Search failed: no connection.", 502);
    const calls = app({ [A.url]: bothFailed, [B.url]: [result("bbbbbbbbbbb", 355)] });
    const { summary, finished } = run([A, B], calls);
    expect(await summary).toEqual({ saved: 1, check: 0, failed: 1, stopped: false });
    expect(finished).toEqual([
      [A.id, { state: "failed", reason: bothFailed.message }],
      [B.id, { state: "saved", file: "Someone - Song BBBBBBBBBBBBBBBBBBBBBB.mp3" }],
    ]);
    expect(calls.search).toHaveBeenCalledTimes(2); // A's search wasn't tried again
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves on after a save YouTube refused, too", async () => {
    vi.useFakeTimers();
    const refused = new ApiError("YouTube is limiting this computer right now.", 502, true);
    const calls = app({ [A.url]: [result("aaaaaaaaaaa", 354)], [B.url]: [] }, refused);
    const { summary, finished } = run([A, B], calls);
    expect(await summary).toEqual({ saved: 0, check: 1, failed: 1, stopped: false });
    expect(finished[0]).toEqual([A.id, { state: "failed", reason: refused.message }]);
    expect(finished[1]).toEqual([B.id, { state: "check", reason: checkReason([], 354) }]);
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
    const { summary, finished } = run([A, B], calls);
    expect(await summary).toEqual({
      saved: 0,
      check: 0,
      failed: 1,
      stopped: true,
      problem: gone.message,
    });
    expect(finished).toHaveLength(1);
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
