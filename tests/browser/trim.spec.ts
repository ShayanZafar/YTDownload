import { test, expect, type Page } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import ffmpegPath from "ffmpeg-static";

// Trimming a song in the Save to folder, on a song made for the test with
// dead air in it (no YouTube needed): pick the part with the two handles or
// the dead air the app found, hear the join, cut it out, and Undo.

/** Runs ffmpeg with `args`. */
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

/** Where the trim window's preview is, and whether it's playing. */
const preview = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector<HTMLAudioElement>("[data-testid=trim-preview-audio]")!;
    return { time: element.currentTime, paused: element.paused };
  });

let folder: string;
let song: string;

test.beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-trim-test-"));
  // 10 seconds: quiet, a tone (2–5 s), quiet (5–7 s), a tone (7–10 s).
  song = path.join(folder, "Gaps.mp3");
  await ffmpeg([
    ...["-f", "lavfi", "-i"],
    "aevalsrc=exprs='(between(t,2,5)+between(t,7,10))*0.5*sin(2*PI*440*t)':d=10:s=44100",
    ...["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"],
    ...["-metadata", "title=Gaps", "-metadata", "artist=Sine Wave", song],
  ]);
});

test.afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

test.afterEach(async ({ request }) => {
  await request.put("/api/settings", { data: { saveFolder: null } });
});

test("cuts the dead air picked out of a folder song, and Undo puts it back", async ({
  page,
  request,
}) => {
  const original = await fs.readFile(song);
  await request.put("/api/settings", { data: { saveFolder: folder } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  await expect(
    library.getByRole("button", { name: /^Play “Gaps”, by Sine Wave, 0:10/ }),
  ).toBeVisible();

  await library.getByRole("button", { name: "Trim: “Gaps”" }).click();
  const dialog = page.getByRole("dialog", { name: "Trim “Gaps”" });
  await expect(dialog).toBeVisible();

  // The dead air the app found; the first is picked to start with.
  const deadAir = dialog.getByRole("group", { name: "Dead air" }).getByRole("button");
  await expect(deadAir).toHaveCount(2);
  await expect(deadAir.first()).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("slider", { name: "Cut from" })).toHaveValue("0");

  // The handles move with the keyboard too, and the boxes take typed times.
  const from = dialog.getByRole("textbox", { name: "From" });
  const to = dialog.getByRole("textbox", { name: "To" });
  await dialog.getByRole("slider", { name: "Cut to" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(to).not.toHaveValue("0:02.0");
  // Pick the dead air in the middle, then set it exactly by typing.
  await deadAir.nth(1).click();
  await expect(deadAir.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(from).toHaveValue(/^0:05\.\d$/);
  await from.fill("0:05");
  await from.press("Enter");
  await expect(from).toHaveValue("0:05.0");
  await to.fill("7");
  await to.press("Enter");
  await expect(to).toHaveValue("0:07.0");
  await expect(dialog.getByText(/Cuts 2\.0 s · new length 0:08\.0/)).toBeVisible();

  // Hear the join: it plays from just before the cut and skips it.
  await dialog.getByRole("button", { name: "Hear the join" }).click();
  await expect.poll(async () => (await preview(page)).time, { timeout: 20_000 }).toBeGreaterThan(7);
  await dialog.getByRole("button", { name: "Pause the preview" }).click();

  await dialog.getByRole("button", { name: "Cut it out" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Cut 2.0 s out of “Gaps”", { exact: true })).toBeVisible();
  await expect(
    library.getByRole("button", { name: /^Play “Gaps”, by Sine Wave, 0:08/ }),
  ).toBeVisible();
  expect((await fs.readFile(song)).equals(original)).toBe(false);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Put back as it was", { exact: true })).toBeVisible();
  await expect(
    library.getByRole("button", { name: /^Play “Gaps”, by Sine Wave, 0:10/ }),
  ).toBeVisible();
  expect((await fs.readFile(song)).equals(original)).toBe(true);
});
