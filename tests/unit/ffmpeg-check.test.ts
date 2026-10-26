import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { promises as fs, readFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  FFMPEG_SHA256,
  checkFfmpeg,
  expectedFfmpegHash,
  sha256Of,
} from "../../scripts/ffmpeg-check.mjs";

/**
 * scripts/ffmpeg-check.mjs, which runs after every npm install: ffmpeg-static
 * downloads ffmpeg without checking it, so this compares it with the SHA-256
 * pinned for its release, and deletes one that doesn't match.
 */

let dir: string;
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-ffmpeg-check-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("checking ffmpeg after an install", () => {
  it("has a hash for the ffmpeg-static release installed, on every system it builds for", () => {
    // A new ffmpeg-static release fails here until its hashes are added.
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../node_modules/ffmpeg-static/package.json", import.meta.url)),
        "utf8",
      ),
    );
    const release = pkg["ffmpeg-static"]["binary-release-tag"];
    for (const system of [
      "win32-x64",
      "darwin-x64",
      "darwin-arm64",
      "linux-x64",
      "linux-arm64",
      "linux-ia32",
      "linux-arm",
    ]) {
      const [platform, arch] = system.split("-");
      expect(expectedFfmpegHash(release, platform, arch), system).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(expectedFfmpegHash(release, "freebsd", "x64")).toBeUndefined();
  });

  it("matches the ffmpeg installed on this computer", async () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../node_modules/ffmpeg-static/package.json", import.meta.url)),
        "utf8",
      ),
    );
    const { default: binary } = (await import("ffmpeg-static")) as { default: string | null };
    const release = pkg["ffmpeg-static"]["binary-release-tag"];
    const expected = expectedFfmpegHash(release, process.platform, process.arch);
    if (!binary || !expected) return; // a system ffmpeg-static has no build for
    expect(await sha256Of(binary)).toBe(expected);
  });

  it("keeps an ffmpeg that matches, and deletes one that doesn't", async () => {
    const good = path.join(dir, "ffmpeg-good");
    await fs.writeFile(good, "the real ffmpeg");
    const bad = path.join(dir, "ffmpeg-bad");
    await fs.writeFile(bad, "something else");
    FFMPEG_SHA256["test-release"] = { "linux-x64": sha256("the real ffmpeg") };
    try {
      expect(await checkFfmpeg(good, "test-release", "linux", "x64")).toBe("ok");
      await fs.stat(good);
      expect(await checkFfmpeg(bad, "test-release", "linux", "x64")).toBe("deleted");
      await expect(fs.stat(bad)).rejects.toThrow();
      // Nothing to check against, or nothing installed: left as it is.
      expect(await checkFfmpeg(good, "test-release", "linux", "arm64")).toBe("unchecked");
      expect(await checkFfmpeg(good, "another-release", "linux", "x64")).toBe("unchecked");
      await fs.stat(good);
      expect(await checkFfmpeg(path.join(dir, "missing"), "test-release", "linux", "x64")).toBe(
        "unchecked",
      );
    } finally {
      delete FFMPEG_SHA256["test-release"];
    }
  });
});
