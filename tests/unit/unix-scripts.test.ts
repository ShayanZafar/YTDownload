import { describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The macOS and Linux helpers in scripts/unix: app.sh does the work, the .sh files run it from a
 * terminal and the .command files from Finder. A shell script with Windows line endings fails on
 * its first line, so they're plain ASCII with Unix (LF) endings, which .gitattributes keeps in any
 * checkout, and git stores them as executable, which is what makes them double-clickable.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIR = path.join(ROOT, "scripts", "unix");
const files = readdirSync(DIR)
  .sort()
  .map((name) => ({ name, text: readFileSync(path.join(DIR, name)).toString("latin1") }));
const app = files.find((f) => f.name === "app.sh")!.text;
const actions = [...app.matchAll(/^ {2}([\w-]+)\) /gm)].map((m) => m[1]);

/** Mode bits git stores for a file, e.g. "100755" (an executable). */
function gitMode(file: string): string {
  const line = execFileSync("git", ["ls-files", "-s", "--", file], { cwd: ROOT, encoding: "utf8" });
  return line.split(/\s+/)[0] ?? "";
}

/** A POSIX shell that can check syntax, if this computer has one (Git Bash on Windows counts). */
function shell(): string | undefined {
  const candidates = [
    "/bin/sh",
    "C:\\Program Files\\Git\\usr\\bin\\sh.exe",
    "C:\\Program Files\\Git\\bin\\sh.exe",
  ];
  return candidates.find((c) => existsSync(c));
}

describe("the macOS and Linux scripts", () => {
  it("are the ones docs/run/README.md describes", () => {
    expect(files.map((f) => f.name)).toEqual([
      "app.sh",
      "start.command",
      "start.sh",
      "stop.command",
      "stop.sh",
      "update-yt-dlp.sh",
      "update.command",
      "update.sh",
    ]);
  });

  it("offers start, stop, update and update-yt-dlp", () => {
    expect(actions).toEqual(["start", "stop", "update", "update-yt-dlp"]);
  });

  it.each(files.map((f) => [f.name, f.text] as const))(
    "%s is plain ASCII with Unix line endings and a shell shebang",
    (_name, text) => {
      expect([...text].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
      expect(text.includes("\r")).toBe(false);
      expect(text.startsWith("#!/usr/bin/env sh\n") || text.startsWith("#!/bin/sh\n")).toBe(true);
    },
  );

  it.each(files.map((f) => f.name))("%s is stored as executable", (name) => {
    expect(gitMode(`scripts/unix/${name}`)).toBe("100755");
  });

  it("each .sh and .command file runs app.sh with an action it has", () => {
    for (const { name, text } of files.filter((f) => f.name !== "app.sh")) {
      const action = /app\.sh"? ([\w-]+)/.exec(text)?.[1];
      expect(action, name).toBe(name.replace(/\.(sh|command)$/, ""));
      expect(actions).toContain(action);
    }
  });

  const sh = shell();
  it.skipIf(!sh)("all parse as POSIX shell", () => {
    for (const { name } of files) {
      expect(() => execFileSync(sh!, ["-n", path.join(DIR, name)]), name).not.toThrow();
    }
  });
});

/**
 * The shortcuts at the top of the install branch: like Start.cmd for Windows, Start.command (macOS)
 * and Start.sh (Linux) each run their action in scripts/unix/app.sh, in one line.
 */
describe("the install branch's macOS and Linux shortcuts", () => {
  const INSTALL = path.join(ROOT, "scripts", "install");
  const shortcuts = readdirSync(INSTALL)
    .filter((name) => /\.(command|sh)$/.test(name))
    .sort();

  it("are Start, Stop and Update, for macOS and for Linux", () => {
    expect(shortcuts).toEqual([
      "Start.command",
      "Start.sh",
      "Stop.command",
      "Stop.sh",
      "Update.command",
      "Update.sh",
    ]);
  });

  it.each(shortcuts)("%s runs its action in scripts/unix/app.sh and is executable", (name) => {
    const text = readFileSync(path.join(INSTALL, name)).toString("latin1");
    expect([...text].every((ch) => ch.charCodeAt(0) < 0x80)).toBe(true);
    expect(text.includes("\r")).toBe(false);
    const action = /scripts\/unix\/app\.sh"? ([\w-]+)/.exec(text)?.[1];
    expect(action).toBe(name.replace(/\.(command|sh)$/, "").toLowerCase());
    expect(actions).toContain(action);
    expect(gitMode(`scripts/install/${name}`)).toBe("100755");
  });

  it("are what the workflow puts in the branch, with scripts/unix", () => {
    const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "install.yml"), "utf8");
    for (const file of shortcuts) expect(workflow).toContain(`scripts/install/${file}`);
    expect(workflow).toContain("scripts/unix");
  });
});
