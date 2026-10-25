import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  WINDOWS_RECYCLE_SCRIPT,
  binName,
  homeTrashDir,
  macTrashArgs,
  moveToTrash,
  trashInfo,
  trashInfoDate,
  windowsRecycleArgs,
} from "../../server/trash";

// Moving a song deleted from the Save to folder to the system's bin: the
// freedesktop.org trash (Linux) on real files in a temp folder, and the
// commands Windows and macOS get (they only run on those systems).

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-trash-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

describe("Moving a song to the bin", () => {
  it("moves it into the freedesktop.org trash, with the .trashinfo that puts it back", async () => {
    const song = path.join(dir, "Music", "Tired Of It.mp3");
    await fs.mkdir(path.dirname(song), { recursive: true });
    await fs.writeFile(song, "song");
    const env = { XDG_DATA_HOME: path.join(dir, "data") };

    await moveToTrash(song, { platform: "linux", env, homedir: dir });

    const trash = path.join(dir, "data", "Trash");
    expect(await exists(song)).toBe(false);
    expect(await fs.readFile(path.join(trash, "files", "Tired Of It.mp3"), "utf8")).toBe("song");
    const info = await fs.readFile(path.join(trash, "info", "Tired Of It.mp3.trashinfo"), "utf8");
    expect(info).toMatch(
      /^\[Trash Info\]\nPath=.+\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/,
    );
    expect(info).toContain("Tired%20Of%20It.mp3");
  });

  it("gives a second song of the same name a name of its own, keeping the first", async () => {
    const env = { XDG_DATA_HOME: path.join(dir, "data") };
    for (const folder of ["A", "B"]) {
      await fs.mkdir(path.join(dir, folder));
      await fs.writeFile(path.join(dir, folder, "Song.mp3"), folder);
      await moveToTrash(path.join(dir, folder, "Song.mp3"), {
        platform: "linux",
        env,
        homedir: dir,
      });
    }
    const files = path.join(dir, "data", "Trash", "files");
    expect((await fs.readdir(files)).sort()).toEqual(["Song.2.mp3", "Song.mp3"]);
    expect(await fs.readFile(path.join(files, "Song.mp3"), "utf8")).toBe("A");
    expect(await fs.readFile(path.join(files, "Song.2.mp3"), "utf8")).toBe("B");
    const info = path.join(dir, "data", "Trash", "info");
    expect((await fs.readdir(info)).sort()).toEqual(["Song.2.mp3.trashinfo", "Song.mp3.trashinfo"]);
  });

  it("uses TRASH_DIR in place of the system's bin, on any system (for tests)", async () => {
    const song = path.join(dir, "Song.mp3");
    await fs.writeFile(song, "song");
    await moveToTrash(song, { platform: "win32", env: { TRASH_DIR: path.join(dir, "bin") } });
    expect(await exists(path.join(dir, "bin", "files", "Song.mp3"))).toBe(true);
    expect(await exists(song)).toBe(false);
  });

  it("finds the user's trash where XDG_DATA_HOME says, else in ~/.local/share", () => {
    expect(homeTrashDir({ XDG_DATA_HOME: "/data" }, "/home/me")).toBe(path.join("/data", "Trash"));
    expect(homeTrashDir({}, "/home/me")).toBe(path.join("/home/me", ".local", "share", "Trash"));
    // A relative one is to be ignored, says the spec.
    expect(homeTrashDir({ XDG_DATA_HOME: "data" }, "/home/me")).toBe(
      path.join("/home/me", ".local", "share", "Trash"),
    );
  });

  it("writes the .trashinfo's path URL-escaped and its date in local time", () => {
    const date = new Date(2026, 9, 5, 8, 7, 6);
    expect(trashInfoDate(date)).toBe("2026-10-05T08:07:06");
    expect(trashInfo("/home/me/Music/AC/DC – Back #1.mp3", date)).toBe(
      "[Trash Info]\nPath=/home/me/Music/AC/DC%20%E2%80%93%20Back%20%231.mp3\nDeletionDate=2026-10-05T08:07:06\n",
    );
  });

  it("asks Windows for its Recycle Bin, with the path as data and no dialogs", () => {
    const args = windowsRecycleArgs();
    expect(args.slice(0, 4)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    expect(args[4]).toBe("-EncodedCommand");
    expect(Buffer.from(args[5], "base64").toString("utf16le")).toBe(WINDOWS_RECYCLE_SCRIPT);
    // The file comes from the environment, never inside the script.
    expect(WINDOWS_RECYCLE_SCRIPT).toContain("$env:YT_AUDIO_TRASH_PATH");
    // FOF_ALLOWUNDO (to the bin) | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT.
    expect(WINDOWS_RECYCLE_SCRIPT).toContain("fFlags = 0x0040 | 0x0010 | 0x0400 | 0x0004");
    // A network or removable drive has no Recycle Bin: refused, not deleted for good.
    expect(WINDOWS_RECYCLE_SCRIPT).toMatch(/DriveType -ne 'Fixed'\) \{ exit 3 \}/);
    expect(binName("win32")).toBe("Recycle Bin");
  });

  it("asks Finder on macOS, with the path as the script's argument", () => {
    const file = '/Users/me/Music/Song "Live".mp3';
    const args = macTrashArgs(file);
    expect(args.at(-1)).toBe(file);
    expect(args.slice(0, -1).join(" ")).not.toContain("Song");
    expect(args).toContain(
      'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
    );
    expect(binName("darwin")).toBe("Trash");
  });
});
