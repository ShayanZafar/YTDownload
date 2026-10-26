import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "stream";
import { prepareAudioOutput, withPrefix } from "../../server/audio";
import type { CatalogueMatch } from "../../server/catalogues";
import { catalogueTagsFor, lateDetails, lookUpDownload } from "../../server/download-details";

// A download's details from the music catalogues (server/download-details.ts),
// with the catalogues played by stand-ins: what's added, and that a look-up
// that fails, finds nothing or is slow never holds up or breaks the download.

const match = (song: Partial<CatalogueMatch["song"]>): CatalogueMatch => ({
  source: "itunes",
  song: { title: "Tone", artist: "Test", ...song },
});
const FOUND = match({
  album: "Pure Tones",
  genre: "Electronic",
  year: 1999,
  track: 4,
  coverUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg",
});

/** The text frames of an ID3v2.3 tag (all Latin-1 here), by id. */
function frames(tag: Buffer): Record<string, string> {
  const found: Record<string, string> = {};
  let at = 10;
  while (at + 10 <= tag.length && tag[at] !== 0) {
    const id = tag.toString("latin1", at, at + 4);
    const size = tag.readUInt32BE(at + 4);
    if (id.startsWith("T")) found[id] = tag.toString("latin1", at + 11, at + 10 + size);
    at += 10 + size;
  }
  return found;
}

describe("catalogueTagsFor", () => {
  it("adds the genre, and the album, year and track only to a song without an album", () => {
    expect(catalogueTagsFor({ title: "Tone" }, FOUND)).toEqual({
      genre: "Electronic",
      album: "Pure Tones",
      date: "1999",
      track: 4,
    });
    // Spotify's album details are one release's: only the genre is added.
    expect(
      catalogueTagsFor({ title: "Tone", album: "Live", date: "2001", track: 9 }, FOUND),
    ).toEqual({ genre: "Electronic" });
  });

  it("never replaces what the source gave, nor the title or artist", () => {
    expect(
      catalogueTagsFor({ title: "Tone", artist: "Me", genre: "Jazz", album: "Live" }, FOUND),
    ).toEqual({});
    expect(catalogueTagsFor({ title: "Tone" }, null)).toEqual({});
  });
});

describe("lookUpDownload and lateDetails", () => {
  it("asks by the song's title, artist and length", async () => {
    const lookUp = vi.fn(async () => FOUND);
    const found = await lookUpDownload({ title: "Tone", artist: "Test" }, 180, { lookUp });
    expect(lookUp).toHaveBeenCalledWith({ title: "Tone", artist: "Test", duration: 180 });
    expect(found.tags.genre).toBe("Electronic");
  });

  it("gives nothing, without failing, when the catalogues fail, throw or are slow", async () => {
    const tags = { title: "Tone" };
    const fails = lookUpDownload(tags, 3, {
      lookUp: async () => {
        throw new Error("Couldn't reach the music catalogues");
      },
    });
    const throws = lookUpDownload(tags, 3, {
      lookUp: () => {
        throw new Error("thrown at once");
      },
    });
    const started = Date.now();
    const slow = lookUpDownload(tags, 3, { lookUp: () => new Promise(() => {}), waitMs: 50 });
    // Nothing to add, and why: for the details log.
    expect(await fails).toEqual({ tags: {}, why: "Couldn't reach the music catalogues" });
    expect(await throws).toEqual({ tags: {}, why: "thrown at once" });
    expect(await slow).toEqual({ tags: {}, why: "no answer within 0.05 s" });
    const none = await lookUpDownload(tags, 3, { lookUp: async () => null });
    expect(none).toEqual({ tags: {}, why: "not found in iTunes or Deezer" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("fetches the catalogue's cover only for a download without one, keeping the tags if it fails", async () => {
    const jpeg = Buffer.from("a cover");
    const getCover = vi.fn(async () => jpeg);
    const lookedUp = Promise.resolve({ tags: { genre: "Rock" }, coverUrl: FOUND.song.coverUrl });
    expect(await lateDetails(lookedUp, true, { getCover })).toEqual({ tags: { genre: "Rock" } });
    expect(getCover).not.toHaveBeenCalled();
    expect(await lateDetails(lookedUp, false, { getCover })).toEqual({
      tags: { genre: "Rock" },
      cover: jpeg,
    });
    const failing = vi.fn(async () => {
      throw new Error("no picture");
    });
    expect(await lateDetails(lookedUp, false, { getCover: failing })).toEqual({
      tags: { genre: "Rock" },
    });
    const hanging = () => new Promise<undefined>(() => {});
    expect(await lateDetails(lookedUp, false, { getCover: hanging, waitMs: 50 })).toEqual({
      tags: { genre: "Rock" },
    });
  });
});

describe("a download with details still on their way", () => {
  it("starts an MP3 at once, its tag going out with the first audio once the details are in", async () => {
    let arrive!: (details: { tags: { genre: string } }) => void;
    const later = new Promise<{ tags: { genre: string } }>((resolve) => (arrive = resolve));
    const output = await prepareAudioOutput(
      "mp3",
      { title: "Tone", artist: "Test" },
      "opus",
      undefined,
      later,
    );
    expect(output.prefix).toBeInstanceOf(Promise);

    const ffmpeg = new PassThrough();
    const audio = withPrefix(ffmpeg, output.prefix!);
    const chunks: Buffer[] = [];
    audio.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.write(Buffer.from("AUDIO"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks).toEqual([]); // held until the tag is ready

    arrive({ tags: { genre: "Electronic" } });
    ffmpeg.end(Buffer.from("MORE"));
    await new Promise((resolve) => audio.on("end", resolve));
    const file = Buffer.concat(chunks);
    expect(file.subarray(0, 3).toString()).toBe("ID3");
    expect(frames(file)).toMatchObject({ TIT2: "Tone", TPE1: "Test", TCON: "Electronic" });
    expect(file.subarray(-9).toString()).toBe("AUDIOMORE");
  });

  it("tags the file as it would have been when the details fail", async () => {
    const later = Promise.reject(new Error("broken"));
    later.catch(() => {});
    const mp3 = await prepareAudioOutput("mp3", { title: "Tone" }, "opus", undefined, later);
    expect(frames(await mp3.prefix!)).toEqual({ TIT2: "Tone" });
    const opus = await prepareAudioOutput("original", { title: "Tone" }, "opus", undefined, later);
    expect(opus.ffmpegArgs).toContain("title=Tone");
    expect(opus.ffmpegArgs.some((arg) => arg.startsWith("genre="))).toBe(false);
  });

  it("puts the genre into an original-format file's tags", async () => {
    const later = Promise.resolve({ tags: { genre: "Electronic", album: "Pure Tones" } });
    const opus = await prepareAudioOutput("original", { title: "Tone" }, "opus", undefined, later);
    expect(opus.ffmpegArgs).toEqual(
      expect.arrayContaining(["genre=Electronic", "album=Pure Tones", "title=Tone"]),
    );
    await opus.cleanup();
  });
});
