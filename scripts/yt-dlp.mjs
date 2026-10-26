/**
 * yt-dlp for this computer. On Windows, youtube-dl-exec's installer downloads
 * yt-dlp.exe, which runs on its own. On macOS and Linux it downloads the
 * Python version of yt-dlp, which needs Python 3.10 or newer — that a Mac
 * doesn't have (or has 3.9, which yt-dlp no longer runs on). So this swaps it
 * for yt-dlp's standalone build for the system, which needs nothing else. It
 * runs after every `npm install` / `npm ci` (the package's postinstall).
 *
 *   node scripts/yt-dlp.mjs            make sure it's the standalone build
 *   node scripts/yt-dlp.mjs --update   get the newest yt-dlp (npm run update-yt-dlp)
 *
 * Either way, the yt-dlp it ends up with is checked against the SHA-256 sums
 * yt-dlp publishes with each release (SHA2-256SUMS): a download that doesn't
 * match is never installed, and an installed yt-dlp that doesn't match the
 * newest release is swapped for a fresh, checked copy. (yt-dlp's own `-U`
 * updater checks the same sums.) Offline, nothing is checked or changed.
 *
 * Plain JavaScript with no packages of its own, so it runs straight after an
 * install — in a copy of the source and in the ready-to-run build alike.
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "fs/promises";
import { createRequire } from "module";
import path from "path";

const DOWNLOADS = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
/** The newest release's SHA-256 sums: "<hash>  <file name>" lines. */
const SUMS = `${DOWNLOADS}SHA2-256SUMS`;

/**
 * The name of yt-dlp's standalone build for a system, or undefined where
 * youtube-dl-exec's own download is the one to use (Windows), or there's no
 * standalone build (32-bit ARM, say).
 */
export function standaloneBuild(platform, arch, glibc) {
  if (platform === "darwin") return "yt-dlp_macos"; // one build for Intel and Apple silicon
  if (platform !== "linux") return undefined;
  // Alpine and friends use musl instead of glibc.
  const linux = glibc ? "yt-dlp_linux" : "yt-dlp_musllinux";
  if (arch === "x64") return linux;
  if (arch === "arm64") return `${linux}_aarch64`;
  return undefined;
}

/**
 * yt-dlp's name for the file this computer runs, in its releases (and in
 * SHA2-256SUMS): the standalone build, or else what youtube-dl-exec downloads
 * — yt-dlp.exe on Windows, the Python version ("yt-dlp") elsewhere.
 */
export function releaseName(platform, arch, glibc) {
  return standaloneBuild(platform, arch, glibc) ?? (platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

/** SHA2-256SUMS's lines, as file name → hash (lowercase). */
export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** A file's SHA-256, in hex (lowercase). */
export function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** The newest release's sums, or undefined (said why) if they can't be had. */
export async function fetchSums(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(SUMS);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sums = parseSums(await res.text());
    if (sums.size === 0) throw new Error("no sums in it");
    return sums;
  } catch (err) {
    console.warn(
      `yt-dlp: couldn't get its checksums (${err instanceof Error ? err.message : err}), so it wasn't checked.`,
    );
    return undefined;
  }
}

/**
 * Downloads `name` from yt-dlp's newest release into `file`, but only if its
 * SHA-256 is the one `sums` gives: otherwise nothing is installed and this
 * throws. Written next to it first, so `file` is never left half-written.
 */
export async function downloadChecked(file, name, sums, fetchImpl = fetch) {
  const expected = sums.get(name);
  if (!expected) throw new Error(`the release has no checksum for ${name}`);
  const part = `${file}.download`;
  try {
    const res = await fetchImpl(DOWNLOADS + name);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await writeFile(part, Buffer.from(await res.arrayBuffer()));
    const actual = await sha256Of(part);
    if (actual !== expected) {
      throw new Error(`its SHA-256 (${actual}) isn't the one yt-dlp published (${expected})`);
    }
    await chmod(part, 0o755);
    await rename(part, file);
  } finally {
    await rm(part, { force: true });
  }
}

/**
 * Checks the installed yt-dlp against the newest release's sums. If it
 * doesn't match (it's been changed, or it's an older version), a fresh,
 * checked copy takes its place. Returns "ok", "replaced", or "unchecked"
 * (no sums, or no file; a fresh copy that couldn't be had leaves it as it is).
 */
export async function checkInstalled(file, name, sums, fetchImpl = fetch) {
  if (!sums || !sums.has(name)) return "unchecked";
  const actual = await sha256Of(file).catch(() => undefined);
  if (actual === undefined) return "unchecked";
  if (actual === sums.get(name)) {
    console.log(`yt-dlp: checked (${name} matches yt-dlp's published SHA-256).`);
    return "ok";
  }
  console.log(
    `yt-dlp: ${name} doesn't match the newest release's SHA-256 (it's been changed, or it's an older version); getting a fresh, checked copy...`,
  );
  try {
    await downloadChecked(file, name, sums, fetchImpl);
    console.log(`yt-dlp: ${name} replaced and checked.`);
    return "replaced";
  } catch (err) {
    console.warn(
      `yt-dlp: couldn't replace it (${err instanceof Error ? err.message : err}); the one installed stays.`,
    );
    return "unchecked";
  }
}

/**
 * Is this file the Python version of yt-dlp? That's a script ("#!/usr/bin/env
 * python3" and a zip); the standalone builds are programs (ELF, Mach-O).
 */
export function isPythonScript(firstBytes) {
  return firstBytes.length >= 2 && firstBytes[0] === 0x23 && firstBytes[1] === 0x21; // "#!"
}

/** The first bytes of a file, or undefined if there's no such file. */
async function readStart(file) {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Where the app runs yt-dlp from (youtube-dl-exec's bin folder). */
function ytDlpPath() {
  const require = createRequire(import.meta.url);
  return require("youtube-dl-exec/src/constants").YOUTUBE_DL_PATH;
}

/**
 * Makes sure yt-dlp is in place: the standalone build where there is one, or
 * else the file youtube-dl-exec downloads (if its own download didn't come
 * through). Says whether it just downloaded it, checked against the sums.
 * Never fails an install: it says what went wrong.
 */
async function ensureInstalled(file, build, name, sums) {
  const start = await readStart(file);
  if (start && (!build || !isPythonScript(start))) return false; // the right one already
  const wanted = build ?? name;

  console.log(
    `yt-dlp: getting ${build ? "the standalone build for this computer" : "it"} (${wanted})...`,
  );
  try {
    if (!sums) throw new Error("its checksums couldn't be had to check it");
    await mkdir(path.dirname(file), { recursive: true });
    await downloadChecked(file, wanted, sums);
    console.log(`yt-dlp: ${wanted} installed and checked.`);
    return true;
  } catch (err) {
    console.warn(
      `yt-dlp: couldn't download ${wanted} (${err instanceof Error ? err.message : err}).`,
      start
        ? "The Python version stays, which needs Python 3.10 or newer."
        : "Run `npm run update-yt-dlp` once you're online.",
    );
    return false;
  }
}

async function main() {
  const file = ytDlpPath();
  const glibc = Boolean(process.report?.getReport?.().header?.glibcVersionRuntime);
  const build = standaloneBuild(process.platform, process.arch, glibc);
  const name = releaseName(process.platform, process.arch, glibc);
  const skip = Boolean(process.env.YOUTUBE_DL_SKIP_DOWNLOAD);
  let sums = skip ? undefined : await fetchSums();
  const fresh = !skip && (await ensureInstalled(file, build, name, sums));
  if (process.argv.includes("--update")) {
    // yt-dlp updates itself in place, to the newest version of the same build.
    const { status } = spawnSync(file, ["-U"], { stdio: "inherit" });
    process.exitCode = status ?? 1;
    if (!skip) sums = (await fetchSums()) ?? sums; // a release may have come out since
  } else if (fresh) {
    return; // just downloaded and checked
  }
  if (!skip) await checkInstalled(file, name, sums);
}

// Run, unless a test is importing it for the functions above.
if (!process.env.VITEST) await main();
