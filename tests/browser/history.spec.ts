import { test, expect, type APIRequestContext } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import type { Download } from "../../shared/schema";

// Taking songs out of Recent Extractions, and clearing it, with Undo — against
// the test server's own (throwaway) history, filled for the test.

const day = 24 * 60 * 60 * 1000;
const songs = ["Queen - Bohemian Rhapsody", "Daft Punk - Get Lucky", "ABBA - Dancing Queen"];
const history: Download[] = songs.map((title, i) => ({
  id: 900 + i,
  url: `https://www.youtube.com/watch?v=hist${String(i).padStart(7, "0")}`,
  title,
  downloadedAt: new Date(Date.now() - (i + 1) * day).toISOString(),
}));

const replaceHistory = async (request: APIRequestContext, entries: Download[]) => {
  await request.delete("/api/downloads");
  if (entries.length > 0) await request.post("/api/downloads/restore", { data: { entries } });
};

test.describe("Recent Extractions: removing songs (browser)", () => {
  // What the history held before (other tests' downloads), put back afterwards.
  let before: Download[] = [];
  test.beforeEach(async ({ request }) => {
    before = (await (await request.get("/api/downloads")).json()) as Download[];
    await replaceHistory(request, history);
  });
  test.afterEach(async ({ request }) => {
    await replaceHistory(request, before);
  });

  test("a song can be taken out and put back, and the whole list cleared and put back", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: /recent extractions/i }),
    });
    const rows = section.getByRole("listitem");
    await expect(rows).toHaveCount(3);

    // ×: it's gone from the list (and the app's history), with Undo in the note.
    await section
      .getByRole("button", { name: "Remove Daft Punk - Get Lucky from the history" })
      .click();
    await expect(rows).toHaveCount(2);
    await expect(section.getByText("Daft Punk - Get Lucky")).toBeHidden();
    const titles = async () =>
      ((await (await request.get("/api/downloads")).json()) as Download[]).map((e) => e.title);
    expect(await titles()).toEqual([songs[0], songs[2]]);
    await expect(
      page.getByText("Removed “Daft Punk - Get Lucky” from the history", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText("Daft Punk - Get Lucky");

    // Clear history asks first; Cancel keeps everything.
    await section.getByRole("button", { name: "Clear history" }).click();
    await section.getByRole("button", { name: "Cancel" }).click();
    await expect(rows).toHaveCount(3);
    await section.getByRole("button", { name: "Clear history" }).click();
    await section
      .getByRole("group", { name: "Clear the history?" })
      .getByRole("button", { name: "Clear history" })
      .click();
    await expect(section.getByText("No downloads yet")).toBeVisible();
    expect(await titles()).toEqual([]);
    await expect(
      page.getByText("Cleared 3 downloads from the history", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(rows).toHaveCount(3);
    expect(await titles()).toEqual(songs);
  });
});

/** Makes a short tagged MP3 at `file` with ffmpeg. */
function makeSong(file: string, title: string, artist: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath!,
      [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", "sine=frequency=440:duration=8"],
        ...["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"],
        ...["-metadata", `title=${title}`, "-metadata", `artist=${artist}`, file],
      ],
      { windowsHide: true },
    );
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`))));
  });
}

test.describe("Recent Extractions: finding downloads in the folder (browser)", () => {
  let before: Download[] = [];
  let folder: string;
  // Two downloads: one saved into the folder (since moved into a subfolder),
  // one whose file has gone.
  const saved: Download[] = [
    {
      id: 950,
      url: "https://www.youtube.com/watch?v=fold0000001",
      title: "Velvet Static - Neon Harbour (Official Video)",
      downloadedAt: new Date(Date.now() - day).toISOString(),
      fileName: "Neon Harbour.mp3",
    },
    {
      id: 951,
      url: "https://www.youtube.com/watch?v=fold0000002",
      title: "Velvet Static - Paper Lanterns",
      downloadedAt: new Date(Date.now() - 2 * day).toISOString(),
      fileName: "Paper Lanterns.mp3",
    },
  ];
  test.beforeEach(async ({ request }) => {
    before = (await (await request.get("/api/downloads")).json()) as Download[];
    await replaceHistory(request, saved);
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-history-folder-test-"));
    await fs.mkdir(path.join(folder, "Velvet Static"));
    await makeSong(
      path.join(folder, "Velvet Static", "Neon Harbour.mp3"),
      "Neon Harbour",
      "Velvet Static",
    );
    await request.put("/api/settings", { data: { saveFolder: folder } });
  });
  test.afterEach(async ({ request }) => {
    await request.put("/api/settings", { data: { saveFolder: null } });
    await replaceHistory(request, before);
    await fs.rm(folder, { recursive: true, force: true });
  });

  test("says which downloads are in the folder, finds one in Your music, plays it, and lists the missing", async ({
    page,
  }) => {
    await page.goto("/");
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: /recent extractions/i }),
    });
    const rows = section.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("In folder");
    await expect(rows.nth(1)).toContainText("Not in folder");
    await expect(rows.nth(1).getByRole("button", { name: /from the folder$/ })).toHaveCount(0);

    // In folder: it's found in Your music, scrolled to and picked out.
    await section
      .getByRole("button", {
        name: "Show Velvet Static - Neon Harbour (Official Video) in Your music",
      })
      .click();
    const located = page
      .getByRole("region", { name: "Your music" })
      .locator("li[data-located=true]");
    await expect(located).toHaveCount(1);
    await expect(located).toContainText("Neon Harbour");
    await expect(located).toBeInViewport();
    await expect(located.getByRole("button", { name: /^Play “Neon Harbour”/ })).toBeFocused();

    // Play: the player plays the file from the folder.
    await section
      .getByRole("button", {
        name: "Play Velvet Static - Neon Harbour (Official Video) from the folder",
      })
      .click({ timeout: 90_000 });
    const player = page.getByRole("region", { name: "Music player" });
    await expect(player.getByTestId("player-title")).toHaveText("Neon Harbour");
    await expect(
      section.getByRole("button", {
        name: "Pause Velvet Static - Neon Harbour (Official Video) from the folder",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await player.getByRole("button", { name: "Close the player" }).click();

    // Only the missing ones: the download whose file has gone, to save again.
    const views = section.getByRole("group", { name: /^Downloads in “/ });
    await views.getByRole("button", { name: "Not in folder", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("Velvet Static - Paper Lanterns");
    await views.getByRole("button", { name: "In folder", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText("Neon Harbour");
  });
});
