import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
// @ts-expect-error -- plain JavaScript (it runs straight after npm install), without type declarations
import { isPythonScript, standaloneBuild } from "../../scripts/yt-dlp.mjs";

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
    expect(pkg.scripts.postinstall).toBe("node scripts/yt-dlp.mjs");
    expect(pkg.scripts["update-yt-dlp"]).toBe("node scripts/yt-dlp.mjs --update");
    // The install branch has the same package.json, so it needs the script too.
    const workflow = readFileSync(
      fileURLToPath(new URL("../../.github/workflows/install.yml", import.meta.url)),
      "utf8",
    );
    expect(workflow).toContain("scripts/yt-dlp.mjs");
  });
});
