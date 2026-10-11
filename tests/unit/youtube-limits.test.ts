import { describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  HEDGE_FOR_MS,
  REFUSED_MESSAGE,
  TtlCache,
  YouTubeGuard,
  YouTubeRefused,
  classifyYtDlpError,
  playlistCacheKey,
  refusedBody,
  searchCacheKey,
  videoCacheKey,
} from "../../server/youtube-limits";
import { UPDATE_EVERY_MS, YtDlpUpdater } from "../../server/yt-dlp-update";
import type { SourceHealthStore } from "../../server/source-health";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

describe("classifyYtDlpError", () => {
  it("knows YouTube limiting the computer: throttled, or a bot check", () => {
    expect(classifyYtDlpError("HTTP Error 429: Too Many Requests")).toBe("throttled");
    expect(classifyYtDlpError("Unable to download webpage: Too Many Requests")).toBe("throttled");
    // How YouTube rate-limits a computer now, and yt-dlp's note about it.
    expect(
      classifyYtDlpError("Video unavailable. This content isn't available, try again later."),
    ).toBe("throttled");
    expect(
      classifyYtDlpError("The current session has been rate-limited by YouTube for up to an hour"),
    ).toBe("throttled");
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

  it("knows a video that can't be had — nothing to update over", () => {
    for (const text of [
      "Video unavailable",
      "Video unavailable. This video has been removed by the uploader",
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
      'yt-dlp: YouTube answered "Unable to extract" — updating yt-dlp in the background; requests after it use the new one.',
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

describe("YouTubeGuard", () => {
  /**
   * A guard on a fake clock, with a fake health store and an updater whose
   * update never finishes — so a call that waited for it would never settle.
   */
  function makeGuard() {
    let now = NOW;
    const record = vi.fn();
    const health = { record } as unknown as Pick<SourceHealthStore, "record">;
    const update = vi.fn(() => new Promise<{ ok: boolean; detail: string }>(() => {}));
    const updater = new YtDlpUpdater(update, () => {});
    const log = vi.fn();
    const guard = new YouTubeGuard({
      health,
      now: () => now,
      updater,
      failureText: (err) => (err instanceof Error ? err.message : String(err)),
      log,
    });
    return { guard, record, update, log, tick: (ms: number) => (now += ms) };
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

  it("turns a refusal into YouTubeRefused at once, and still asks YouTube next time", async () => {
    const { guard, record, log } = makeGuard();
    const refusing = failing("HTTP Error 429: Too Many Requests");
    const err = await guard.run({ key: "search:x", attempt: refusing }).catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeRefused);
    expect(err).toMatchObject({ kind: "throttled", status: 502, message: REFUSED_MESSAGE });
    expect(err.reason).toBe("HTTP Error 429: Too Many Requests");
    expect(refusedBody()).toEqual({ message: REFUSED_MESSAGE, source: "youtube", limited: true });
    expect(record).toHaveBeenCalledWith("youtube", false, {
      kind: "throttled",
      note: "HTTP Error 429: Too Many Requests",
    });
    expect(log).toHaveBeenCalledTimes(1);

    // Nothing is held back: the very next call is made, and its answer used.
    const fine = vi.fn(async () => "ok");
    expect(await guard.run({ key: "search:y", attempt: fine })).toBe("ok");
    expect(fine).toHaveBeenCalledTimes(1);
    // A refusal isn't cached.
    expect(await guard.run({ key: "search:x", attempt: fine })).toBe("ok");
  });

  it("treats a bot check as a refusal too, and starts a background update", async () => {
    const { guard, update, record } = makeGuard();
    const err = await guard
      .run({ attempt: failing("Sign in to confirm you're not a bot") })
      .catch((e) => e);
    expect(err).toBeInstanceOf(YouTubeRefused);
    expect(err.kind).toBe("bot-check");
    expect(update).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("youtube", false, {
      kind: "blocked",
      note: "Sign in to confirm you're not a bot",
    });
  });

  it("never makes a request wait for a yt-dlp update", async () => {
    const { guard, update } = makeGuard();
    // The update never finishes; the failed call is answered anyway…
    const attempt = failing("Unable to extract yt initial data");
    await expect(guard.run({ attempt })).rejects.toThrow("Unable to extract yt initial data");
    expect(update).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1); // …and not tried again
    // …and the next call is made straight away, update or not.
    expect(await guard.run({ attempt: async () => "next" })).toBe("next");
  });

  it("passes other failures through, and counts an unavailable video as YouTube answering", async () => {
    const { guard, record, update } = makeGuard();
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
    expect(update).not.toHaveBeenCalled();
  });

  it("records how an audio stream ended, and says when YouTube refused it", () => {
    const { guard, record, update } = makeGuard();
    expect(guard.pipelineEnded(true, "")).toBeUndefined();
    expect(record).toHaveBeenLastCalledWith("youtube", true);

    expect(guard.pipelineEnded(false, "ffmpeg exited with code 1")).toBeUndefined();
    expect(update).not.toHaveBeenCalled();

    // An outdated yt-dlp: updated for the downloads to come (in the background).
    expect(guard.pipelineEnded(false, "Requested format is not available")).toBeUndefined();
    expect(update).toHaveBeenCalledTimes(1);

    const refused = guard.pipelineEnded(false, "HTTP Error 429: Too Many Requests");
    expect(refused).toBeInstanceOf(YouTubeRefused);
    expect(record).toHaveBeenLastCalledWith("youtube", false, {
      kind: "throttled",
      note: "HTTP Error 429: Too Many Requests",
    });
  });

  it("remembers a refusal for 10 minutes, for searches to hedge, and holds nothing back", async () => {
    const { guard, log, tick } = makeGuard();
    expect(guard.refusedRecently()).toBe(false);
    await guard.run({ attempt: failing("HTTP Error 429: Too Many Requests") }).catch(() => {});
    expect(guard.refusedRecently()).toBe(true);
    expect(log.mock.calls[0][0]).toBe(
      'YouTube is limiting this computer ("HTTP Error 429: Too Many Requests"): for the next 10 minutes, searches ask SoundCloud at the same time.',
    );
    // Calls are still made, and a success changes nothing: YouTube often lets some calls
    // through while it limits a computer.
    expect(await guard.run({ attempt: async () => "ok" })).toBe("ok");
    expect(guard.refusedRecently()).toBe(true);
    // Another refusal within the 10 minutes starts them again, without another log line.
    tick(5 * 60_000);
    await guard.run({ attempt: failing("Sign in to confirm you're not a bot") }).catch(() => {});
    expect(log).toHaveBeenCalledTimes(1);
    tick(HEDGE_FOR_MS - 1);
    expect(guard.refusedRecently()).toBe(true);
    tick(1);
    expect(guard.refusedRecently()).toBe(false);
    // An audio stream YouTube refused counts too.
    guard.pipelineEnded(false, "HTTP Error 429: Too Many Requests");
    expect(guard.refusedRecently()).toBe(true);
    guard.reset();
    expect(guard.refusedRecently()).toBe(false);
  });

  it("says what to do in its refusal, and never to wait for the app", () => {
    expect(REFUSED_MESSAGE).toMatch(/SoundCloud/);
    expect(REFUSED_MESSAGE).not.toMatch(/try again in|wait/i);
  });

  it("reset() forgets the cache and the last update", async () => {
    const run = vi.fn(async () => ({ ok: true, detail: "done" }));
    const guard = new YouTubeGuard({
      health: { record: vi.fn() } as unknown as Pick<SourceHealthStore, "record">,
      updater: new YtDlpUpdater(run, () => {}),
    });
    guard.cache.set("k", "v", Date.now());
    await guard.updater.update(NOW, "nsig");
    guard.reset();
    expect(guard.cache.size).toBe(0);
    expect(await guard.updater.update(NOW, "nsig")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
