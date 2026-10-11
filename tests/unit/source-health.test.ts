import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  MAX_EVENTS,
  MIN_ATTEMPTS,
  SOURCES,
  SourceHealthStore,
  WINDOW_MS,
  anyJobUnreliable,
  buildReport,
  cleanNote,
  isUnreliable,
  pruneEvents,
  sourceHealthFilePath,
  summarySentence,
  type HealthEvent,
  type SourceName,
} from "../../server/source-health";
import { sourceHealthReportSchema, type SourceHealth } from "../../shared/schema";

// A fixed "now", and events placed relative to it.
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

const event = (
  source: SourceName,
  ok: boolean,
  t = NOW,
  failure: Pick<HealthEvent, "kind" | "note"> = {},
): HealthEvent => ({ t, source, ok, ...(ok ? {} : { kind: "error", ...failure }) });

/** `ok` successes and `failed` failures of `source`, a minute apart, ending now. */
const attempts = (source: SourceName, ok: number, failed: number, note?: string) => [
  ...Array.from({ length: ok }, (_, i) => event(source, true, minutesAgo(failed + ok - i))),
  ...Array.from({ length: failed }, (_, i) =>
    event(source, false, minutesAgo(failed - i), { kind: "throttled", note }),
  ),
];

const healthOf = (ok: number, failed: number): SourceHealth => ({
  role: "primary",
  for: "audio",
  ok,
  failed,
  throttled: 0,
  lastOk: null,
  lastError: null,
});

describe("isUnreliable", () => {
  it("needs enough attempts, and under half of them succeeding", () => {
    expect(isUnreliable(healthOf(0, 0))).toBe(false);
    expect(isUnreliable(healthOf(0, MIN_ATTEMPTS - 1))).toBe(false); // too few to judge
    expect(isUnreliable(healthOf(0, MIN_ATTEMPTS))).toBe(true);
    expect(isUnreliable(healthOf(2, 3))).toBe(true); // 40 %
    expect(isUnreliable(healthOf(5, 5))).toBe(false); // exactly half is not "under half"
    expect(isUnreliable(healthOf(18, 2))).toBe(false);
  });
});

describe("buildReport", () => {
  it("counts each source's attempts in the last 24 hours, with its last success and error", () => {
    const events = [
      ...attempts("youtube", 18, 2, "HTTP Error 429: Too Many Requests"),
      event("spotify", true, minutesAgo(30)),
      event("spotify", false, minutesAgo(20), { kind: "error", note: "HTTP 503" }),
      event("spotify", true, minutesAgo(10)),
    ];
    const report = buildReport(events, NOW);

    expect(sourceHealthReportSchema.safeParse(report).success).toBe(true);
    expect(report.updatedAt).toBe(new Date(NOW).toISOString());
    expect(report.sources.youtube).toEqual({
      role: "primary",
      for: "audio",
      ok: 18,
      failed: 2,
      throttled: 2,
      lastOk: new Date(minutesAgo(3)).toISOString(),
      lastError: "HTTP Error 429: Too Many Requests",
    });
    expect(report.sources.spotify).toMatchObject({
      role: "primary",
      for: "song details",
      ok: 2,
      failed: 1,
      throttled: 0,
      lastOk: new Date(minutesAgo(10)).toISOString(),
      lastError: "HTTP 503",
    });
    // Every source is listed, asked anything or not.
    expect(report.sources["spotify-oembed"]).toEqual({
      role: "fallback",
      for: "song details",
      ok: 0,
      failed: 0,
      throttled: 0,
      lastOk: null,
      lastError: null,
    });
    expect(report.unreliable).toBe(false);
    expect(report.summary).toBe("All sources healthy.");
  });

  it("leaves out events older than 24 hours", () => {
    const events = [
      event("youtube", false, NOW - WINDOW_MS - 1, { note: "old" }),
      event("youtube", false, NOW - WINDOW_MS + 1, { note: "just in time" }),
      event("youtube", true),
    ];
    expect(buildReport(events, NOW).sources.youtube).toMatchObject({
      ok: 1,
      failed: 1,
      lastError: "just in time",
    });
  });

  it("names an unreliable source, with its counts and last error", () => {
    const report = buildReport(attempts("youtube", 2, 18, "HTTP Error 429"), NOW);
    expect(report.unreliable).toBe(true);
    expect(report.summary).toBe(
      "YouTube: 2 of 20 requests succeeded in the last 24 h (last error: HTTP Error 429).",
    );
  });
});

describe("anyJobUnreliable", () => {
  const sources = (
    health: Partial<Record<SourceName, [ok: number, failed: number]>>,
  ): Record<SourceName, SourceHealth> =>
    Object.fromEntries(
      (Object.keys(SOURCES) as SourceName[]).map((name) => {
        const [ok, failed] = health[name] ?? [0, 0];
        return [
          name,
          { ...healthOf(ok, failed), role: SOURCES[name].role, for: SOURCES[name].for },
        ];
      }),
    ) as Record<SourceName, SourceHealth>;

  it("is true when a primary with no fallback is unreliable (YouTube, for audio)", () => {
    expect(anyJobUnreliable(sources({ youtube: [1, 9] }))).toBe(true);
    expect(anyJobUnreliable(sources({ youtube: [9, 1] }))).toBe(false);
  });

  it("is false while a fallback stands in for an unreliable primary", () => {
    // Spotify's embed page is failing, but the oEmbed fallback is answering.
    expect(anyJobUnreliable(sources({ spotify: [0, 10], "spotify-oembed": [10, 0] }))).toBe(false);
    // The fallback hasn't been asked enough to be called unreliable either.
    expect(anyJobUnreliable(sources({ spotify: [0, 10], "spotify-oembed": [1, 2] }))).toBe(false);
  });

  it("is true when the primary and every fallback are unreliable", () => {
    expect(anyJobUnreliable(sources({ spotify: [0, 10], "spotify-oembed": [2, 8] }))).toBe(true);
  });

  it("ignores an unreliable fallback while the primary is fine", () => {
    expect(anyJobUnreliable(sources({ spotify: [10, 0], "spotify-oembed": [0, 5] }))).toBe(false);
  });

  it("names every unreliable source in the summary", () => {
    const summary = summarySentence(
      sources({ youtube: [0, 5], spotify: [1, 6], "spotify-oembed": [0, 5] }),
    );
    expect(summary).toBe(
      "YouTube: 0 of 5 requests succeeded in the last 24 h; Spotify: 1 of 7 requests succeeded in the last 24 h; Spotify oEmbed: 0 of 5 requests succeeded in the last 24 h.",
    );
  });
});

describe("pruneEvents", () => {
  it(`keeps the newest ${MAX_EVENTS} of the last 24 hours, oldest first`, () => {
    const events = Array.from({ length: MAX_EVENTS + 50 }, (_, i) =>
      event("youtube", true, NOW - (MAX_EVENTS + 50 - i) * 1000),
    );
    const kept = pruneEvents([event("youtube", true, NOW - WINDOW_MS - 1), ...events], NOW);
    expect(kept).toHaveLength(MAX_EVENTS);
    expect(kept[0].t).toBe(NOW - MAX_EVENTS * 1000);
    expect(kept.at(-1)?.t).toBe(NOW - 1000);
  });
});

describe("cleanNote", () => {
  it("keeps an error line to one line, without file paths", () => {
    expect(cleanNote("  HTTP Error 429:\n Too Many Requests ")).toBe(
      "HTTP Error 429: Too Many Requests",
    );
    expect(
      cleanNote("spawn C:\\Users\\me\\app\\node_modules\\youtube-dl-exec\\bin\\yt-dlp.exe ENOENT"),
    ).toBe("spawn yt-dlp.exe ENOENT");
    expect(cleanNote("spawn /home/me/app/node_modules/youtube-dl-exec/bin/yt-dlp ENOENT")).toBe(
      "spawn yt-dlp ENOENT",
    );
    expect(cleanNote("couldn't open \\\\server\\share\\yt-dlp.exe")).toBe(
      "couldn't open yt-dlp.exe",
    );
    // A URL isn't a path, and neither is a slash inside a word.
    expect(cleanNote("https://www.youtube.com/watch?v=abc: HTTP Error 403")).toBe(
      "https://www.youtube.com/watch?v=abc: HTTP Error 403",
    );
    expect(cleanNote("yt-dlp/ffmpeg exited with code 1")).toBe("yt-dlp/ffmpeg exited with code 1");
  });

  it("cuts a long note short", () => {
    const note = cleanNote("x".repeat(500));
    expect(note).toHaveLength(200);
    expect(note.endsWith("…")).toBe(true);
  });
});

describe("SourceHealthStore", () => {
  let dir: string;
  let file: string;
  let now: number;
  let store: SourceHealthStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-source-health-"));
    file = path.join(dir, "nested", "source-health.json"); // folder doesn't exist yet
    now = NOW;
    store = new SourceHealthStore({ file: () => file, now: () => now, writeEveryMs: 50 });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const readFile = async () =>
    sourceHealthReportSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));

  it("records attempts and reports them", () => {
    store.record("youtube", true);
    now += 1000;
    store.record("youtube", false, { kind: "throttled", note: "HTTP Error 429" });
    store.record("spotify", false, { note: "HTTP 503" });
    const report = store.report();
    expect(report.sources.youtube).toMatchObject({ ok: 1, failed: 1, throttled: 1 });
    expect(report.sources.youtube.lastError).toBe("HTTP Error 429");
    expect(report.sources.spotify).toMatchObject({
      ok: 0,
      failed: 1,
      throttled: 0,
      lastError: "HTTP 503",
    });
  });

  it("writes the report file (making its folder), and folds bursts into one write", async () => {
    for (let i = 0; i < 20; i++) store.record("youtube", i % 2 === 0);
    await store.flush();
    expect(await readFile()).toMatchObject({
      sources: { youtube: { ok: 10, failed: 10 } },
      unreliable: false,
    });
    // Nothing left behind from the write.
    expect(await fs.readdir(path.dirname(file))).toEqual(["source-health.json"]);
  });

  it("writes by itself soon after a record, without being flushed", async () => {
    store.record("spotify", true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await readFile()).sources.spotify.ok).toBe(1);
  });

  it("forgets events older than 24 hours as time passes", () => {
    store.record("youtube", false, { note: "old" });
    now += WINDOW_MS + 1;
    expect(store.report().sources.youtube).toMatchObject({ ok: 0, failed: 0, lastError: null });
  });

  it("is written where SOURCE_HEALTH_FILE says, else next to the history", () => {
    const before = process.env.SOURCE_HEALTH_FILE;
    try {
      process.env.SOURCE_HEALTH_FILE = path.join(dir, "elsewhere.json");
      expect(sourceHealthFilePath()).toBe(path.join(dir, "elsewhere.json"));
      delete process.env.SOURCE_HEALTH_FILE;
      expect(sourceHealthFilePath()).toBe(path.resolve("data", "source-health.json"));
    } finally {
      if (before === undefined) delete process.env.SOURCE_HEALTH_FILE;
      else process.env.SOURCE_HEALTH_FILE = before;
    }
  });
});
