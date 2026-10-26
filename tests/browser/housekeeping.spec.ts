import { test, expect } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { stayOffline } from "./stand-ins";

// Housekeeping: a Save to folder with songs ffmpeg makes — one fine, one at a
// low bitrate, one cut short — a program named like a song, and two files that
// aren't songs; the real app checks them and deletes the ones ticked.

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath!, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
  });
}

const tone = (file: string, seconds: number, kbps: number) =>
  ffmpeg([
    ...["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`],
    ...["-c:a", "libmp3lame", "-b:a", `${kbps}k`, file],
  ]);

let folder: string;

test.beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-housekeeping-e2e-"));
  await tone(path.join(folder, "Good.mp3"), 3, 192);
  await tone(path.join(folder, "Low.mp3"), 3, 64);
  await tone(path.join(folder, "Cut.mp3"), 20, 128);
  const whole = await fs.readFile(path.join(folder, "Cut.mp3"));
  await fs.writeFile(path.join(folder, "Cut.mp3"), whole.subarray(0, whole.length / 4));
  await fs.writeFile(
    path.join(folder, "Fake.mp3"),
    Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4000)]),
  );
  await fs.writeFile(path.join(folder, "notes.txt"), "a note");
  await fs.writeFile(path.join(folder, "Song.mp3.part"), Buffer.alloc(100));
});

test.afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

test("Housekeeping finds songs that aren't audio, are cut short or low quality, and deletes the ones ticked", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  await request.put("/api/settings", { data: { saveFolder: folder, qualityBar: "128" } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  const rows = library.locator("ol > li");
  await expect(rows).toHaveCount(4);

  await library.getByRole("button", { name: "Housekeeping" }).click();
  const panel = library.getByRole("region", { name: "Housekeeping" });
  await panel.getByRole("button", { name: "Check 4 songs" }).click();
  await expect(panel.getByText("5 files to look at.", { exact: false })).toBeVisible();

  const group = (name: string) => panel.getByRole("region", { name });
  await expect(group("Not audio")).toContainText("Fake.mp3");
  await expect(group("Not audio")).toContainText("It's a Windows program, not audio.");
  await expect(group("Cut short")).toContainText("Cut.mp3");
  await expect(group("Cut short")).toContainText(/Plays 0:0\d of the 0:20 it says it is/);
  await expect(group("Low quality")).toContainText("64 kbps: below 128 kbps.");
  await expect(group("Other files")).toContainText("A download that didn't finish");
  // A half-finished download is ticked; another file isn't, until the person says so.
  await expect(panel.getByRole("checkbox", { name: "Delete “Song.mp3.part”" })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "Delete “notes.txt”" })).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Delete 4 files" })).toBeVisible();

  // The bar is a setting: off, the low-bitrate song isn't listed (and the app keeps it).
  const bar = panel.getByRole("combobox", { name: "Low quality" });
  await bar.selectOption({ label: "Don't check" });
  await expect(group("Low quality")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Delete 3 files" })).toBeVisible();
  await expect
    .poll(async () => (await (await request.get("/api/settings")).json()).qualityBar)
    .toBe("off");
  await bar.selectOption({ label: "Below 128 kbps" });
  await panel.getByRole("checkbox", { name: "Delete “Low.mp3”" }).uncheck();

  await panel.getByRole("button", { name: "Delete 3 files" }).click();
  await panel.getByRole("button", { name: /^Move to the (Trash|Recycle Bin)$/ }).click();
  await expect(panel.getByText(/Moved 3 files to the (Trash|Recycle Bin)\./)).toBeVisible();
  expect((await fs.readdir(folder)).sort()).toEqual(["Good.mp3", "Low.mp3", "notes.txt"]);
  await expect(rows).toHaveCount(2);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
});
