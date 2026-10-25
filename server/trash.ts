/**
 * Moving a file to this computer's Recycle Bin (Windows) or Trash (macOS,
 * Linux), so a song deleted from the "Save to" folder can still be put back
 * from there. Each system has its own way:
 *
 * - Windows: the shell's own delete-to-Recycle-Bin (`SHFileOperation` with
 *   "allow undo"), run by PowerShell with no window and no dialogs. A network
 *   or removable drive has no Recycle Bin — Windows would delete the file for
 *   good — so those are refused instead (`NoBinError`).
 * - macOS: Finder deletes it (so "Put Back" works); if the app may not ask
 *   Finder, it's moved into ~/.Trash itself.
 * - Linux (and the rest): the freedesktop.org trash that GNOME, KDE and the
 *   others share — `~/.local/share/Trash`, or `.Trash-<uid>` at the top of
 *   another drive — with the `.trashinfo` file that lets them put it back.
 *
 * With `TRASH_DIR` set (the tests do), files go into that folder instead, in
 * the freedesktop.org layout, whatever the system.
 *
 * The path goes to PowerShell and osascript as data (an environment
 * variable, an argument), never inside the script itself.
 */
import { spawn } from "child_process";
import { promises as fs, constants as fsConstants } from "fs";
import os from "os";
import path from "path";
import { retryWhenBusy } from "./retry-when-busy";

/** There's no bin to move the file into: deleting it would be for good. */
export class NoBinError extends Error {}

export type TrashOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
};

/** The bin's name on this system, for messages. */
export const binName = (platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? "Recycle Bin" : "Trash";

/** Moves `file` (an absolute path) to the bin. Rejects with `NoBinError` if there's none for it. */
export async function moveToTrash(file: string, options: TrashOptions = {}): Promise<void> {
  // The tests' own bin, laid out like the freedesktop.org one, on any system.
  const testBin = (options.env ?? process.env).TRASH_DIR;
  if (testBin) return trashInto(path.resolve(testBin), file, file);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return windowsRecycle(file);
  if (platform === "darwin") return macTrash(file, options.homedir ?? os.homedir());
  return freedesktopTrash(file, options);
}

// --- Running a helper ---------------------------------------------------------------

/** Runs `command`; resolves with its exit code and what it wrote to stderr. */
function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr: stderr.trim() });
    });
  });
}

// --- Windows --------------------------------------------------------------------------

/** PowerShell's exit code for "this drive has no Recycle Bin". */
const NO_BIN_EXIT = 3;

/**
 * The PowerShell script: the file (from `$env:YT_AUDIO_TRASH_PATH`) to the
 * Recycle Bin with the shell's own operation — FOF_ALLOWUNDO (to the bin),
 * FOF_NOCONFIRMATION, FOF_NOERRORUI and FOF_SILENT, so no dialog can appear
 * and wait for a click nobody sees.
 */
export const WINDOWS_RECYCLE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$file = $env:YT_AUDIO_TRASH_PATH
$root = [System.IO.Path]::GetPathRoot($file)
if ($root.StartsWith('\\\\') -or ([System.IO.DriveInfo]::new($root)).DriveType -ne 'Fixed') { exit ${NO_BIN_EXIT} }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YtAudioRecycleBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
    [MarshalAs(UnmanagedType.Bool)] public bool fAnyOperationsAborted;
    public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string file) {
    var op = new SHFILEOPSTRUCT { wFunc = 3, pFrom = file + "\\0\\0", fFlags = 0x0040 | 0x0010 | 0x0400 | 0x0004 };
    int result = SHFileOperation(ref op);
    return result != 0 ? result : op.fAnyOperationsAborted ? -1 : 0;
  }
}
'@
$result = [YtAudioRecycleBin]::Recycle($file)
if ($result -ne 0) { [Console]::Error.WriteLine("Windows said no (code $result)."); exit 1 }
`;

/**
 * PowerShell's arguments for the script above — encoded (UTF-16LE, base64),
 * as its quotes wouldn't survive Windows' command line.
 */
export const windowsRecycleArgs = () => [
  ...["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"],
  ...["-EncodedCommand", Buffer.from(WINDOWS_RECYCLE_SCRIPT, "utf16le").toString("base64")],
];

async function windowsRecycle(file: string): Promise<void> {
  const { code, stderr } = await run(
    "powershell.exe",
    windowsRecycleArgs(),
    { ...process.env, YT_AUDIO_TRASH_PATH: file },
    60_000,
  );
  if (code === NO_BIN_EXIT) {
    throw new NoBinError("That drive has no Recycle Bin (a network or removable drive).");
  }
  if (code !== 0) throw new Error(stderr.split(/\r?\n/).pop() || "Windows couldn't move it.");
  // The shell can report success for a file it skipped: make sure it's gone.
  if (await exists(file)) throw new Error("Windows didn't move it.");
}

// --- macOS ----------------------------------------------------------------------------

/** osascript's arguments: Finder deletes the file named by the last argument. */
export const macTrashArgs = (file: string) => [
  ...["-e", "on run argv"],
  ...["-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)'],
  ...["-e", "end run"],
  file,
];

async function macTrash(file: string, homedir: string): Promise<void> {
  // Finder may need permission first (System Settings › Privacy › Automation).
  const finder = await run("osascript", macTrashArgs(file), process.env, 15_000).catch(() => null);
  if (finder?.code === 0 && !(await exists(file))) return;
  // Not allowed, or no Finder: into the Trash ourselves (no Put Back, then).
  try {
    await moveInto(file, path.join(homedir, ".Trash"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      throw new NoBinError("Finder couldn't move it to the Trash, and it's on another drive.");
    }
    throw err;
  }
}

/** Moves `file` into `dir` under a name not taken there ("Song 2.mp3"). */
async function moveInto(file: string, dir: string): Promise<void> {
  const { name, ext } = path.parse(file);
  for (let n = 1; ; n++) {
    const target = path.join(dir, n === 1 ? `${name}${ext}` : `${name} ${n}${ext}`);
    if (await exists(target)) continue;
    return retryWhenBusy(() => fs.rename(file, target));
  }
}

// --- Linux: the freedesktop.org trash --------------------------------------------------

/** The user's own trash: `$XDG_DATA_HOME/Trash`, or `~/.local/share/Trash`. */
export function homeTrashDir(env: NodeJS.ProcessEnv, homedir: string): string {
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : "";
  return path.join(dataHome || path.join(homedir, ".local", "share"), "Trash");
}

/** "2026-10-25T20:08:29", in local time — the spec's DeletionDate. */
export function trashInfoDate(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

/** The `.trashinfo` file's text: where the file was (each part URL-escaped), and when. */
export function trashInfo(originalPath: string, date: Date): string {
  const escaped = originalPath.split("/").map(encodeURIComponent).join("/");
  return `[Trash Info]\nPath=${escaped}\nDeletionDate=${trashInfoDate(date)}\n`;
}

/** The top folder of the drive `dir` is on (the last folder up on the same device). */
async function driveTop(dir: string): Promise<string> {
  const { dev } = await fs.stat(dir);
  let top = dir;
  for (;;) {
    const parent = path.dirname(top);
    if (parent === top) return top;
    const stat = await fs.stat(parent).catch(() => undefined);
    if (!stat || stat.dev !== dev) return top;
    top = parent;
  }
}

async function freedesktopTrash(file: string, options: TrashOptions): Promise<void> {
  const env = options.env ?? process.env;
  const homeTrash = homeTrashDir(env, options.homedir ?? os.homedir());
  try {
    return await trashInto(homeTrash, file, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  // On another drive: that drive's own trash, which keeps the path from its top.
  const top = await driveTop(path.dirname(file));
  const uid = os.userInfo().uid;
  try {
    return await trashInto(path.join(top, `.Trash-${uid}`), file, path.relative(top, file));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV" || code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new NoBinError("That drive has no Trash the app can use.");
    }
    throw err;
  }
}

/**
 * Moves `file` into the trash folder `trash` (its files/ and info/), under a
 * name neither has yet; `recorded` is the path its .trashinfo gives.
 */
async function trashInto(trash: string, file: string, recorded: string): Promise<void> {
  const files = path.join(trash, "files");
  const info = path.join(trash, "info");
  await fs.mkdir(files, { recursive: true, mode: 0o700 });
  await fs.mkdir(info, { recursive: true, mode: 0o700 });
  const { name, ext } = path.parse(file);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? `${name}${ext}` : `${name}.${n}${ext}`;
    const infoFile = path.join(info, `${candidate}.trashinfo`);
    // Claiming the .trashinfo first is what keeps two deletes from taking one name.
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        infoFile,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    const target = path.join(files, candidate);
    try {
      await handle.writeFile(trashInfo(recorded, new Date()));
      await handle.close();
      if (await exists(target)) throw Object.assign(new Error("taken"), { code: "EEXIST" });
      await fs.rename(file, target);
      return;
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.rm(infoFile, { force: true }).catch(() => {});
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
  }
}

const exists = (file: string) =>
  fs.lstat(file).then(
    () => true,
    () => false,
  );
