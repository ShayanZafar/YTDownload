import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { SettingsStore } from "../../server/settings";

let dir: string;
let file: string;
let store: SettingsStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-settings-"));
  file = path.join(dir, "data", "settings.json");
  store = new SettingsStore(() => file);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("starts with downloads going to the browser", async () => {
    expect(await store.get()).toEqual({ saveFolder: null });
  });

  it("remembers the folder in a small JSON file", async () => {
    expect(await store.update({ saveFolder: "C:\\Music" })).toEqual({ saveFolder: "C:\\Music" });
    expect(await new SettingsStore(() => file).get()).toEqual({ saveFolder: "C:\\Music" });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ saveFolder: "C:\\Music" });
    // No temp file left over.
    expect(await fs.readdir(path.dirname(file))).toEqual(["settings.json"]);
  });

  it("applies changes in order", async () => {
    await Promise.all([
      store.update({ saveFolder: "/a" }),
      store.update({ saveFolder: "/b" }),
      store.update({ saveFolder: null }),
      store.update({ saveFolder: "/c" }),
    ]);
    expect(await store.get()).toEqual({ saveFolder: "/c" });
  });

  it("treats a damaged file as no settings rather than failing", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json");
    expect(await store.get()).toEqual({ saveFolder: null });
    await fs.writeFile(file, JSON.stringify({ saveFolder: 42 }));
    expect(await store.get()).toEqual({ saveFolder: null });
  });
});
