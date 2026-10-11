import { describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  COOLDOWN_MS,
  Cooldown,
  LIMITED_MESSAGE,
  TtlCache,
  YouTubeGuard,
  YouTubeLimited,
  classifyYtDlpError,
  limitConcurrent,
  limitedBody,
  playlistCacheKey,
  searchCacheKey,
  shouldRetry,
  videoCacheKey,
} from "../../server/youtube-limits";
import { UPDATE_EVERY_MS, YtDlpUpdater } from "../../server/yt-dlp-update";
import type { SourceHealthStore } from "../../server/source-health";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

describe("classifyYtDlpError", () => {
  it("knows YouTube limiting the computer: throttled, or a bot check", () => {
    expect(classifyYtDlpError("HTTP Error 429: Too Many Requests")).toBe("throttled");
    expect(classifyYtDlpError("Unable to download webpage: Too Many Requests")).toBe("throttled");
    expect(
      classifyYtDlpError(
        "Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    ).toBe("bot-check");
    expect(classifyYtDlpError("Sign in to confirm you’re not a bot.")).toBe("bot-check"); // curly
  });

  it("knows the signs of an outdated yt-dlp", () => {
    for (const text of [
      "Requested format is not available. Use --list-formats for a list of available formats",
      "Unable to extract yt initial data; please report this issue",
      "Some formats may be missing: nsig extraction failed: Some formats may be missing",
      "Signature extraction failed: Some formats may be missing",
    ]) {
      expect(classifyYtDlpError(text), text).toBe("broken");
    }
  });

  it("knows a video that can't be had — nothing to retry or update over", () => {
    for (const text of [
      "Video unavailable",
      "Video unavailable. This content isn't available, try again later.",
      "This content isn’t available.",
      "Private video. Sign in if you've been granted access to this video",
    ]) {
      expect(classifyYtDlpError(text), text).toBe("unavailable");
    }
  });

  it("calls everything else other", () => {
    expect(classifyYtDlpError("ffmpeg exited with code 1")).toBe("other");
    expect(classifyYtDlpError("")).toBe("other");
  });
});

describe("Cooldown", () => {
  it("lasts ten minutes from its start, and extends rather than shortens", () => {
    const cooldown = new Cooldown();
    expect(cooldown.remainingMs(NOW)).toBe(0);
    cooldown.start(NOW);
    expect(cooldown.remainingMs(NOW)).toBe(COOLDOWN_MS);
    expect(cooldown.remainingMs(NOW + 4 * 60_000)).toBe(6 * 60_000);
    cooldown.start(NOW + 60_000, 60_000); // a shorter one, started later: no change
    expect(cooldown.remainingMs(NOW + 60_000)).toBe(COOLDOWN_MS - 60_000);
    expect(cooldown.remainingMs(NOW + COOLDOWN_MS)).toBe(0);
    expect(cooldown.remainingMs(NOW + COOLDOWN_MS + 1)).toBe(0);
  });
});

describe("limitConcurrent", () => {
  it("runs at most two tasks at once, and the rest in order", async () => {
    const gate = limitConcurrent(2);
    const started: number[] = [];
    const release: (() => void)[] = [];
    const task = (n: number) => () =>
      new Promise<number>((resolve) => {
        started.push(n);
        release.push(() => resolve(n));
      });
    const results = [1, 2, 3, 4].map((n) => gate(task(n)));
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    expect(gate.running).toBe(2);
    expect(gate.waiting).toBe(2);

    release[0]();
    await results[0];
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3]);
    release[1]();
    release[2]();
    await Promise.all(results.slice(0, 3));
    await Promise.resolve();
    expect(started).toEqual([1, 2, 3, 4]);
    release[3]();
    expect(await Promise.all(results)).toEqual([1, 2, 3, 4]);
    expect(gate.running).toBe(0);
    expect(gate.waiting).toBe(0);
  });

  it("frees the slot when a task fails", async () => {
    const gate = limitConcurrent(1);
    await expect(gate(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    expect(gate.running).toBe(0);
    expect(await gate(async () => "next")).toBe("next");
  });
});

describe("TtlCache", () => {
  it("answers for ten minutes, then forgets", () => {
    const cache = new TtlCache<string>();
    cache.set("a", "A", NOW);
    expect(cache.get("a", NOW + CACHE_TTL_MS - 1)).toBe("A");
    expect(cache.get("a", NOW + CACHE_TTL_MS)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("drops the entry used longest ago when full", () => {
    const cache = new TtlCache<number>(CACHE_TTL_MS, 3);
    cache.set("a", 1, NOW);
    cache.set("b", 2, NOW);
    cache.set("c", 3, NOW);
    expect(cache.get("a", NOW)).toBe(1); // a is now the most recently used
    cache.set("d", 4, NOW);
    expect(cache.size).toBe(3);
    expect(cache.get("b", NOW)).toBeUndefined();
    expect(cache.get("a", NOW)).toBe(1);
    expect(cache.get("d", NOW)).toBe(4);
  });

  it("keys a search by its normalised query, and a video or playlist by its id", () => {
    expect(searchCacheKey("  Daft  PUNK get lucky ")).toBe(searchCacheKey("daft punk get lucky"));
    expect(searchCacheKey("daft punk", 248)).not.toBe(searchCacheKey("daft punk"));
    expect(videoCacheKey("dQw4w9WgXcQ")).toBe("video:dQw4w9WgXcQ");
    expect(playlistCacheKey("PL123")).toBe("playlist:PL123");
  });
});

describe("YtDlpUpdater", () => {
  const updater = (outcomes: boolean[]) => {
    const run = vi.fn(async () => ({
      ok: outcomes.shift() ?? false,
      detail: "yt-dlp is up to date",
    }));
    const log = vi.fn();
    return { updater: new YtDlpUpdater(run, log), run, log };
  };

  it("updates once an hour at most, and says so in the log", async () => {
    const { updater: u, run, log } = updater([true, true]);
    expect(u.due(NOW)).toBe(true);
    expect(await u.update(NOW, "Unable to extract")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'yt-dlp: YouTube answered "Unable to extract" — updating yt-dlp, then trying once more.',
      "yt-dlp: updated (yt-dlp is up to date).",
    ]);

    expect(u.due(NOW + UPDATE_EVERY_MS - 1)).toBe(false);
    expect(await u.update(NOW + 30 * 60_000, "Unable to extract")).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);

    expect(u.due(NOW + UPDATE_EVERY_MS)).toBe(true);
    expect(await u.update(NOW + UPDATE_EVERY_MS, "Unable to extract")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("counts a failed update as this hour's try, and carries on", async () => {
    const run = vi.fn(async () => ({ ok: false, detail: "no network" }));
    const log = vi.fn();
    const u = new YtDlpUpdater(run, log);
    expect(await u.update(NOW, "Unable to extract")).toBe(false);
    expect(log.mock.calls[1][0]).toBe(
      "yt-dlp: couldn't update (no network) — carrying on with the one installed.",
    );
    expect(await u.update(NOW + 1000, "Unable to extract")).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shares an update in progress with callers that ask meanwhile", async () => {
    let finish!: (outcome: { ok: boolean; detail: string }) => void;
    const run = vi.fn(() => new Promise<{ ok: boolean; detail: string }>((r) => (finish = r)));
    const u = new YtDlpUpdater(run, () => {});
    const first = u.update(NOW, "nsig");
    const second = u.update(NOW + 10, "nsig");
    finish({ ok: true, detail: "Updated" });
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("swallows a runner that throws", async () => {
    const u = new YtDlpUpdater(
      () => Promise.reject(new Error("spawn failed")),
      () => {},
    );
    expect(await u.update(NOW, "nsig")).toBe(false);
  });
});

describe("shouldRetry", () => {
  it("tries again only after an update that worked, for a browser still waiting", () => {
    expect(shouldRetry(true)).toBe(true);
    expect(shouldRetry(true, () => true)).toBe(true);
    expect(shouldRetry(true, () => false)).toBe(false);
    expect(shouldRetry(false, () => true)).toBe(false);
  });
});

describe("YouTubeGuard", () => {
  /** A guard on a fake clock, with a fake updater and health store. */
  function makeGuard(updateOutcomes: boolean[] = []) {
    let now = NOW;
    const record = vi.fn();
    const health = { record } as unknown as Pick<SourceHealthStore, "record">;
    const run = vi.fn(async () => ({ ok: updateOutcomes.shift() ?? false, detail: "done" }));
    const updater = new YtDlpUpdater(run, () => {});
    const log = vi.fn();
    const guard = new YouTubeGuard({
      health,
      now: () => now,
      updater,
      failureText: (err) => (err instanceof Error ? err.message : String(err)),
      log,
    });
    return { guard, record, run, log, tick: (ms: number) => (now += ms) };
  }

  const failing = (message: string) => vi.fn(() => Promise.reject(new Error(message)));

  it("answers a repeat from the cache without asking YouTube", async () => {
    const { guard, record, tick } = makeGuard();
    const attempt = vi.fn(async () => ["result"]);
    expect(await guard.run({ key: "search:x", attempt })).toEqual(["result"]);
    expect(await guard.run({ key: "search:x", attempt })).toEqual(["result"]);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("youtube", true);

    tick(CACHE_TTL_MS);
    await guard.run({ key: "search:x", attempt });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("starts the cooldown when YouTube throttles, and answers 429 until it's over", async () => {
    const { guard, record, log, tick } = makeGuard();
    const attempt = failing("HTTP Error 429: Too Many Requests");
    const err = await guard.run({ key: "search:x", attempt }).catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeLimited);
    expect(err.retryAfterSeconds).toBe(COOLDOWN_MS / 1000);
    expect(err.message).toBe(LIMITED_MESSAGE);
    expect(limitedBody(err)).toEqual({
      message: LIMITED_MESSAGE,
      retryAfterSeconds: 600,
      source: "youtube",
    });
    expect(record).toHaveBeenCalledWith("youtube", false, {
      kind: "throttled",
      note: "HTTP Error 429: Too Many Requests",
    });
    expect(log).toHaveBeenCalledTimes(1);

    // During the cooldown: no yt-dlp run, a 429 that counts down.
    tick(4 * 60_000);
    const again = await guard.run({ key: "search:y", attempt }).catch((e) => e);
    expect(again).toBeInstanceOf(YouTubeLimited);
    expect(again.retryAfterSeconds).toBe(360);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(guard.limited()?.retryAfterSeconds).toBe(360);

    // A cached answer is still served.
    const cached = vi.fn(async () => "cached");
    tick(-4 * 60_000);
    guard.cache.set("search:z", "cached", NOW);
    expect(await guard.run({ key: "search:z", attempt: cached })).toBe("cached");

    // Over: YouTube is asked again.
    tick(COOLDOWN_MS + 1);
    expect(guard.limited()).toBeUndefined();
    const fine = vi.fn(async () => "ok");
    expect(await guard.run({ key: "search:w", attempt: fine })).toBe("ok");
  });

  it("treats a bot check as limiting too — after trying an update", async () => {
    const { guard, run } = makeGuard([false]); // the update can't run (no network)
    const attempt = failing("Sign in to confirm you're not a bot");
    const err = await guard.run({ attempt }).catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeLimited);
    expect(run).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1); // no retry: the update failed
    expect(guard.limited()).toBeDefined();
  });

  it("updates yt-dlp when it looks outdated, and tries the call once more", async () => {
    const { guard, run, record } = makeGuard([true]);
    let calls = 0;
    const attempt = vi.fn(async () => {
      if (calls++ === 0) throw new Error("Unable to extract yt initial data");
      return "fixed";
    });
    expect(await guard.run({ key: "video:abc", attempt })).toBe("fixed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(record.mock.calls).toEqual([
      ["youtube", false, { kind: "error", note: "Unable to extract yt initial data" }],
      ["youtube", true],
    ]);
    expect(guard.limited()).toBeUndefined(); // an outdated yt-dlp isn't YouTube limiting us
  });

  it("doesn't try again for a browser that has gone away, or within the hour", async () => {
    const { guard, run } = makeGuard([true, true]);
    const attempt = failing("Requested format is not available");
    await expect(guard.run({ attempt, stillWanted: () => false })).rejects.toThrow(
      "Requested format is not available",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1);

    // The next failure within the hour: no update, no retry, the error itself.
    await expect(guard.run({ attempt })).rejects.toThrow("Requested format is not available");
    expect(run).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("passes other failures through, and counts an unavailable video as YouTube answering", async () => {
    const { guard, record, run } = makeGuard([true]);
    await expect(guard.run({ attempt: failing("Video unavailable") })).rejects.toThrow(
      "Video unavailable",
    );
    expect(record).toHaveBeenCalledWith("youtube", true);
    await expect(guard.run({ attempt: failing("ffmpeg exited with code 1") })).rejects.toThrow(
      "ffmpeg exited with code 1",
    );
    expect(record).toHaveBeenCalledWith("youtube", false, {
      kind: "error",
      note: "ffmpeg exited with code 1",
    });
    expect(run).not.toHaveBeenCalled();
    expect(guard.limited()).toBeUndefined();
  });

  it("checks the cooldown again after waiting at the gate", async () => {
    const { guard } = makeGuard();
    const gate = guard.gate;
    const release: (() => void)[] = [];
    const slow = () => new Promise<string>((resolve) => release.push(() => resolve("slow")));
    const first = gate(slow);
    const second = gate(slow);
    const attempt = vi.fn(async () => "late");
    // Third: waits its turn — and meanwhile YouTube starts limiting us.
    const waiting = guard.run({ attempt }).catch((e) => e);
    await Promise.resolve();
    expect(gate.waiting).toBe(1);
    guard.cooldown.start(NOW);
    release[0]();
    release[1]();
    await Promise.all([first, second]);
    expect(await waiting).toBeInstanceOf(YouTubeLimited);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("records how an audio pipeline ended, and the 429 to send when YouTube limited it", () => {
    const { guard, record, run } = makeGuard([true]);
    expect(guard.pipelineEnded(true, "")).toBeUndefined();
    expect(record).toHaveBeenLastCalledWith("youtube", true);

    expect(guard.pipelineEnded(false, "ffmpeg exited with code 1")).toBeUndefined();
    expect(guard.limited()).toBeUndefined();
    expect(run).not.toHaveBeenCalled();

    // An outdated yt-dlp: updated for the downloads to come (nothing to retry here).
    expect(guard.pipelineEnded(false, "Requested format is not available")).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);

    const limited = guard.pipelineEnded(false, "HTTP Error 429: Too Many Requests");
    expect(limited).toBeInstanceOf(YouTubeLimited);
    expect(limited?.retryAfterSeconds).toBe(600);
    expect(guard.limited()?.retryAfterSeconds).toBe(600);
    expect(record).toHaveBeenLastCalledWith("youtube", false, {
      kind: "throttled",
      note: "HTTP Error 429: Too Many Requests",
    });
  });

  it("reset() forgets the cooldown, the cache and the last update", async () => {
    const { guard, run } = makeGuard([true, true]);
    guard.cooldown.start(NOW);
    guard.cache.set("k", "v", NOW);
    await guard.updater.update(NOW, "nsig");
    guard.reset();
    expect(guard.limited()).toBeUndefined();
    expect(guard.cache.size).toBe(0);
    expect(await guard.updater.update(NOW, "nsig")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
