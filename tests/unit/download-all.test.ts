import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_WAIT_MS,
  checkReason,
  confidentMatch,
  retryDelayMs,
  wait,
  waitingOutLimit,
  type SongStatus,
} from "../../client/src/hooks/use-download-all";
import { ApiError } from "../../client/src/lib/save-to-folder";
import { spotifyFileName } from "../../shared/spotify-names";
import type { SearchResult } from "../../shared/schema";

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
    expect(checkReason([], 354)).toMatch(/no youtube uploads/i);
    expect(checkReason([result("aaaaaaaaaaa", 400)], 354)).toMatch(/same length/i);
    // Spotify's fallback knows a song's title, not its length: nothing to match by.
    expect(checkReason([result("aaaaaaaaaaa", 354)], null)).toMatch(/didn't say how long/i);
  });
});

describe("retryDelayMs", () => {
  const LIMITED = "YouTube is limiting this computer. Wait about 10 minutes, then try again.";

  it("is how long the app's 429 says to wait, at most 15 minutes", () => {
    expect(retryDelayMs(new ApiError(LIMITED, 429, 600))).toBe(600_000);
    expect(retryDelayMs(new ApiError(LIMITED, 429, 1))).toBe(1000);
    expect(retryDelayMs(new ApiError(LIMITED, 429, 0))).toBe(0);
    expect(retryDelayMs(new ApiError(LIMITED, 429, 3600))).toBe(MAX_WAIT_MS);
  });

  it("is nothing for any other failure", () => {
    expect(retryDelayMs(new ApiError(LIMITED, 429))).toBeUndefined(); // no Retry-After
    expect(retryDelayMs(new ApiError("Couldn't download the audio", 502, 600))).toBeUndefined();
    expect(retryDelayMs(new Error("network"))).toBeUndefined();
    expect(retryDelayMs(undefined)).toBeUndefined();
  });
});

describe("waitingOutLimit", () => {
  const limited = () => new ApiError("YouTube is limiting this computer.", 429, 2);
  afterEach(() => vi.useRealTimers());

  it("waits as long as the 429 says, showing the song waiting, then tries once more", async () => {
    vi.useFakeTimers();
    const reports: SongStatus[] = [];
    let calls = 0;
    const step = vi.fn(async () => {
      if (calls++ === 0) throw limited();
      return "found";
    });
    const result = waitingOutLimit(step, new AbortController().signal, (s) => reports.push(s), {
      state: "finding",
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(step).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([{ state: "waiting", message: "YouTube is limiting this computer." }]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe("found");
    expect(step).toHaveBeenCalledTimes(2);
    expect(reports).toEqual([
      { state: "waiting", message: "YouTube is limiting this computer." },
      { state: "finding" },
    ]);
  });

  it("gives up after a second 429, with that answer", async () => {
    vi.useFakeTimers();
    const step = vi.fn(async () => {
      throw limited();
    });
    const result = waitingOutLimit(step, new AbortController().signal, () => {}, {
      state: "finding",
    });
    const settled = result.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await settled).toMatchObject({ status: 429, retryAfterSeconds: 2 });
    expect(step).toHaveBeenCalledTimes(2);
  });

  it("passes any other failure straight through", async () => {
    const step = vi.fn(async () => {
      throw new ApiError("Couldn't download the audio", 502);
    });
    await expect(
      waitingOutLimit(step, new AbortController().signal, () => {}, { state: "finding" }),
    ).rejects.toThrow("Couldn't download the audio");
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("ends the wait when stopped", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const step = vi.fn(async () => {
      throw limited();
    });
    const result = waitingOutLimit(step, controller.signal, () => {}, { state: "finding" });
    const settled = result.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new DOMException("Stopped", "AbortError"));
    expect(await settled).toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(step).toHaveBeenCalledTimes(1);
  });
});

describe("wait", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves after the time, or rejects at once if already stopped", async () => {
    vi.useFakeTimers();
    let done = false;
    const waited = wait(1000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await waited;
    expect(done).toBe(true);

    const stopped = new AbortController();
    stopped.abort(new Error("already"));
    await expect(wait(1000, stopped.signal)).rejects.toThrow("already");
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
