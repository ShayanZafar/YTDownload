import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { runFfmpeg } from "../../server/ffmpeg";

// The tags read are kept in a file, so the first look through the folder after
// the app starts doesn't open every song again. Each test loads library.ts
// afresh, as a restarted app would.
type Library = typeof import("../../server/library");
const restart = async (): Promise<Library> => {
  vi.resetModules();
  return import("../../server/library");
};

let root: string;
let folder: string;
let tagsFile: string;

/** A second of tone, saved as `name` with these title and artist tags. */
const song = (name: string, title: string, artist = "Test") =>
  runFfmpeg([
    ...["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=1"],
    ...["-metadata", `title=${title}`, "-metadata", `artist=${artist}`, "-y"],
    path.join(folder, name),
  ]);

/** Changes a file's content but not its size or time — as only the test can. */
async function swapKeepingTime(name: string, other: string) {
  const file = path.join(folder, name);
  const { atime, mtime, size } = await fs.stat(file);
  await fs.copyFile(path.join(folder, other), file);
  expect((await fs.stat(file)).size).toBe(size);
  await fs.utimes(file, atime, mtime);
}

const titles = async (library: Library) =>
  (await library.readSongFiles(folder)).files.map((file) => file.title);

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-songtags-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  folder = await fs.mkdtemp(path.join(root, "folder-"));
  tagsFile = path.join(folder, "..", `${path.basename(folder)}-tags.json`);
  process.env.SONG_TAGS_FILE = tagsFile;
  // Two songs whose files are the same size: one stands in for the other.
  await song("Alpha.mp3", "Alpha");
  await song("Bravo.mp3", "Bravo");
  // Whole seconds, which every file system keeps exactly when they're put back.
  for (const name of ["Alpha.mp3", "Bravo.mp3"])
    await fs.utimes(path.join(folder, name), 1_700_000_000, 1_700_000_000);
});

afterEach(() => {
  process.env.SONG_TAGS_FILE = "";
});

/** Waits for the copy on disk to be written (it's written after the look, in the background). */
const saved = async (library: Library) => {
  await library.saveSongTags();
  return JSON.parse(await fs.readFile(tagsFile, "utf8"));
};

describe("the songs' tags kept between runs", () => {
  it("are written after a look through the folder, and used after a restart", async () => {
    let library = await restart();
    expect(await titles(library)).toEqual(["Alpha", "Bravo"]);
    const file = await saved(library);
    expect(file.version).toBe(library.SONG_TAGS_VERSION);
    expect(Object.keys(file.files).sort()).toEqual([
      path.join(folder, "Alpha.mp3"),
      path.join(folder, "Bravo.mp3"),
    ]);

    // Bravo's file now holds other tags, but its size and time say it's the
    // same file: after a restart the kept tags are used, the file not opened.
    await swapKeepingTime("Bravo.mp3", "Alpha.mp3");
    library = await restart();
    expect(await titles(library)).toEqual(["Alpha", "Bravo"]);
  });

  it("are read again from a file that changed since", async () => {
    let library = await restart();
    await titles(library);
    await saved(library);
    await song("Bravo.mp3", "Charlie");
    library = await restart();
    expect(await titles(library)).toEqual(["Alpha", "Charlie"]);
    // And the new ones kept.
    const file = await saved(library);
    expect(file.files[path.join(folder, "Bravo.mp3")].tags.title).toBe("Charlie");
  });

  it("are read again once forgotten (after the app writes a file)", async () => {
    const library = await restart();
    await titles(library);
    await swapKeepingTime("Bravo.mp3", "Alpha.mp3");
    library.forgetTags(path.join(folder, "Bravo.mp3"));
    expect(await titles(library)).toEqual(["Alpha", "Alpha"]);
    const file = await saved(library);
    expect(file.files[path.join(folder, "Bravo.mp3")].tags.title).toBe("Alpha");
  });

  it("from another version of the app, or damaged, are read from the files again", async () => {
    let library = await restart();
    await titles(library);
    const file = await saved(library);
    await swapKeepingTime("Bravo.mp3", "Alpha.mp3");

    await fs.writeFile(tagsFile, JSON.stringify({ ...file, version: file.version + 1 }));
    library = await restart();
    expect(await titles(library)).toEqual(["Alpha", "Alpha"]);

    await fs.writeFile(tagsFile, "{ not json");
    library = await restart();
    expect(await titles(library)).toEqual(["Alpha", "Alpha"]);
  });

  it("aren't kept for a file that couldn't be opened (busy, say), so it's tried again", async () => {
    const library = await restart();
    await titles(library);
    // Found in the folder, then gone (or locked) by the time it's read.
    const gone = path.join(folder, "Gone.mp3");
    const file = { absolute: gone, relative: "Gone.mp3", size: 1, mtimeMs: 1, addedMs: 1 };
    expect(await library.readTags(file)).toEqual({ spotifyIds: [] });
    await titles(library);
    expect(Object.keys((await saved(library)).files)).not.toContain(gone);
  });

  it("are kept nowhere when SONG_TAGS_FILE is empty", async () => {
    process.env.SONG_TAGS_FILE = "";
    const library = await restart();
    expect(library.songTagsFilePath()).toBeUndefined();
    expect(await titles(library)).toEqual(["Alpha", "Bravo"]);
    await library.saveSongTags();
    await expect(fs.stat(tagsFile)).rejects.toThrow();
  });
});
