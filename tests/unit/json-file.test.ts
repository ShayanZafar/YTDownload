import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { oneAtATime, writeJsonFile } from "../../server/json-file";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-json-file-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("writeJsonFile", () => {
  it("writes pretty JSON into a folder it makes, leaving no temp file", async () => {
    const file = path.join(dir, "data", "thing.json");
    await writeJsonFile(file, { a: 1, b: ["x"] });
    expect(await fs.readFile(file, "utf8")).toBe('{\n  "a": 1,\n  "b": [\n    "x"\n  ]\n}\n');
    expect(await fs.readdir(path.dirname(file))).toEqual(["thing.json"]);
  });

  it("replaces what was there", async () => {
    const file = path.join(dir, "thing.json");
    await writeJsonFile(file, { old: true });
    await writeJsonFile(file, [1, 2]);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual([1, 2]);
  });

  it.skipIf(process.platform === "win32")("can keep the file to this user alone", async () => {
    const file = path.join(dir, "secret.json");
    await writeJsonFile(file, {}, { mode: 0o600 });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("oneAtATime", () => {
  it("runs each change after the one before, failed or not", async () => {
    const queue = oneAtATime();
    const order: string[] = [];
    const slow = queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("slow");
      return 1;
    });
    const failing = queue(async () => {
      order.push("failing");
      throw new Error("nope");
    });
    const last = queue(async () => {
      order.push("last");
      return 3;
    });
    await expect(slow).resolves.toBe(1);
    await expect(failing).rejects.toThrow("nope");
    await expect(last).resolves.toBe(3);
    expect(order).toEqual(["slow", "failing", "last"]);
  });
});
