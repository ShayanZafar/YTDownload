import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { FileStorage, MAX_HISTORY } from "../../server/storage";

let dir: string;
let file: string;
let store: FileStorage;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-test-"));
  file = path.join(dir, "nested", "history.json"); // folder doesn't exist yet
  store = new FileStorage(() => file);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("FileStorage (download history)", () => {
  it("starts empty when there's no history file", async () => {
    expect(await store.getDownloads()).toEqual([]);
  });

  it("saves downloads newest first, creating the folder and file", async () => {
    const first = await store.createDownload({ url: "https://youtu.be/a", title: "First" });
    const second = await store.createDownload({ url: "https://youtu.be/b", title: "Second" });

    expect(first).toMatchObject({ id: 1, title: "First" });
    expect(second.id).toBe(2);
    expect(new Date(second.downloadedAt).toISOString()).toBe(second.downloadedAt);

    const list = await store.getDownloads();
    expect(list.map((d) => d.title)).toEqual(["Second", "First"]);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(list);
  });

  it(`keeps only the newest ${MAX_HISTORY} entries`, async () => {
    for (let i = 1; i <= MAX_HISTORY + 5; i++) {
      await store.createDownload({ url: `https://youtu.be/${i}`, title: `Song ${i}` });
    }
    const list = await store.getDownloads();
    expect(list).toHaveLength(MAX_HISTORY);
    expect(list[0].title).toBe(`Song ${MAX_HISTORY + 5}`);
    expect(list.at(-1)!.title).toBe("Song 6");
  });

  it("doesn't lose entries when downloads finish at the same time", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.createDownload({ url: `https://youtu.be/${i}`, title: `Song ${i}` }),
      ),
    );
    const list = await store.getDownloads();
    expect(list).toHaveLength(20);
    expect(new Set(list.map((d) => d.id)).size).toBe(20);
  });

  it("recovers from an unreadable file, keeping a copy of it", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json", "utf8");

    expect(await store.getDownloads()).toEqual([]);
    const backups = (await fs.readdir(path.dirname(file))).filter((f) => f.includes(".broken-"));
    expect(backups.length).toBeGreaterThan(0);

    await store.createDownload({ url: "https://youtu.be/a", title: "After" });
    expect((await store.getDownloads()).map((d) => d.title)).toEqual(["After"]);
  });

  it("leaves no temp file behind after writing", async () => {
    await store.createDownload({ url: "https://youtu.be/a", title: "One" });
    expect(await fs.readdir(path.dirname(file))).toEqual(["history.json"]);
  });
});
