import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  FolderError,
  assertWritableFolder,
  availablePath,
  createFolder,
  createNewFile,
  listFolders,
  normalizeFolder,
  numberedName,
  parseShellFolders,
} from "../../server/folders";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-folders-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const names = async (dir: string) => (await fs.readdir(dir)).sort();

describe("listFolders", () => {
  it("lists the folders inside, A to Z with numbers in order, leaving out files and hidden folders", async () => {
    for (const name of ["Rock", "album 10", "album 2", ".git", "$RECYCLE.BIN", "node_modules"]) {
      await fs.mkdir(path.join(root, name));
    }
    await fs.writeFile(path.join(root, "song.mp3"), "not a folder");

    const listing = await listFolders(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(path.dirname(root));
    expect(listing.folders).toEqual([
      { name: "album 2", path: path.join(root, "album 2") },
      { name: "album 10", path: path.join(root, "album 10") },
      { name: "Rock", path: path.join(root, "Rock") },
    ]);
  });

  it("has no parent at the top of a drive", async () => {
    expect((await listFolders(path.parse(root).root)).parent).toBeNull();
  });

  it("explains a folder that isn't there, or isn't a folder", async () => {
    await expect(listFolders(path.join(root, "missing"))).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/doesn't exist/),
    });
    await fs.writeFile(path.join(root, "file.txt"), "x");
    await expect(listFolders(path.join(root, "file.txt"))).rejects.toMatchObject({ status: 400 });
  });
});

describe("normalizeFolder", () => {
  it("accepts full paths, including the quotes Explorer's “Copy as path” adds", () => {
    expect(normalizeFolder(`"${root}"`)).toBe(root);
    expect(normalizeFolder(`  ${root}${path.sep} `)).toBe(root);
  });

  it("refuses relative and empty paths", () => {
    expect(() => normalizeFolder("Music")).toThrow(FolderError);
    expect(() => normalizeFolder("   ")).toThrow(/full folder path/);
  });
});

describe("createFolder", () => {
  it("makes the folder, with its name cleaned up like a file name", async () => {
    const made = await createFolder(root, "Mix: 2024?");
    expect(made).toEqual({ name: "Mix - 2024", path: path.join(root, "Mix - 2024") });
    expect((await fs.stat(made.path)).isDirectory()).toBe(true);
  });

  it("won't reuse a name or make a nameless folder", async () => {
    await createFolder(root, "Albums");
    await expect(createFolder(root, "Albums")).rejects.toMatchObject({ status: 409 });
    await expect(createFolder(root, " ... ")).rejects.toMatchObject({ status: 400 });
  });
});

describe("assertWritableFolder", () => {
  it("accepts a folder it can write into, leaving nothing behind after checking", async () => {
    expect(await assertWritableFolder(root, { tryWriting: true })).toBe(root);
    expect(await names(root)).toEqual([]);
  });

  it("refuses a missing folder and a file", async () => {
    await expect(assertWritableFolder(path.join(root, "gone"))).rejects.toMatchObject({
      status: 404,
    });
    await fs.writeFile(path.join(root, "file.txt"), "x");
    await expect(assertWritableFolder(path.join(root, "file.txt"))).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("numbered file names", () => {
  it("numbers copies the way browsers do", () => {
    expect(numberedName("Song.mp3", 0)).toBe("Song.mp3");
    expect(numberedName("Song.mp3", 2)).toBe("Song (2).mp3");
    expect(numberedName("Song.mp3.part", 1)).toBe("Song.mp3 (1).part");
    expect(numberedName("README", 1)).toBe("README (1)");
  });

  it("finds a free name without ever reusing one — a folder of that name counts as taken", async () => {
    await fs.writeFile(path.join(root, "Song.mp3"), "x");
    await fs.mkdir(path.join(root, "Song (1).mp3"));
    expect(await availablePath(root, "Song.mp3")).toBe(path.join(root, "Song (2).mp3"));
    expect(await availablePath(root, "Other.mp3")).toBe(path.join(root, "Other.mp3"));
  });

  it("creates new files only, even when two are made at once", async () => {
    await fs.writeFile(path.join(root, "Song.mp3.part"), "someone else's");
    const made = await Promise.all([
      createNewFile(root, "Song.mp3.part"),
      createNewFile(root, "Song.mp3.part"),
    ]);
    for (const file of made) {
      file.stream.end("mine");
      await new Promise((resolve) => file.stream.once("close", resolve));
    }
    expect(made.map((f) => path.basename(f.path)).sort()).toEqual([
      "Song.mp3 (1).part",
      "Song.mp3 (2).part",
    ]);
    expect(await fs.readFile(path.join(root, "Song.mp3.part"), "utf8")).toBe("someone else's");
  });
});

describe("parseShellFolders", () => {
  // `reg query "HKCU\...\Explorer\User Shell Folders"` on a PC where Music was
  // moved to another drive and Documents is backed up to OneDrive.
  const output = [
    "",
    "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders",
    "    AppData    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Roaming",
    "    My Music    REG_SZ    D:\\Music",
    "    Personal    REG_EXPAND_SZ    %OneDrive%\\Documents",
    "    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\Desktop",
    "    {374DE290-123F-4565-9164-39C4925E467B}    REG_EXPAND_SZ    %USERPROFILE%\\Downloads",
    "    My Pictures    REG_EXPAND_SZ    %USERPROFILE%\\Pictures",
    "",
  ].join("\r\n");

  it("finds where Music, Downloads, Desktop and Documents really are", () => {
    const env = { USERPROFILE: "C:\\Users\\Moomoo", OneDrive: "C:\\Users\\Moomoo\\OneDrive" };
    expect(parseShellFolders(output, env)).toEqual({
      Music: "D:\\Music",
      Documents: "C:\\Users\\Moomoo\\OneDrive\\Documents",
      Desktop: "C:\\Users\\Moomoo\\Desktop",
      Downloads: "C:\\Users\\Moomoo\\Downloads",
    });
  });

  it("fills in variables whatever their case, and leaves unknown ones alone", () => {
    expect(parseShellFolders(output, { userprofile: "C:\\Users\\A" }).Desktop).toBe(
      "C:\\Users\\A\\Desktop",
    );
    expect(parseShellFolders(output, {}).Documents).toBe("%OneDrive%\\Documents");
  });
});
