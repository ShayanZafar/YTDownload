import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FolderError } from "../../server/folders";
import {
  binAndSwapIn,
  PartKeptError,
  SONG_BUSY,
  swapIn,
  whileBusy,
  writeOver,
} from "../../server/song-file";

// The one way every feature changes a song's file (server/song-file.ts), on
// plain files in a temporary folder: no network.

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-song-file-"));
  process.env.TRASH_DIR = path.join(dir, "trash");
});

afterAll(async () => {
  delete process.env.TRASH_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

/** A file at `name` holding `text`, dated in 2024. */
async function file(name: string, text: string): Promise<string> {
  const at = path.join(dir, name);
  await fs.writeFile(at, text);
  const old = new Date("2024-03-01T12:00:00Z");
  await fs.utimes(at, old, old);
  return at;
}

/** Makes `fs.rename` fail with `code` for renames onto `target`. */
function refuseRenameOnto(target: string, code: string) {
  const rename = fs.rename;
  return vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === target) throw Object.assign(new Error(`${code}: held`), { code });
    return rename(from, to);
  });
}

describe("whileBusy", () => {
  it("lets one change at a time at a song, and frees it when the change ends or fails", async () => {
    let finish!: () => void;
    const first = whileBusy(
      "/music/a.mp3",
      () => new Promise<string>((r) => (finish = () => r("done"))),
    );
    const second = whileBusy("/music/a.mp3", async () => "second");
    await expect(second).rejects.toBeInstanceOf(FolderError);
    await expect(second).rejects.toMatchObject({ status: 409, message: SONG_BUSY });
    // Another song is changed meanwhile.
    expect(await whileBusy("/music/b.mp3", async () => "other")).toBe("other");
    finish();
    expect(await first).toBe("done");

    await expect(
      whileBusy("/music/a.mp3", async () => {
        throw new Error("ffmpeg failed");
      }),
    ).rejects.toThrow("ffmpeg failed");
    expect(await whileBusy("/music/a.mp3", async () => "free")).toBe("free");
  });
});

describe("swapIn", () => {
  it("puts the new version in the song's place, and nothing is left beside it", async () => {
    const target = await file("swap.mp3", "old");
    const part = await file("swap.mp3.1234.part", "new");
    await swapIn(part, target);
    expect(await fs.readFile(target, "utf8")).toBe("new");
    await expect(fs.stat(part)).rejects.toThrow();
  });

  it("writes it over the song when Windows won't let it be replaced, and fails on anything else", async () => {
    const target = await file("held.mp3", "old");
    const part = await file("held.mp3.1234.part", "new");
    const refused = refuseRenameOnto(target, "EPERM");
    try {
      await swapIn(part, target);
    } finally {
      refused.mockRestore();
    }
    expect(await fs.readFile(target, "utf8")).toBe("new");

    await expect(swapIn(path.join(dir, "no-such.part"), target)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(target, "utf8")).toBe("new");
  });
});

describe("writeOver", () => {
  it("writes into the same file, shorter or longer, keeping its dates", async () => {
    const target = await file("tags.mp3", "a longer old song");
    const before = await fs.stat(target);
    await writeOver(target, Buffer.from("short"), before);
    const after = await fs.stat(target);
    expect(await fs.readFile(target, "utf8")).toBe("short");
    expect(after.ino).toBe(before.ino);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThan(1);
    await writeOver(target, Buffer.from("a song with more tags now"), before);
    expect(await fs.readFile(target, "utf8")).toBe("a song with more tags now");
  });
});

describe("binAndSwapIn", () => {
  it("sends the old song to the bin, then puts the new one in its place with its dates", async () => {
    const target = await file("better.mp3", "64 kbps");
    const part = await file("better.mp3.1234.part", "320 kbps");
    await fs.utimes(part, new Date(), new Date());
    await binAndSwapIn(part, target);
    expect(await fs.readFile(target, "utf8")).toBe("320 kbps");
    expect((await fs.stat(target)).mtime.toISOString()).toBe("2024-03-01T12:00:00.000Z");
    expect(
      await fs.readFile(path.join(process.env.TRASH_DIR!, "files", "better.mp3"), "utf8"),
    ).toBe("64 kbps");
  });

  it("keeps the new one, and says where, when it can't take the old one's name", async () => {
    const target = await file("stuck.mp3", "old");
    const part = await file("stuck.mp3.1234.part", "new");
    const refused = refuseRenameOnto(target, "EACCES");
    let failed: unknown;
    try {
      failed = await binAndSwapIn(part, target).catch((err: unknown) => err);
    } finally {
      refused.mockRestore();
    }
    expect(failed).toBeInstanceOf(PartKeptError);
    expect(failed).toMatchObject({ status: 500 });
    expect((failed as Error).message).toContain("“stuck.mp3.1234.part” in the same folder");
    expect(await fs.readFile(part, "utf8")).toBe("new");
  });
});
