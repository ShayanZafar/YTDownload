import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { explainMiss, type CatalogueSong } from "../../server/catalogues";
import {
  LOG_MAX_BYTES,
  downloadEntry,
  logDetails,
  logLine,
  lookupEntry,
  readDetailsLog,
} from "../../server/details-log";
import { songLookupSchema } from "../../shared/schema";

// Why a song was or wasn't filled in: the reasons a look-up gives, and the
// details log they're written to (server/details-log.ts), in a temp folder.

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-details-log-"));
  process.env.DETAILS_LOG_FILE = path.join(dir, "details.log");
});

afterAll(async () => {
  delete process.env.DETAILS_LOG_FILE;
  await fs.rm(dir, { recursive: true, force: true });
});

const song = (title: string, artist: string, duration?: number): CatalogueSong => ({
  title,
  artist,
  duration,
});

describe("explainMiss", () => {
  const search = { track: "Desert Plain", artist: "Vibrasphere" };

  it("says nothing came back, or which answer was closest and what's different", () => {
    expect(explainMiss([], search)).toBe("nothing came back");
    expect(explainMiss([song("Desert Plain", "Someone Else")], search)).toBe(
      "1 answer; closest “Desert Plain” by Someone Else: a different artist",
    );
    expect(
      explainMiss(
        [song("Another Song", "Other"), song("Desert Plain (Live)", "Vibrasphere")],
        search,
      ),
    ).toBe(
      "2 answers; closest “Desert Plain (Live)” by Vibrasphere: a different version, and the song's length isn't known",
    );
    expect(
      explainMiss([song("Desert Rain", "Vibrasphere"), song("Another Song", "Other")], search),
    ).toBe("2 answers; closest “Desert Rain” by Vibrasphere: a different title");
    expect(explainMiss([song("Another Song", "Other")], search)).toBe(
      "1 answer, none with that title or artist (first: “Another Song” by Other)",
    );
  });

  it("for a song with no artist, says how far its length was off", () => {
    expect(
      explainMiss(
        [song("Desert Plain", "Vibrasphere", 470)],
        { track: "Desert Plain", artist: "" },
        44,
      ),
    ).toBe(
      "1 answer; closest “Desert Plain” by Vibrasphere: the song has no artist to check, and it isn't the same length, 426 s longer",
    );
  });
});

describe("the log's lines", () => {
  const lookup = (fields: Record<string, unknown>) =>
    songLookupSchema.parse({
      missing: ["genre", "year"],
      writable: true,
      found: null,
      match: null,
      source: null,
      ...fields,
    });

  it("say when, what, which song and what happened, on one line", () => {
    const at = new Date("2026-10-26T01:44:12.345Z");
    expect(
      logLine(
        {
          kind: "look-up",
          song: "Shy's Tunes/A.mp3",
          outcome: "not found",
          details: ["x\ny", "z"],
        },
        at,
      ),
    ).toBe("2026-10-26 01:44:12  look-up  Shy's Tunes/A.mp3  not found: x y; z");
  });

  it("give each look-up's outcome and its reasons", () => {
    expect(lookupEntry("A.mp3", lookup({ notes: ["iTunes, “A”: nothing came back"] }))).toEqual({
      kind: "look-up",
      song: "A.mp3",
      outcome: "not found",
      details: ["lacks genre, year", "iTunes, “A”: nothing came back"],
    });
    expect(
      lookupEntry(
        "A.mp3",
        lookup({
          found: { genre: "Rock", year: 1987 },
          match: { title: "A", artist: "B", album: null },
          source: "deezer",
        }),
      ).details,
    ).toEqual(["lacks genre, year", "matched “A” by B on Deezer", "genre Rock", "year 1987"]);
    // Another version's genre says so.
    expect(
      lookupEntry(
        "A.mp3",
        lookup({
          found: { genre: "Rock" },
          match: {
            title: "A",
            artist: "B",
            album: null,
            note: "another version of it, for its genre only",
          },
          source: "itunes",
        }),
      ).details,
    ).toEqual([
      "lacks genre, year",
      "matched “A” by B on iTunes (another version of it, for its genre only)",
      "genre Rock",
    ]);
    expect(lookupEntry("A.mp3", lookup({ missing: [] })).outcome).toBe("has every detail already");
    expect(
      lookupEntry("A.mp3", lookup({ writable: false, problem: "it's really an M4A file" })),
    ).toMatchObject({ outcome: "can't be written", details: ["it's really an M4A file"] });
  });

  it("give what a download got, or why it got nothing", () => {
    expect(downloadEntry("Song", { tags: { genre: "Rock" }, cover: Buffer.from("x") })).toEqual({
      kind: "download",
      song: "Song",
      outcome: "added",
      details: ["genre Rock", "cover"],
    });
    expect(downloadEntry("Song", { tags: {}, why: "no answer within 5 s" })).toMatchObject({
      outcome: "nothing added",
      details: ["no answer within 5 s"],
    });
  });
});

describe("the details log", () => {
  it("adds lines in order, even written at once, and reads back the newest", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        logDetails({ kind: "write", song: `Song ${i}.mp3`, outcome: "added" }),
      ),
    );
    const lines = (await readDetailsLog()).split("\n");
    expect(lines).toHaveLength(20);
    expect(lines.map((line) => /Song (\d+)\.mp3/.exec(line)![1])).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i)),
    );
    expect((await readDetailsLog(2)).split("\n")).toEqual(lines.slice(-2));
  });

  it("starts a new file once it's grown past its size, keeping the last one", async () => {
    const file = process.env.DETAILS_LOG_FILE!;
    await fs.writeFile(file, "x".repeat(LOG_MAX_BYTES + 1));
    await logDetails({ kind: "download", song: "New", outcome: "nothing added" });
    expect(await readDetailsLog()).toMatch(/download {2}New {2}nothing added$/);
    expect((await fs.stat(`${file}.1`)).size).toBe(LOG_MAX_BYTES + 1);
  });

  it("never fails, even where it can't be written", async () => {
    const before = process.env.DETAILS_LOG_FILE;
    // A folder where the file should be: appending fails, and nothing else does.
    process.env.DETAILS_LOG_FILE = dir;
    const errors = console.error;
    console.error = () => {};
    try {
      await expect(
        logDetails({ kind: "write", song: "x", outcome: "added" }),
      ).resolves.toBeUndefined();
    } finally {
      console.error = errors;
      process.env.DETAILS_LOG_FILE = before;
    }
  });
});
