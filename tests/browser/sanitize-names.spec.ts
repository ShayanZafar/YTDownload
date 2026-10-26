import { test, expect } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { stayOffline } from "./stand-ins";

// Sanitize Filename and Rename: songs ffmpeg makes in a Save to folder, named the way
// videos and copies leave them, and the real app renaming the ones ticked.

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

let folder: string;
const NAMES = [
  "Junoon - Heer (Official Audio)",
  "Lithium HQ",
  "Queen - Bohemian Rhapsody",
  "Tone (1)",
];

test.beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-sanitize-e2e-"));
  // No title tags: the list names them by their files.
  for (const name of NAMES) {
    await ffmpeg([
      ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
      ...["-c:a", "libmp3lame", "-b:a", "128k", path.join(folder, `${name}.mp3`)],
    ]);
  }
});

test.afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

test("Sanitize Filename suggests tidy names and renames only the ones ticked, and Rename changes one", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  await request.put("/api/settings", { data: { saveFolder: folder } });
  await page.goto("/");
  const library = page.getByRole("region", { name: "Your music" });
  // The songs' own list (the panel's lists are listed too).
  const rows = library.locator("ol > li");
  await expect(rows).toHaveCount(4);

  await library.getByRole("button", { name: "Sanitize Filename" }).click();
  const panel = library.getByRole("region", { name: "Sanitize Filename" });
  // The tidy one isn't offered.
  await expect(
    panel.getByText("3 songs could have a tidier name.", { exact: false }),
  ).toBeVisible();
  await expect(panel.getByRole("checkbox", { name: /Queen/ })).toHaveCount(0);
  await expect(
    panel.getByRole("textbox", { name: "New name for “Junoon - Heer (Official Audio).mp3”" }),
  ).toHaveValue("Junoon - Heer");
  // A name can be changed first; one is left as it is.
  await panel
    .getByRole("textbox", { name: "New name for “Lithium HQ.mp3”" })
    .fill("Nirvana - Lithium");
  await panel.getByRole("checkbox", { name: "Rename “Tone (1).mp3”" }).uncheck();

  // The list isn't read again meanwhile (its answers held back): the renamed songs show at once.
  const held: (() => Promise<void>)[] = [];
  await page.route("**/api/music", (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return new Promise<void>((resolve) => held.push(() => route.continue().then(resolve)));
  });
  await panel.getByRole("button", { name: "Rename 2 songs" }).click();
  await expect(panel.getByText("Renamed 2 songs.")).toBeVisible();
  await expect(rows.filter({ hasText: "Nirvana - Lithium" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Official Audio" })).toHaveCount(0);
  const each = panel.getByRole("log", { name: "Each song" });
  await expect(each.getByRole("listitem").filter({ hasText: "Lithium HQ.mp3" })).toContainText(
    "is now “Nirvana - Lithium.mp3”",
  );
  await Promise.all(held.map((go) => go()));
  await page.unroute("**/api/music");

  expect((await fs.readdir(folder)).sort()).toEqual([
    "Junoon - Heer.mp3",
    "Nirvana - Lithium.mp3",
    "Queen - Bohemian Rhapsody.mp3",
    "Tone (1).mp3",
  ]);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(rows).toHaveCount(4);

  // Rename one song: its title and artist tags, and its file name with Sanitize's suggestion.
  await library.getByRole("button", { name: "Rename: “Tone (1)”" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename" });
  await dialog.getByRole("button", { name: "Sanitize: “Tone”" }).click();
  await expect(dialog.getByRole("textbox", { name: "File name" })).toHaveValue("Tone");
  await dialog.getByRole("textbox", { name: "Title" }).fill("Test Tone");
  await dialog.getByRole("textbox", { name: "Artist" }).fill("Sine Wave");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(rows.filter({ hasText: "Test Tone" })).toContainText("Sine Wave");
  await expect(rows).toHaveCount(4);
  expect(await fs.readdir(folder)).toContain("Tone.mp3");
});
