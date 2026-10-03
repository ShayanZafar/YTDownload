import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The double-click helpers in scripts/windows. Windows PowerShell 5.1 reads a
 * script without a byte-order mark in the PC's own code page, and cmd.exe can
 * misread a batch file with Unix line endings — so they're plain ASCII with
 * Windows (CRLF) line endings, which .gitattributes keeps in any checkout.
 */
const DIR = fileURLToPath(new URL("../../scripts/windows", import.meta.url));
const files = readdirSync(DIR)
  .sort()
  .map((name) => ({ name, bytes: readFileSync(path.join(DIR, name)) }));
const appScript = files.find((f) => f.name === "app.ps1")!.bytes.toString("ascii");
const actions = /ValidateSet\(([^)]*)\)/.exec(appScript)![1].match(/[\w-]+/g)!;

describe("the Windows scripts", () => {
  it("are the ones docs/run/README.md describes", () => {
    expect(files.map((f) => f.name)).toEqual([
      "app.ps1",
      "autostart-off.cmd",
      "autostart-on.cmd",
      "start.cmd",
      "stop.cmd",
      "update-yt-dlp.cmd",
      "update.cmd",
    ]);
  });

  it.each(files.map((f) => [f.name, f.bytes] as const))(
    "%s is plain ASCII with Windows line endings",
    (_name, bytes) => {
      expect(bytes.every((byte) => byte < 0x80)).toBe(true);
      const text = bytes.toString("ascii");
      expect(text.includes("\r\n")).toBe(true);
      expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
    },
  );

  it("each .cmd file runs app.ps1 with an action it has", () => {
    for (const { name, bytes } of files.filter((f) => f.name.endsWith(".cmd"))) {
      const action = /app\.ps1" ([\w-]+)/.exec(bytes.toString("ascii"))?.[1];
      expect(action, name).toBe(name.replace(/\.cmd$/, ""));
      expect(actions).toContain(action);
    }
  });
});

/**
 * The shortcuts at the top of the install branch (the ready-to-run build that
 * .github/workflows/install.yml makes): each runs its script in scripts\windows.
 * Update.cmd replaces them while it runs, and cmd.exe reads a batch file a
 * line at a time, so each does its work in one line.
 */
describe("the install branch's shortcuts", () => {
  const INSTALL = fileURLToPath(new URL("../../scripts/install", import.meta.url));
  const shortcuts = readdirSync(INSTALL)
    .filter((name) => name.endsWith(".cmd"))
    .sort();

  it("are Start, Stop and Update", () => {
    expect(shortcuts).toEqual(["Start.cmd", "Stop.cmd", "Update.cmd"]);
  });

  it.each(shortcuts)("%s runs its script in scripts\\windows, in one line", (name) => {
    const bytes = readFileSync(path.join(INSTALL, name));
    expect(bytes.every((byte) => byte < 0x80)).toBe(true);
    const text = bytes.toString("ascii");
    expect(text.replace(/\r\n/g, "").includes("\n")).toBe(false);
    const target = /^call "%~dp0scripts\\windows\\([\w-]+\.cmd)" %\* & exit \/b\r$/m.exec(
      text,
    )?.[1];
    expect(target).toBe(name.toLowerCase());
    expect(files.map((f) => f.name)).toContain(target);
  });

  it("are what the workflow puts in the branch, with the README and .gitignore", () => {
    const workflow = readFileSync(
      fileURLToPath(new URL("../../.github/workflows/install.yml", import.meta.url)),
      "utf8",
    );
    for (const file of [...shortcuts, ".gitignore", "README.md"]) {
      expect(existsSync(path.join(INSTALL, file)), file).toBe(true);
      expect(workflow).toContain(`scripts/install/${file}`);
    }
  });
});
