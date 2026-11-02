import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FolderError } from "../../server/folders";
import {
  binAndSwapIn,
  PartKeptError,
  restoreUnfinishedTagWrites,
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

  it("keeps the original in the backup folder while it writes, and deletes it after", async () => {
    const backups = path.join(dir, "backups-kept");
    const target = await file("kept.mp3", "the original song");
    const before = await fs.stat(target);
    let seen: string[] = [];
    const open = fs.open;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      // As the song is opened to be written over, its original is already safe.
      const [song] = await fs.readdir(backups);
      seen = [
        await fs.readFile(path.join(backups, song, "original"), "utf8"),
        JSON.parse(await fs.readFile(path.join(backups, song, "info.json"), "utf8")).song,
      ];
      return open(...(args as Parameters<typeof fs.open>));
    });
    try {
      await writeOver(target, Buffer.from("new tags"), before, backups);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual(["the original song", target]);
    expect(await fs.readdir(backups)).toEqual([]);
    expect(await fs.readFile(target, "utf8")).toBe("new tags");
  });

  it("puts the original back at once when the write fails part-way", async () => {
    const backups = path.join(dir, "backups-failed");
    const target = await file("failed.mp3", "the original song");
    const before = await fs.stat(target);
    const open = fs.open;
    let calls = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...(args as Parameters<typeof fs.open>));
      if (++calls > 1) return handle; // putting the original back works
      // The first write gets half its bytes down, then the disk says no.
      handle.writeFile = (async (data: Buffer) => {
        await fs.writeFile(target, data.subarray(0, 3));
        throw Object.assign(new Error("ENOSPC: disk full"), { code: "ENOSPC" });
      }) as typeof handle.writeFile;
      return handle;
    });
    try {
      await expect(
        writeOver(target, Buffer.from("new tags that won't fit"), before, backups),
      ).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(target, "utf8")).toBe("the original song");
    expect((await fs.stat(target)).mtime.toISOString()).toBe("2024-03-01T12:00:00.000Z");
    expect(await fs.readdir(backups)).toEqual([]);
  });

  it("leaves the song alone when its original can't be backed up", async () => {
    const backups = path.join(dir, "backups-none");
    const target = await file("unread.mp3", "the original song");
    const before = await fs.stat(target);
    const spy = vi
      .spyOn(fs, "copyFile")
      .mockRejectedValue(Object.assign(new Error("EIO: no"), { code: "EIO" }));
    try {
      await expect(writeOver(target, Buffer.from("new"), before, backups)).rejects.toMatchObject({
        code: "EIO",
      });
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readFile(target, "utf8")).toBe("the original song");
    expect(await fs.readdir(backups)).toEqual([]);
  });
});

describe("restoreUnfinishedTagWrites", () => {
  /** A backup as writeOver() leaves it when the app stops part-way through a write. */
  async function leftBehind(backups: string, song: string, original: string | undefined) {
    const backup = path.join(backups, `song-${Math.random().toString(36).slice(2, 8)}`);
    await fs.mkdir(backup, { recursive: true });
    if (original !== undefined) {
      await fs.writeFile(path.join(backup, "original"), original);
      const old = Date.parse("2024-03-01T12:00:00Z");
      await fs.writeFile(
        path.join(backup, "info.json"),
        JSON.stringify({ song, atimeMs: old, mtimeMs: old }),
      );
    } else {
      await fs.writeFile(path.join(backup, "original"), "half a co");
    }
    return backup;
  }

  it("puts back a song the app stopped writing, with its dates, and forgets the backup", async () => {
    const backups = path.join(dir, "backups-restart");
    const song = await file("halfway.mp3", "the newHALF");
    await leftBehind(backups, song, "the original song");
    expect(await restoreUnfinishedTagWrites(backups)).toEqual([song]);
    expect(await fs.readFile(song, "utf8")).toBe("the original song");
    expect((await fs.stat(song)).mtime.toISOString()).toBe("2024-03-01T12:00:00.000Z");
    expect(await fs.readdir(backups)).toEqual([]);
  });

  it("drops a backup the write never got to, and keeps one whose song is gone", async () => {
    const backups = path.join(dir, "backups-other");
    const untouched = await file("untouched.mp3", "as it was");
    await leftBehind(backups, untouched, undefined);
    const gone = await leftBehind(backups, path.join(dir, "gone.mp3"), "the original song");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await restoreUnfinishedTagWrites(backups)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(await fs.readFile(untouched, "utf8")).toBe("as it was");
    expect(await fs.readdir(backups)).toEqual([path.basename(gone)]);
  });

  it("does nothing when there's no backup folder", async () => {
    expect(await restoreUnfinishedTagWrites(path.join(dir, "no-such-folder"))).toEqual([]);
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
