import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { isNotFound, loadNotFound, resetNotFound, setNotFound } from "../../server/not-found";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-not-found-"));
  file = path.join(dir, "data", "details-not-found.json");
  process.env.DETAILS_NOT_FOUND_FILE = file;
  resetNotFound();
});

afterEach(async () => {
  delete process.env.DETAILS_NOT_FOUND_FILE;
  resetNotFound();
  await fs.rm(dir, { recursive: true, force: true });
});

const saved = async () => JSON.parse(await fs.readFile(file, "utf8"));

describe("Not found marks", () => {
  it("are kept by place and size in a JSON file, with no temp file left", async () => {
    await setNotFound({ relative: "a.mp3", size: 10 }, true);
    expect(await saved()).toEqual({ "a.mp3": 10 });
    expect(await fs.readdir(path.dirname(file))).toEqual(["details-not-found.json"]);
    expect(isNotFound({ relative: "a.mp3", size: 10 })).toBe(true);
    // The same song changed since (another size) is no longer marked.
    expect(isNotFound({ relative: "a.mp3", size: 11 })).toBe(false);
  });

  it("come off, and are all saved when many change at once", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => setNotFound({ relative: `${i}.mp3`, size: i }, true)),
    );
    await setNotFound({ relative: "3.mp3", size: 3 }, false);
    const marks = await saved();
    expect(Object.keys(marks)).toHaveLength(19);
    expect(marks["3.mp3"]).toBeUndefined();
    // Read back fresh, as the app does when it starts.
    resetNotFound();
    expect((await loadNotFound()).size).toBe(19);
  });

  it("read a damaged file as none", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json");
    expect((await loadNotFound()).size).toBe(0);
  });
});
