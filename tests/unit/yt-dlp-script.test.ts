import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { promises as fs, readFileSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  checkInstalled,
  downloadChecked,
  fetchSums,
  isPythonScript,
  parseSums,
  releaseName,
  standaloneBuild,
} from "../../scripts/yt-dlp.mjs";

/**
 * scripts/yt-dlp.mjs, which runs after every npm install: on macOS and Linux
 * it swaps youtube-dl-exec's Python yt-dlp (which needs Python 3.10+) for
 * yt-dlp's standalone build.
 */
describe("the standalone yt-dlp for each system", () => {
  it("is yt-dlp's own build on macOS and Linux, and youtube-dl-exec's on Windows", () => {
    expect(standaloneBuild("darwin", "arm64", false)).toBe("yt-dlp_macos");
    expect(standaloneBuild("darwin", "x64", false)).toBe("yt-dlp_macos");
    expect(standaloneBuild("linux", "x64", true)).toBe("yt-dlp_linux");
    expect(standaloneBuild("linux", "arm64", true)).toBe("yt-dlp_linux_aarch64");
    // Alpine and the like use musl, not glibc.
    expect(standaloneBuild("linux", "x64", false)).toBe("yt-dlp_musllinux");
    expect(standaloneBuild("linux", "arm64", false)).toBe("yt-dlp_musllinux_aarch64");
    // youtube-dl-exec already downloads yt-dlp.exe, which needs nothing else.
    expect(standaloneBuild("win32", "x64", false)).toBeUndefined();
    // No standalone build: the Python version stays.
    expect(standaloneBuild("linux", "arm", true)).toBeUndefined();
    expect(standaloneBuild("freebsd", "x64", false)).toBeUndefined();
  });

  it("tells the Python version (a script) from a standalone build (a program)", () => {
    expect(isPythonScript(Buffer.from("#!/usr/bin/env python3\n"))).toBe(true);
    expect(isPythonScript(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBe(false); // ELF (Linux)
    expect(isPythonScript(Buffer.from([0xca, 0xfe, 0xba, 0xbe]))).toBe(false); // Mach-O (macOS)
    expect(isPythonScript(Buffer.from("MZ"))).toBe(false); // .exe
    expect(isPythonScript(Buffer.alloc(0))).toBe(false);
  });

  it("runs after every install, in the source and in the ready-to-run build", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    );
    expect(pkg.scripts.postinstall).toBe(
      "node scripts/yt-dlp.mjs && node scripts/ffmpeg-check.mjs",
    );
    expect(pkg.scripts["update-yt-dlp"]).toBe("node scripts/yt-dlp.mjs --update");
    // The install branch has the same package.json, so it needs the script too.
    const workflow = readFileSync(
      fileURLToPath(new URL("../../.github/workflows/install.yml", import.meta.url)),
      "utf8",
    );
    expect(workflow).toContain("scripts/yt-dlp.mjs scripts/ffmpeg-check.mjs");
  });
});

// --- Checking yt-dlp against the sums it publishes ----------------------------------

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
const REAL = "the real yt-dlp";
const SUMS = [
  `${sha256(REAL)}  yt-dlp_linux`,
  `${sha256("the real yt-dlp.exe")}  yt-dlp.exe`,
  `${sha256("zip")}  yt-dlp_linux.zip`,
].join("\n");

/** A stand-in for GitHub: the sums, and each file's download (or a refusal). */
function standIn(files: Record<string, string>, sums: string | null = SUMS) {
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const name = url.split("/").pop()!;
    const body = name === "SHA2-256SUMS" ? sums : files[name];
    if (body === null || body === undefined) return new Response("Not Found", { status: 404 });
    return new Response(body);
  };
  return { fetchImpl, asked };
}

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-yt-dlp-check-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("checking yt-dlp against its published SHA-256 sums", () => {
  it("knows each system's file in the release", () => {
    expect(releaseName("win32", "x64", false)).toBe("yt-dlp.exe");
    expect(releaseName("win32", "arm64", false)).toBe("yt-dlp.exe"); // what youtube-dl-exec gets
    expect(releaseName("darwin", "arm64", false)).toBe("yt-dlp_macos");
    expect(releaseName("linux", "x64", true)).toBe("yt-dlp_linux");
    expect(releaseName("linux", "arm", true)).toBe("yt-dlp"); // the Python version
  });

  it("reads SHA2-256SUMS", () => {
    const sums = parseSums(
      `${"A".repeat(64)}  yt-dlp.exe\r\n\n${"b".repeat(64)} *yt-dlp_macos\nnoise`,
    );
    expect(Object.fromEntries(sums)).toEqual({
      "yt-dlp.exe": "a".repeat(64),
      "yt-dlp_macos": "b".repeat(64),
    });
  });

  it("can't check offline, and says so", async () => {
    expect(await fetchSums(standIn({}, null).fetchImpl)).toBeUndefined();
    expect(await fetchSums(standIn({}, "nothing useful").fetchImpl)).toBeUndefined();
    const offline = async () => {
      throw new Error("getaddrinfo ENOTFOUND github.com");
    };
    expect(await fetchSums(offline as unknown as typeof fetch)).toBeUndefined();
  });

  it("installs a download only if it matches", async () => {
    const sums = parseSums(SUMS);
    const file = path.join(dir, "fresh");
    await downloadChecked(file, "yt-dlp_linux", sums, standIn({ "yt-dlp_linux": REAL }).fetchImpl);
    expect(await fs.readFile(file, "utf8")).toBe(REAL);

    const tampered = path.join(dir, "tampered");
    await expect(
      downloadChecked(
        tampered,
        "yt-dlp_linux",
        sums,
        standIn({ "yt-dlp_linux": "not yt-dlp" }).fetchImpl,
      ),
    ).rejects.toThrow(/isn't the one yt-dlp published/);
    // Nothing installed, and nothing half-written left behind.
    await expect(fs.stat(tampered)).rejects.toThrow();
    await expect(fs.stat(`${tampered}.download`)).rejects.toThrow();
    await expect(
      downloadChecked(tampered, "yt-dlp_other", sums, standIn({}).fetchImpl),
    ).rejects.toThrow(/no checksum/);
  });

  it("swaps an installed yt-dlp that doesn't match for a checked copy", async () => {
    const sums = parseSums(SUMS);
    const file = path.join(dir, "installed");
    await fs.writeFile(file, REAL);
    const quiet = standIn({ "yt-dlp_linux": REAL });
    expect(await checkInstalled(file, "yt-dlp_linux", sums, quiet.fetchImpl)).toBe("ok");
    expect(quiet.asked).toEqual([]); // nothing downloaded

    await fs.writeFile(file, "changed by something");
    expect(
      await checkInstalled(file, "yt-dlp_linux", sums, standIn({ "yt-dlp_linux": REAL }).fetchImpl),
    ).toBe("replaced");
    expect(await fs.readFile(file, "utf8")).toBe(REAL);

    // No checked copy to be had: the installed one stays (it may just be older).
    await fs.writeFile(file, "an older yt-dlp");
    expect(
      await checkInstalled(
        file,
        "yt-dlp_linux",
        sums,
        standIn({ "yt-dlp_linux": "bad" }).fetchImpl,
      ),
    ).toBe("unchecked");
    expect(await fs.readFile(file, "utf8")).toBe("an older yt-dlp");
    // Offline (no sums), or nothing installed: nothing to do.
    expect(await checkInstalled(file, "yt-dlp_linux", undefined)).toBe("unchecked");
    expect(await checkInstalled(path.join(dir, "missing"), "yt-dlp_linux", sums)).toBe("unchecked");
  });
});
