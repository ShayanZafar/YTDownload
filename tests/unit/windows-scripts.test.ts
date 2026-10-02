import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
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
