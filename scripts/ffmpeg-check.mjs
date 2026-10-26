/**
 * Checks ffmpeg — the program every download and conversion runs through —
 * after every `npm install` / `npm ci` (the package's postinstall, after
 * scripts/yt-dlp.mjs). ffmpeg-static downloads it from its GitHub release
 * without checking it; this compares its SHA-256 with the one pinned here for
 * that release and this computer. One that doesn't match is deleted, so the
 * app never runs it: installing again (`npm ci`, or Update) gets a new copy.
 *
 * The hashes are of the programs themselves (the release's .gz files,
 * unpacked). A new ffmpeg-static release needs its hashes added here: a unit
 * test fails until they are (tests/unit/ffmpeg-check.test.ts).
 *
 * Plain JavaScript with no packages of its own, like scripts/yt-dlp.mjs.
 */
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { readFile, rm } from "fs/promises";
import { createRequire } from "module";
import path from "path";

/** SHA-256 of each ffmpeg-static release's ffmpeg, by "<platform>-<arch>". */
export const FFMPEG_SHA256 = {
  "b6.1.1": {
    "win32-x64": "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
    "darwin-x64": "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
    "darwin-arm64": "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
    "linux-x64": "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
    "linux-ia32": "c6472eb993612db72ca50893a34137ba11173e60a1a4c028d4660a3f755d2490",
    "linux-arm64": "6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce",
    "linux-arm": "0afba4a11110e6e402053e0fc14c33a7eb207d7a588688ae87dba471a0f06c71",
  },
};

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

/** The hash ffmpeg should have, or undefined if it isn't known here. */
export function expectedFfmpegHash(release, platform, arch) {
  return FFMPEG_SHA256[release]?.[`${platform}-${arch}`];
}

/**
 * Checks `binary` against the pinned hash. Returns "ok", "unchecked" (no
 * file, or no hash pinned for this release and computer) or "deleted" (it
 * didn't match, so it's gone).
 */
export async function checkFfmpeg(binary, release, platform, arch) {
  const expected = expectedFfmpegHash(release, platform, arch);
  if (!expected) {
    console.warn(
      `ffmpeg: no checksum known for ${release} on ${platform}-${arch}, so it wasn't checked.`,
    );
    return "unchecked";
  }
  const actual = await sha256Of(binary).catch(() => undefined);
  if (actual === undefined) return "unchecked"; // not installed (its own install said why)
  if (actual === expected) {
    console.log(`ffmpeg: checked (${release}, ${platform}-${arch}).`);
    return "ok";
  }
  await rm(binary, { force: true });
  console.error(
    `ffmpeg: DELETED. Its SHA-256 (${actual}) isn't the one ffmpeg-static ${release} should have (${expected}),`,
    "so the app won't run it. Install again (npm ci, or Update) to get a new copy.",
  );
  return "deleted";
}

/** ffmpeg-static's ffmpeg, and the release it downloaded it from. */
async function installedFfmpeg() {
  const require = createRequire(import.meta.url);
  const binary = require("ffmpeg-static");
  const dir = path.dirname(require.resolve("ffmpeg-static"));
  const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  // The same choice ffmpeg-static's own install makes.
  const release = process.env.FFMPEG_BINARY_RELEASE || pkg["ffmpeg-static"]["binary-release-tag"];
  return { binary, release };
}

async function main() {
  const { binary, release } = await installedFfmpeg();
  if (!binary) return; // no ffmpeg-static build for this computer (FFMPEG_BIN, then)
  const arch = process.env.npm_config_arch || process.arch;
  const platform = process.env.npm_config_platform || process.platform;
  await checkFfmpeg(binary, release, platform, arch);
}

// Run, unless a test is importing it for the functions above.
if (!process.env.VITEST) await main();
