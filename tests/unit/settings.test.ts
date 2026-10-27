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
    expect(await store.get()).toEqual({
      saveFolder: null,
      qualityBar: "128",
      youtubeSignIn: "off",
    });
  });

  it("remembers the folder in a small JSON file", async () => {
    const saved = { saveFolder: "C:\\Music", qualityBar: "128", youtubeSignIn: "off" };
    expect(await store.update({ saveFolder: "C:\\Music" })).toEqual(saved);
    expect(await new SettingsStore(() => file).get()).toEqual(saved);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(saved);
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
    expect(await store.get()).toEqual({
      saveFolder: "/c",
      qualityBar: "128",
      youtubeSignIn: "off",
    });
  });

  it("keeps Housekeeping's quality bar: 128 kbps for a file from before it, or one that's wrong", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ saveFolder: "/music" }));
    expect(await store.get()).toEqual({
      saveFolder: "/music",
      qualityBar: "128",
      youtubeSignIn: "off",
    });
    expect(await store.update({ qualityBar: "lossless" })).toEqual({
      saveFolder: "/music",
      qualityBar: "lossless",
      youtubeSignIn: "off",
    });
    await fs.writeFile(file, JSON.stringify({ saveFolder: "/music", qualityBar: "999" }));
    expect(await store.get()).toEqual({
      saveFolder: "/music",
      qualityBar: "128",
      youtubeSignIn: "off",
    });
  });

  it("keeps YouTube sign-in off unless it's turned on, and off when the file says something else", async () => {
    expect((await store.update({ youtubeSignIn: "firefox" })).youtubeSignIn).toBe("firefox");
    expect((await new SettingsStore(() => file).get()).youtubeSignIn).toBe("firefox");
    await fs.writeFile(file, JSON.stringify({ saveFolder: null, youtubeSignIn: "chrome" }));
    expect((await store.get()).youtubeSignIn).toBe("off");
  });

  it("treats a damaged file as no settings rather than failing", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json");
    expect(await store.get()).toEqual({
      saveFolder: null,
      qualityBar: "128",
      youtubeSignIn: "off",
    });
    await fs.writeFile(file, JSON.stringify({ saveFolder: 42 }));
    expect(await store.get()).toEqual({
      saveFolder: null,
      qualityBar: "128",
      youtubeSignIn: "off",
    });
  });
});
