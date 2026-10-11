import { describe, expect, it, vi } from "vitest";
import {
  audioLinkOf,
  parseSoundCloudLink,
  soundCloudTrackNumber,
} from "../../shared/soundcloud-link";
import {
  PREVIEW_ONLY,
  isPreview,
  looksLikePreview,
  lookUpSoundCloud,
  recordSoundCloud,
  soundCloudResult,
} from "../../server/soundcloud";
import {
  SearchFailed,
  rankResults,
  searchSongs,
  searchSoundCloud,
  searchSoundCloudOnly,
  soundCloudSearchArgs,
  type RawSearchEntry,
  type SearchDeps,
} from "../../server/search";
import { HEDGE_FOR_MS, TtlCache, YouTubeGuard, YouTubeRefused } from "../../server/youtube-limits";
import { YtDlpUpdater } from "../../server/yt-dlp-update";
import type { SourceHealthStore } from "../../server/source-health";
import type { SearchResult } from "../../shared/schema";

// What `yt-dlp --flat-playlist --dump-single-json --no-warnings -- "scsearch3:daft punk one
// more time"` listed on the owner's PC (Oct 11, 2026), with the app's own yt-dlp and no key:
// the titles, uploader, lengths and the shape of `url` (the track's URN, URL-encoded) are the
// probe's; the first track is a 30-second preview. Only track 254112129's number is the
// probe's — the other two are made up — and `id` isn't relied on being a number.
const urn = (n: string) => `https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A${n}`;
const PROBE: RawSearchEntry[] = [
  {
    id: "soundcloud:tracks:254112129",
    title: "One More Time",
    uploader: "Daft Punk",
    duration: 30.0,
    url: urn("254112129"),
  },
  {
    id: "soundcloud:tracks:300000001",
    title: "One More Time",
    uploader: "Daft Punk",
    duration: 322.606,
    url: urn("300000001"),
  },
  {
    id: "soundcloud:tracks:300000002",
    title: "One More Time",
    uploader: "Daft Punk",
    duration: 320.403,
    url: urn("300000002"),
  },
];
const CANONICAL = "https://api.soundcloud.com/tracks/254112129";

describe("parseSoundCloudLink", () => {
  it("turns the URN form yt-dlp lists into the one canonical track link", () => {
    expect(parseSoundCloudLink(urn("254112129"))).toBe(CANONICAL);
    expect(parseSoundCloudLink(CANONICAL)).toBe(CANONICAL);
    // The same colon in either case of its hex: still the same track.
    expect(
      parseSoundCloudLink("https://api.soundcloud.com/tracks/soundcloud%3atracks%3a254112129"),
    ).toBe(CANONICAL);
    expect(soundCloudTrackNumber(urn("254112129"))).toBe("254112129");
  });

  it("turns down look-alike hosts", () => {
    for (const link of [
      "https://api.soundcloud.com.evil.example/tracks/254112129",
      "https://soundcloud.com.evil.example/daftpunk/one-more-time",
      "https://evil.example/soundcloud.com/daftpunk/one-more-time",
      "https://evil.example/api.soundcloud.com/tracks/254112129",
      "https://evil.example/?https://api.soundcloud.com/tracks/254112129",
      "https://api.soundcloud.com@evil.example/tracks/254112129",
      "https://api-soundcloud.com/tracks/254112129",
      "https://apisoundcloud.com/tracks/254112129",
      "https://api.soundcloud.co/tracks/254112129",
      "https://xapi.soundcloud.com/tracks/254112129",
      "https://api.soundcloud.com./tracks/254112129", // a trailing dot
      "https://API.SOUNDCLOUD.COM/tracks/254112129",
      "https://api.soundcloud.com\\@evil.example/tracks/254112129",
    ]) {
      expect(parseSoundCloudLink(link), link).toBeNull();
    }
  });

  it("turns down credentials, ports, http: and other schemes", () => {
    for (const link of [
      "https://user:password@api.soundcloud.com/tracks/254112129",
      "https://user@api.soundcloud.com/tracks/254112129",
      "https://api.soundcloud.com:443/tracks/254112129",
      "https://api.soundcloud.com:8080/tracks/254112129",
      "http://api.soundcloud.com/tracks/254112129",
      "//api.soundcloud.com/tracks/254112129",
      "api.soundcloud.com/tracks/254112129",
      "ftp://api.soundcloud.com/tracks/254112129",
      "file:///api.soundcloud.com/tracks/254112129",
      "javascript:alert(1)//api.soundcloud.com/tracks/254112129",
      "https:/api.soundcloud.com/tracks/254112129",
      "https:\\\\api.soundcloud.com\\tracks\\254112129",
    ]) {
      expect(parseSoundCloudLink(link), link).toBeNull();
    }
  });

  it("turns down sets, playlists, users' pages and anything but one track", () => {
    for (const link of [
      "https://soundcloud.com/daftpunkofficialmusic/one-more-time", // a track's page: not canonical
      "https://soundcloud.com/daftpunkofficialmusic/sets/discovery",
      "https://soundcloud.com/daftpunkofficialmusic",
      "https://soundcloud.com/daftpunkofficialmusic/tracks",
      "https://soundcloud.com/daftpunkofficialmusic/likes",
      "https://api.soundcloud.com/playlists/254112129",
      "https://api.soundcloud.com/users/254112129",
      "https://api.soundcloud.com/tracks/254112129/comments",
      "https://api.soundcloud.com/tracks/254112129/",
      "https://api.soundcloud.com/tracks/",
      "https://api.soundcloud.com/tracks/0",
      "https://api.soundcloud.com/tracks/0254112129", // a leading zero: not the one canonical link
      `https://api.soundcloud.com/tracks/${"9".repeat(21)}`,
      "https://api.soundcloud.com/tracks/254112129?secret_token=s-abcde", // a private track
      "https://api.soundcloud.com/tracks/254112129#t=1:00",
      "https://api-v2.soundcloud.com/tracks/254112129",
      "https://w.soundcloud.com/player/?url=https://api.soundcloud.com/tracks/254112129",
      "scsearch1:daft punk",
      "",
    ]) {
      expect(parseSoundCloudLink(link), link).toBeNull();
    }
  });

  it("turns down odd encodings", () => {
    for (const link of [
      "https://api.soundcloud.com/tracks/soundcloud:tracks:254112129", // not encoded
      "https://api.soundcloud.com/tracks/soundcloud%253Atracks%253A254112129", // twice
      "https://api.soundcloud.com/tracks%2F254112129",
      "https://api.soundcloud.com/tracks/%32%35%34%31%31%32%31%32%39",
      "https://api.soundcloud.com/tracks/soundcloud%3Aplaylists%3A254112129",
      "https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A",
      "https://api.soundcloud.com/tracks/254112129%00",
      "https://api.soundcloud.com/tracks/254112129%0A",
      "https://api.soundcloud.com/tracks/254112129\n",
      "https://api.soundcloud.com/tracks/254112129\u0000",
      " https://api.soundcloud.com/tracks/254112129",
      "https://api.soundcloud.com/tracks/254112129 ",
      "https://api.soundcloud.com/tracks/２５４１１２１２９", // full-width digits
      "https://api.soundcloud.com/tracks/٢٥٤١١٢١٢٩", // Arabic-Indic digits
      "https://api.soundcloud.com/tracks/254112129​",
      "https://api.soundcloud.com/%74racks/254112129",
      "https://api.soundcloud.com/./tracks/254112129",
      "https://api.soundcloud.com/x/../tracks/254112129",
      "https://api%2Esoundcloud.com/tracks/254112129",
    ]) {
      expect(parseSoundCloudLink(link), JSON.stringify(link)).toBeNull();
    }
  });

  it("turns down what isn't text", () => {
    for (const value of [undefined, null, 254112129, {}, ["https://api.soundcloud.com/tracks/1"]]) {
      expect(parseSoundCloudLink(value)).toBeNull();
    }
  });
});

describe("audioLinkOf", () => {
  it("gives a YouTube video's canonical watch link, built from its id", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
      // Whatever else the link carries never reaches yt-dlp: only the id does.
      "https://user:password@www.youtube.com/watch?v=dQw4w9WgXcQ",
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ&x=--exec",
    ]) {
      expect(audioLinkOf(link), link).toEqual({
        source: "youtube",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        videoId: "dQw4w9WgXcQ",
      });
    }
  });

  it("gives a SoundCloud track's canonical link", () => {
    expect(audioLinkOf(urn("254112129"))).toEqual({ source: "soundcloud", url: CANONICAL });
    expect(audioLinkOf(CANONICAL)).toEqual({ source: "soundcloud", url: CANONICAL });
  });

  it("only ever gives one of the two canonical shapes, whatever it's handed", () => {
    const hostile = [
      "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
      "https://evil.example/www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://soundcloud.com.evil.example/a/b",
      "https://user@api.soundcloud.com/tracks/1",
      "--exec=calc",
      "-o /etc/passwd",
      "ytsearch1:daft punk",
      "https://www.youtube.com/playlist?list=PL123",
      "file:///etc/passwd",
      "https://example.com/watch?v=dQw4w9WgXcQ",
      urn("254112129"),
      "https://youtu.be/dQw4w9WgXcQ",
    ];
    const canonical =
      /^(?:https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}|https:\/\/api\.soundcloud\.com\/tracks\/[1-9][0-9]{0,19})$/;
    for (const link of hostile) {
      const audio = audioLinkOf(link);
      if (audio) expect(audio.url, link).toMatch(canonical);
    }
    expect(hostile.map((link) => audioLinkOf(link)?.source ?? null)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "soundcloud",
      "youtube",
    ]);
  });
});

describe("soundCloudResult", () => {
  it("makes the probe's entries into results with canonical links", () => {
    expect(PROBE.map(soundCloudResult)).toEqual([
      {
        id: "soundcloud:tracks:254112129",
        url: CANONICAL,
        title: "One More Time",
        channel: "Daft Punk",
        duration: 30,
        thumbnail: "",
        official: false,
        source: "soundcloud",
      },
      expect.objectContaining({
        url: "https://api.soundcloud.com/tracks/300000001",
        duration: 323,
        source: "soundcloud",
      }),
      expect.objectContaining({
        url: "https://api.soundcloud.com/tracks/300000002",
        duration: 320,
        source: "soundcloud",
      }),
    ]);
    // And the link it gives is one a download accepts.
    for (const entry of PROBE) {
      expect(audioLinkOf(soundCloudResult(entry)!.url)?.source).toBe("soundcloud");
    }
  });

  it("uses a plain track number in `id` when `url` isn't usable, else leaves the entry out", () => {
    expect(soundCloudResult({ id: 254112129, title: "One More Time" })?.url).toBe(CANONICAL);
    expect(soundCloudResult({ id: "254112129", url: null })?.url).toBe(CANONICAL);
    expect(soundCloudResult({ id: "soundcloud:tracks:254112129" })).toBeUndefined();
    expect(soundCloudResult({ url: "https://evil.example/tracks/1", id: "x" })).toBeUndefined();
    expect(soundCloudResult({ url: "https://soundcloud.com/a/sets/b" })).toBeUndefined();
  });

  it("takes artwork from SoundCloud's image host only, about 300 px wide", () => {
    const thumbnails = [
      { url: "https://i1.sndcdn.com/artworks-abc-tiny.jpg", width: 20 },
      { url: "https://i1.sndcdn.com/artworks-abc-t300x300.jpg", width: 300 },
      { url: "https://i1.sndcdn.com/artworks-abc-t500x500.jpg", width: 500 },
      { url: "https://evil.example/artworks-abc-t300x300.jpg", width: 300 },
    ];
    expect(soundCloudResult({ ...PROBE[1], thumbnails })?.thumbnail).toBe(
      "https://i1.sndcdn.com/artworks-abc-t300x300.jpg",
    );
    expect(
      soundCloudResult({ ...PROBE[1], thumbnails: [thumbnails[3]], thumbnail: "javascript:x" })
        ?.thumbnail,
    ).toBe("");
  });
});

describe("SoundCloud's 30-second previews", () => {
  it("are ranked last among SoundCloud's results, though listed first", () => {
    const ranked = rankResults("daft punk one more time", PROBE, {
      toResult: soundCloudResult,
      last: looksLikePreview,
    });
    expect(ranked.map((r) => r.duration)).toEqual([323, 320, 30]);
    // With the song's length known (a Spotify song's: 5:16, say), the same-length one comes
    // first — and the preview stays last, even for a 30-second song.
    const forSpotify = rankResults("daft punk one more time", PROBE, {
      toResult: soundCloudResult,
      last: looksLikePreview,
      targetDuration: 316,
    });
    expect(forSpotify.map((r) => r.duration)).toEqual([320, 323, 30]);
    const forShortSong = rankResults("daft punk one more time", PROBE, {
      toResult: soundCloudResult,
      last: looksLikePreview,
      targetDuration: 30,
    });
    expect(forShortSong.map((r) => r.duration)).toEqual([323, 320, 30]);
  });

  it("look like a 30-second track in a search", () => {
    expect(looksLikePreview(PROBE[0])).toBe(true);
    expect(looksLikePreview(PROBE[1])).toBe(false);
    expect(looksLikePreview({ duration: null })).toBe(false);
  });

  it("are known by yt-dlp's format id", () => {
    expect(isPreview({ formatId: "http_mp3_1_0_preview" })).toBe(true);
    expect(isPreview({ formatId: "hls_opus_0_0_preview" })).toBe(true);
    expect(isPreview({ formatId: "http_mp3_1_0" })).toBe(false);
    expect(isPreview({ formatId: "hls_aac_160k" })).toBe(false);
    expect(isPreview({})).toBe(false);
  });

  it("are refused by the look-up before a download: SoundCloud answered, but nothing is saved", async () => {
    const record = vi.fn();
    const health = { record } as unknown as Pick<SourceHealthStore, "record">;
    const preview = vi.fn(async () => ({
      title: "One More Time",
      artist: "Daft Punk",
      formatId: "http_mp3_1_0_preview",
      acodec: "mp3",
    }));
    await expect(lookUpSoundCloud(CANONICAL, { lookUp: preview, health })).rejects.toThrow(
      PREVIEW_ONLY,
    );
    expect(preview).toHaveBeenCalledWith(CANONICAL);
    expect(record).toHaveBeenLastCalledWith("soundcloud", true);

    const full = vi.fn(async () => ({ title: "One More Time", formatId: "http_mp3_1_0" }));
    expect(await lookUpSoundCloud(CANONICAL, { lookUp: full, health })).toEqual({
      title: "One More Time",
      formatId: "http_mp3_1_0",
    });

    const failing = vi.fn(async () => {
      throw new Error("HTTP Error 404: Not Found");
    });
    await expect(lookUpSoundCloud(CANONICAL, { lookUp: failing, health })).rejects.toThrow("404");
    expect(record).toHaveBeenLastCalledWith("soundcloud", false, {
      kind: "error",
      note: "HTTP Error 404: Not Found",
    });
  });
});

describe("recordSoundCloud", () => {
  it("records successes, and failures by kind", () => {
    const record = vi.fn();
    const health = { record } as unknown as Pick<SourceHealthStore, "record">;
    recordSoundCloud(true, "", health);
    recordSoundCloud(false, "HTTP Error 429: Too Many Requests", health);
    recordSoundCloud(false, "HTTP Error 500: Internal Server Error", health);
    recordSoundCloud(false, "Video unavailable", health); // gone: SoundCloud answered properly
    expect(record.mock.calls).toEqual([
      ["soundcloud", true],
      ["soundcloud", false, { kind: "throttled", note: "HTTP Error 429: Too Many Requests" }],
      ["soundcloud", false, { kind: "error", note: "HTTP Error 500: Internal Server Error" }],
      ["soundcloud", true],
    ]);
  });
});

// --- Searching: SoundCloud on its own, and as YouTube's fallback -----------------------------

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const youtubeEntry = (id: string, title = "Daft Punk - One More Time (Official Audio)") => ({
  id,
  title,
  duration: 321,
  channel: "Daft Punk",
  channel_is_verified: true,
});

/** A promise to settle by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isYouTubeSearch = (args: string[]) => args.at(-1)!.startsWith("ytsearch");

/**
 * A search's world on a fake clock: the real guard (with a fake health store and an updater
 * that never runs), and `run` standing in for yt-dlp.
 */
function world(run: (args: string[]) => Promise<unknown>) {
  let now = NOW;
  const record = vi.fn();
  const health = { record } as unknown as Pick<SourceHealthStore, "record">;
  const guard = new YouTubeGuard({
    health,
    now: () => now,
    updater: new YtDlpUpdater(
      () => new Promise(() => {}),
      () => {},
    ),
    failureText: (err) => (err instanceof Error ? err.message : String(err)),
    log: () => {},
  });
  const runSpy = vi.fn(run);
  const deps: SearchDeps = {
    guard,
    run: runSpy,
    health,
    soundCloudCache: new TtlCache<SearchResult[]>(),
    now: () => now,
  };
  /** YouTube refuses a call (any call): searches hedge for the next 10 minutes. */
  const youtubeRefuses = () =>
    guard
      .run({ attempt: () => Promise.reject(new Error("HTTP Error 429: Too Many Requests")) })
      .catch(() => {});
  return { deps, guard, run: runSpy, record, youtubeRefuses, tick: (ms: number) => (now += ms) };
}

describe("searchSoundCloud", () => {
  it("lists tracks with scsearch, the query after --, and caches the answer", async () => {
    const { deps, run, record } = world(async () => ({ entries: PROBE }));
    const results = await searchSoundCloud("daft punk one more time", {}, deps);
    expect(run).toHaveBeenCalledWith([
      "--flat-playlist",
      "--dump-single-json",
      "--no-warnings",
      "--",
      "scsearch12:daft punk one more time",
    ]);
    expect(soundCloudSearchArgs("--exec x")).toContain("scsearch12:--exec x");
    expect(results.map((r) => r.url)).toEqual([
      "https://api.soundcloud.com/tracks/300000001",
      "https://api.soundcloud.com/tracks/300000002",
      CANONICAL, // the preview, last
    ]);
    expect(record).toHaveBeenCalledWith("soundcloud", true);
    expect(await searchSoundCloud("Daft  Punk one more time", {}, deps)).toBe(results);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("records a failure, and passes it on", async () => {
    const { deps, record } = world(async () => {
      throw new Error("ERROR: [soundcloud:search] x: HTTP Error 403: Forbidden");
    });
    await expect(searchSoundCloud("x", {}, deps)).rejects.toThrow("403");
    expect(record).toHaveBeenCalledWith("soundcloud", false, {
      kind: "error",
      note: "HTTP Error 403: Forbidden",
    });
  });
});

describe("searchSongs: YouTube first, SoundCloud never later than it has to be", () => {
  it("answers with YouTube's results, without asking SoundCloud, while YouTube is fine", async () => {
    const { deps, run } = world(async (args) =>
      isYouTubeSearch(args) ? { entries: [youtubeEntry("aaaaaaaaaaa")] } : { entries: PROBE },
    );
    const answer = await searchSongs("daft punk one more time", {}, deps);
    expect(answer.source).toBe("youtube");
    expect(answer.results.map((r) => [r.id, r.source])).toEqual([["aaaaaaaaaaa", "youtube"]]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("asks SoundCloud at once when YouTube's search fails or finds nothing", async () => {
    vi.useFakeTimers(); // anything that waited on a timer would never finish
    try {
      for (const youtube of [
        () => Promise.reject(new Error("Unable to extract yt initial data")),
        () => Promise.resolve({ entries: [] }),
      ]) {
        const { deps, run } = world((args) =>
          isYouTubeSearch(args) ? youtube() : Promise.resolve({ entries: PROBE }),
        );
        const answer = await searchSongs("daft punk one more time", {}, deps);
        expect(answer.source).toBe("soundcloud");
        expect(answer.results.map((r) => r.source)).toEqual([
          "soundcloud",
          "soundcloud",
          "soundcloud",
        ]);
        expect(run).toHaveBeenCalledTimes(2);
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps YouTube's empty answer when SoundCloud finds nothing or fails too", async () => {
    for (const soundCloud of [
      () => Promise.resolve({ entries: [] }),
      () => Promise.reject(new Error("HTTP Error 500")),
    ]) {
      const { deps } = world((args) =>
        isYouTubeSearch(args) ? Promise.resolve({ entries: [] }) : soundCloud(),
      );
      expect(await searchSongs("zzzz", {}, deps)).toEqual({ results: [], source: "youtube" });
    }
  });

  it("asks SoundCloud at the same time as YouTube while YouTube has refused in the last 10 minutes", async () => {
    const youtube = deferred<unknown>();
    const soundCloud = deferred<unknown>();
    const { deps, run, youtubeRefuses } = world((args) =>
      isYouTubeSearch(args) ? youtube.promise : soundCloud.promise,
    );
    await youtubeRefuses();

    const answer = searchSongs("daft punk one more time", {}, deps);
    // Both are on their way before either has answered.
    expect(run.mock.calls.map(([args]) => args.at(-1))).toEqual([
      "scsearch12:daft punk one more time",
      "ytsearch12:daft punk one more time",
    ]);
    soundCloud.resolve({ entries: PROBE });
    youtube.resolve({ entries: [youtubeEntry("aaaaaaaaaaa")] });
    // YouTube answered with results: those are the answer.
    expect(await answer).toMatchObject({ source: "youtube", results: [{ id: "aaaaaaaaaaa" }] });
  });

  it("…and SoundCloud's results are the answer the moment YouTube refuses again", async () => {
    const { deps, run, youtubeRefuses } = world(async (args) => {
      if (isYouTubeSearch(args)) throw new Error("Sign in to confirm you're not a bot");
      return { entries: PROBE };
    });
    await youtubeRefuses();
    const answer = await searchSongs("daft punk one more time", {}, deps);
    expect(answer.source).toBe("soundcloud");
    expect(answer.results[0].url).toBe("https://api.soundcloud.com/tracks/300000001");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("stops hedging 10 minutes after YouTube last refused", async () => {
    const { deps, run, youtubeRefuses, tick, guard } = world(async (args) =>
      isYouTubeSearch(args) ? { entries: [youtubeEntry("aaaaaaaaaaa")] } : { entries: PROBE },
    );
    await youtubeRefuses();
    expect(guard.refusedRecently()).toBe(true);
    tick(HEDGE_FOR_MS);
    expect(guard.refusedRecently()).toBe(false);
    await searchSongs("daft punk one more time", {}, deps);
    expect(run).toHaveBeenCalledTimes(1); // YouTube only
  });

  it("asks SoundCloud for its own query (a Spotify song's search drops “audio”)", async () => {
    const { deps, run } = world(async (args) =>
      isYouTubeSearch(args) ? { entries: [] } : { entries: PROBE },
    );
    await searchSongs(
      "Daft Punk One More Time audio",
      { soundCloudQuery: "Daft Punk One More Time", targetDuration: 320 },
      deps,
    );
    expect(run.mock.calls.map(([args]) => args.at(-1))).toEqual([
      "ytsearch12:Daft Punk One More Time audio",
      "scsearch12:Daft Punk One More Time",
    ]);
  });

  it("says what happened when neither can be searched, without telling you to wait for us", async () => {
    const refused = world(async (args) => {
      throw new Error(isYouTubeSearch(args) ? "HTTP Error 429: Too Many Requests" : "HTTP 503");
    });
    const err = await searchSongs("x", {}, refused.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SearchFailed);
    expect(err).toMatchObject({ status: 502, limited: true });
    expect((err as Error).message).toMatch(/YouTube is refusing this computer/);
    expect((err as Error).message).toMatch(/SoundCloud couldn't be searched either \(HTTP 503\)/);
    expect((err as Error).message).not.toMatch(/try again in/i);
    expect((err as Error & { cause: unknown }).cause).toBeInstanceOf(YouTubeRefused);

    const broken = world(async (args) => {
      throw new Error(isYouTubeSearch(args) ? "Unable to extract yt initial data" : "HTTP 503");
    });
    const other = await searchSongs("x", {}, broken.deps).catch((e: unknown) => e);
    expect(other).toMatchObject({ status: 502, limited: false });
    expect((other as Error).message).toBe(
      "Couldn't search YouTube (Unable to extract yt initial data) or SoundCloud (HTTP 503). Check the internet connection, then search again.",
    );
  });
});

describe("searchSoundCloudOnly", () => {
  it("never asks YouTube: for a song YouTube refused to hand over", async () => {
    const { deps, run } = world(async () => ({ entries: PROBE }));
    const answer = await searchSoundCloudOnly("daft punk one more time", {}, deps);
    expect(answer.source).toBe("soundcloud");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].at(-1)).toBe("scsearch12:daft punk one more time");
  });

  it("says why when SoundCloud can't be searched", async () => {
    const { deps } = world(async () => {
      throw new Error("HTTP Error 503: Service Unavailable");
    });
    await expect(searchSoundCloudOnly("x", {}, deps)).rejects.toThrow(
      "Couldn't search SoundCloud (HTTP Error 503: Service Unavailable). Check the internet connection, then search again.",
    );
  });
});
