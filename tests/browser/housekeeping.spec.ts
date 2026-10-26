import { test, expect } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { stayOffline } from "./stand-ins";

// Housekeeping: a Save to folder with songs ffmpeg makes — one fine, one at a
// low bitrate, one cut short, one there twice — a program named like a song, and
// two files that aren't songs; the real app checks them and deletes the ones ticked.

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
  // The same song twice, from the owner's folder: the better-sounding copy is kept.
  await tone(path.join(folder, "Mike Shinoda - About You (feat. blackbear).mp3"), 3, 192);
  await tone(path.join(folder, "Mike Shinoda - About You feat. blackbear.mp3"), 4, 128);
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

test("Housekeeping finds songs that aren't audio, are cut short, low quality or extra copies, and deletes the ones ticked", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  await request.put("/api/settings", { data: { saveFolder: folder, qualityBar: "128" } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  const rows = library.locator("ol > li");
  await expect(rows).toHaveCount(6);

  await library.getByRole("button", { name: "Housekeeping" }).click();
  const panel = library.getByRole("region", { name: "Housekeeping" });
  await panel.getByRole("button", { name: "Check 6 songs" }).click();
  await expect(panel.getByText("6 files to look at.", { exact: false })).toBeVisible();

  const group = (name: string) => panel.getByRole("region", { name });
  await expect(group("Not audio")).toContainText("Fake.mp3");
  await expect(group("Not audio")).toContainText("It's a Windows program, not audio.");
  await expect(group("Cut short")).toContainText("Cut.mp3");
  await expect(group("Cut short")).toContainText(/Plays 0:0\d of the 0:20 it says it is/);
  await expect(group("Low quality")).toContainText("64 kbps: below 128 kbps.");
  await expect(group("Extra copies")).toContainText("Mike Shinoda - About You feat. blackbear.mp3");
  await expect(group("Extra copies")).toContainText(
    "The same song as “Mike Shinoda - About You (feat. blackbear).mp3”, the same length: that one is kept (192 kbps; this one 128 kbps).",
  );
  await expect(
    panel.getByRole("checkbox", { name: "Delete “Mike Shinoda - About You feat. blackbear.mp3”" }),
  ).toBeChecked();
  await expect(group("Other files")).toContainText("A download that didn't finish");
  // A half-finished download is ticked; another file isn't, until the person says so.
  await expect(panel.getByRole("checkbox", { name: "Delete “Song.mp3.part”" })).toBeChecked();
  await expect(panel.getByRole("checkbox", { name: "Delete “notes.txt”" })).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Delete 5 files" })).toBeVisible();

  // Another bar lists its songs once Check is pressed (the songs aren't read again).
  const bar = panel.getByRole("combobox", { name: "Low quality" });
  await bar.selectOption({ label: "Below 256 kbps" });
  await expect(
    panel.getByText("The list is for songs below 128 kbps until you press Check."),
  ).toBeVisible();
  await expect(group("Low quality")).not.toContainText("Good.mp3");
  await panel.getByRole("button", { name: "Check 6 songs" }).click();
  await expect(group("Low quality")).toContainText("Good.mp3");
  await expect(group("Low quality")).toContainText("192 kbps: below 256 kbps.");
  await expect(panel.getByRole("button", { name: "Delete 7 files" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Check 6 songs" })).toHaveCount(0);
  // The bar is a setting: off, the low-bitrate song isn't listed (and the app keeps it).
  await bar.selectOption({ label: "Don't check" });
  await panel.getByRole("button", { name: "Check 6 songs" }).click();
  await expect(group("Low quality")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Delete 4 files" })).toBeVisible();
  await expect
    .poll(async () => (await (await request.get("/api/settings")).json()).qualityBar)
    .toBe("off");
  await bar.selectOption({ label: "Below 128 kbps" });
  await panel.getByRole("button", { name: "Check 6 songs" }).click();
  await panel.getByRole("checkbox", { name: "Delete “Low.mp3”" }).uncheck();

  await panel.getByRole("button", { name: "Delete 4 files" }).click();
  await panel.getByRole("button", { name: /^Move to the (Trash|Recycle Bin)$/ }).click();
  await expect(panel.getByText(/Moved 4 files to the (Trash|Recycle Bin)\./)).toBeVisible();
  expect((await fs.readdir(folder)).sort()).toEqual([
    "Good.mp3",
    "Low.mp3",
    "Mike Shinoda - About You (feat. blackbear).mp3",
    "notes.txt",
  ]);
  await expect(rows).toHaveCount(3);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
});

test("a low-quality song can be replaced by a better copy instead of deleted", async ({
  page,
  request,
}) => {
  // Its own folder: two songs at 64 kbps, one with a better copy online (a stand-in for YouTube).
  const own = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-better-copy-e2e-"));
  try {
    await tone(path.join(own, "Sine Wave - Low Tone.mp3"), 3, 64);
    await tone(path.join(own, "Quiet.mp3"), 3, 64);
    await stayOffline(page);
    await request.put("/api/settings", { data: { saveFolder: own, qualityBar: "128" } });
    const { tracks } = (await (await request.get("/api/music")).json()) as {
      tracks: { id: string; path: string }[];
    };
    const lowTone = tracks.find((track) => track.path === "Sine Wave - Low Tone.mp3")!;
    // Looking for a better copy, and replacing the song with it, answered here: no network.
    const replaced: unknown[] = [];
    let replace: () => void = () => {};
    await page.route("**/api/music/*/better-copy", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/")[3];
      if (route.request().method() === "GET") {
        return route.fulfill({
          json:
            id === lowTone.id
              ? {
                  kbps: 64,
                  copy: {
                    url: "https://www.youtube.com/watch?v=ddddddddddd",
                    title: "Sine Wave - Low Tone",
                    channel: "Sine Wave",
                    source: "youtube",
                    seconds: 3,
                    kbps: 130,
                    codec: "Opus",
                  },
                  reason: null,
                }
              : {
                  kbps: 64,
                  copy: null,
                  reason: "No upload of “Quiet” found is the same length (0:03).",
                },
        });
      }
      replaced.push(route.request().postDataJSON());
      // Held until the test has seen it being replaced.
      await new Promise<void>((resolve) => (replace = resolve));
      const track = (await (await request.get("/api/music")).json()).tracks.find(
        (each: { id: string }) => each.id === id,
      );
      await route.fulfill({
        json: {
          track,
          check: {
            notAudio: null,
            cutShort: null,
            damaged: null,
            seconds: 3,
            kbps: 320,
            lossless: false,
            codec: "MPEG 1 Layer 3",
          },
          bin: "Trash",
        },
      });
    });

    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    await library.getByRole("button", { name: "Housekeeping" }).click();
    const panel = library.getByRole("region", { name: "Housekeeping" });
    await panel.getByRole("button", { name: "Check 2 songs" }).click();
    const low = panel.getByRole("region", { name: "Low quality" });
    await expect(low).toContainText("Quiet.mp3");
    await expect(low).toContainText("Sine Wave - Low Tone.mp3");
    await expect(panel.getByRole("button", { name: "Delete 2 files" })).toBeVisible();

    await low.getByRole("button", { name: "Find better copies" }).click();
    await expect(low).toContainText(
      "Replace it with YouTube's 130 kbps Opus copy, “Sine Wave - Low Tone” (Sine Wave).",
    );
    await expect(low).toContainText("No upload of “Quiet” found is the same length (0:03).");
    // The song with a better copy is ticked to be replaced, and no longer to be deleted.
    const replaceIt = panel.getByRole("checkbox", { name: "Replace “Sine Wave - Low Tone.mp3”" });
    await expect(replaceIt).toBeChecked();
    await expect(
      panel.getByRole("checkbox", { name: "Delete “Sine Wave - Low Tone.mp3”" }),
    ).not.toBeChecked();
    await expect(panel.getByRole("button", { name: "Delete 1 file" })).toBeVisible();
    await replaceIt.uncheck();
    await expect(low.getByRole("button", { name: /^Replace/ })).toHaveCount(0);
    await replaceIt.check();

    await low.getByRole("button", { name: "Replace 1 song" }).click();
    await expect(low).toContainText(
      "Replacing it with YouTube's 130 kbps Opus copy, “Sine Wave - Low Tone” (Sine Wave)…",
    );
    replace();
    await expect(
      panel.getByText("Replaced 1 song with a better copy; the old one is in the Trash."),
    ).toBeVisible();
    expect(replaced).toEqual([{ url: "https://www.youtube.com/watch?v=ddddddddddd" }]);
    // At 320 kbps now, it passes the bar: only the other song is left to look at.
    await expect(low).not.toContainText("Sine Wave - Low Tone.mp3");
    await expect(low).toContainText("Quiet.mp3");
    await expect(panel.getByRole("button", { name: "Delete 1 file" })).toBeVisible();
  } finally {
    await fs.rm(own, { recursive: true, force: true });
  }
});
