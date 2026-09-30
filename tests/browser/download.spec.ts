import { test, expect, type Page } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { verifyMp3File } from "../utils/mp3";
import { verifyOriginalAudioFile } from "../utils/original-audio";

// Stable, public, non-restricted test video:
// "Me at the zoo" - the very first video uploaded to YouTube (April 2005).
const TEST_VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

// History rows for the test video in the "Recent Extractions" list.
const historyRows = (page: Page) =>
  page
    .locator("section", { has: page.getByRole("heading", { name: /recent extractions/i }) })
    .getByRole("listitem")
    .filter({ hasText: /me at the zoo/i });

test.describe("YouTube → MP3 end-to-end (browser)", () => {
  test("user pastes a URL, previews the video, and downloads a valid MP3", async ({ page }) => {
    await page.goto("/");

    // Hero is visible.
    await expect(page.getByRole("heading", { name: /Convert any YouTube video/i })).toBeVisible();

    // 1. Paste the URL into the input.
    const input = page.locator('input[type="url"]');
    await expect(input).toBeVisible();
    await input.fill(TEST_VIDEO_URL);

    // 2. Submit the form (Extract button).
    await page.getByRole("button", { name: /extract/i }).click();

    // 3. Wait for the preview card to render with the video title and the download link.
    const downloadLink = page.locator('a[href^="/api/video/download"]', {
      hasText: /download audio/i,
    });
    await expect(downloadLink).toBeVisible({ timeout: 60_000 });

    // The preview should show the title and a thumbnail.
    await expect(page.locator("img[alt]").first()).toBeVisible();

    // 4. Click the download link and capture the file the browser saves.
    await expect(page.getByText(/recent extractions/i)).toBeVisible();
    const rowsBefore = await historyRows(page).count();
    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
    await downloadLink.click();
    const download = await downloadPromise;

    // The suggested filename should end with .mp3.
    expect(download.suggestedFilename()).toMatch(/\.mp3$/i);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-browser-test-"));
    const savedPath = path.join(tmpDir, download.suggestedFilename());
    await download.saveAs(savedPath);

    // 5. Verify the saved file is actually an MP3.
    const verdict = await verifyMp3File(savedPath);
    expect(
      verdict.isValid,
      `Downloaded file is not a valid MP3: ${verdict.reason} (size=${verdict.size})`,
    ).toBe(true);
    expect(verdict.size).toBeGreaterThan(10_000);

    // 6. Once the download has finished, it shows up in Recent Extractions by itself.
    await expect(historyRows(page)).toHaveCount(rowsBefore + 1, { timeout: 20_000 });

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("the Original audio toggle downloads YouTube's own stream, unconverted", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('input[type="url"]').fill(TEST_VIDEO_URL);
    await page.locator('button[type="submit"]').click();

    const downloadLink = page.locator('a[href^="/api/video/download"]', {
      hasText: /download audio/i,
    });
    await expect(downloadLink).toBeVisible({ timeout: 60_000 });
    await expect(downloadLink).toContainText(/mp3/i); // MP3 is the default

    await page.getByRole("switch", { name: /original audio/i }).click();
    await expect(downloadLink).toContainText(/original/i);
    await expect(downloadLink).toHaveAttribute("href", /format=original/);

    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
    await downloadLink.click();
    const download = await downloadPromise;

    const ext = /\.(opus|m4a|mka)$/i.exec(download.suggestedFilename())?.[1];
    expect(ext, `unexpected filename: ${download.suggestedFilename()}`).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-browser-test-"));
    const savedPath = path.join(tmpDir, download.suggestedFilename());
    await download.saveAs(savedPath);
    const verdict = await verifyOriginalAudioFile(savedPath, ext!.toLowerCase());
    expect(verdict.isValid, `Not a valid .${ext}: ${verdict.reason}`).toBe(true);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("user searches for a song, picks a result, and gets its download link", async ({ page }) => {
    await page.goto("/");

    // Link mode is the default; switch to searching by song.
    const searchMode = page.getByRole("button", { name: /search by song/i });
    await expect(searchMode).toHaveAttribute("aria-pressed", "false");
    await searchMode.click();
    await expect(searchMode).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("searchbox", { name: /song search/i }).fill("me at the zoo jawed");
    await page.getByRole("button", { name: /^search$/i }).click();

    const results = page.getByRole("region", { name: /search results/i });
    const zoo = results.getByRole("button", { name: /^me at the zoo, by /i }).first();
    await expect(zoo).toBeVisible({ timeout: 60_000 });
    await zoo.click();
    await expect(zoo).toHaveAttribute("aria-pressed", "true");

    // The preview card offers the picked video for download.
    const downloadLink = page.locator('a[href^="/api/video/download"]', {
      hasText: /download audio/i,
    });
    await expect(downloadLink).toBeVisible();
    await expect(downloadLink).toHaveAttribute("href", /jNQXAC9IVRw/);

    // Search mode is remembered on reload.
    await page.reload();
    await expect(page.getByRole("button", { name: /search by song/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // A link typed into the search box is opened instead of searched for.
    await page.getByRole("searchbox", { name: /song search/i }).fill(TEST_VIDEO_URL);
    await page.getByRole("button", { name: /^search$/i }).click();
    await expect(page.getByRole("button", { name: /paste a link/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(downloadLink).toBeVisible({ timeout: 60_000 });
  });

  test("a Spotify song link finds the same song on YouTube, ready to download", async ({
    page,
  }) => {
    await page.goto("/");

    // Pasted into the link box: it's a song to look up, so it's searched for.
    await page
      .locator('input[type="url"]')
      .fill("https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv?si=e2e");
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("button", { name: /search by song/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const results = page.getByRole("region", { name: /search results/i });
    await expect(results.getByText(/from spotify/i)).toBeVisible({ timeout: 60_000 });
    await expect(results.getByText(/bohemian rhapsody/i).first()).toBeVisible();

    // The best match is picked straight away, with a download link.
    await expect(results.getByRole("button", { pressed: true })).toHaveCount(1);
    await expect(
      page.locator('a[href^="/api/video/download"]', { hasText: /download audio/i }),
    ).toBeVisible();
  });

  test("Save to: a chosen folder gets the MP3 instead of the browser's downloads", async ({
    page,
  }) => {
    // The real folder picker is a native Windows dialog a test can't click
    // through, so give the page a folder in the browser's private storage
    // (OPFS) instead. It's a real folder handle, written to the same way.
    await page.context().addInitScript(() => {
      (window as unknown as { showDirectoryPicker: () => Promise<unknown> }).showDirectoryPicker =
        async () => {
          const root = await navigator.storage.getDirectory();
          return root.getDirectoryHandle("Music", { create: true });
        };
    });
    const readFolder = () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const music = await root.getDirectoryHandle("Music", { create: true });
        const files: { name: string; base64: string }[] = [];
        for await (const handle of (
          music as unknown as { values(): AsyncIterable<FileSystemHandle> }
        ).values()) {
          if (handle.kind !== "file") continue;
          const file = await (handle as FileSystemFileHandle).getFile();
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(file);
          });
          files.push({ name: handle.name, base64: dataUrl.split(",")[1] ?? "" });
        }
        return files;
      });
    let browserDownloads = 0;
    page.on("download", () => browserDownloads++);

    await page.goto("/");
    await page.locator('input[type="url"]').fill(TEST_VIDEO_URL);
    await page.getByRole("button", { name: /extract/i }).click();
    await page.getByRole("button", { name: /choose folder/i }).click({ timeout: 60_000 });
    await expect(page.getByTestId("save-folder-name")).toHaveText("Music");

    const downloadLink = page.locator('a[href^="/api/video/download"]', {
      hasText: /download audio/i,
    });
    const rowsBefore = await historyRows(page).count();

    // Cancelling part-way leaves nothing in the folder and nothing in the history.
    await downloadLink.click();
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(page.getByText(/download cancelled/i).first()).toBeVisible();
    expect(await readFolder()).toEqual([]);

    // A full download lands in the folder as a real MP3.
    await downloadLink.click();
    await expect(page.getByText(/is in your "Music" folder/i).first()).toBeVisible({
      timeout: 90_000,
    });
    const files = await readFolder();
    expect(files.map((f) => f.name)).toEqual([expect.stringMatching(/\.mp3$/)]);
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-folder-test-"));
    const savedPath = path.join(tmpDir, files[0].name);
    await fs.writeFile(savedPath, Buffer.from(files[0].base64, "base64"));
    const verdict = await verifyMp3File(savedPath);
    expect(verdict.isValid, `Saved file is not a valid MP3: ${verdict.reason}`).toBe(true);
    await fs.rm(tmpDir, { recursive: true, force: true });

    expect(browserDownloads).toBe(0);
    await expect(historyRows(page)).toHaveCount(rowsBefore + 1, { timeout: 20_000 });

    // The folder is remembered after a reload (restored from IndexedDB).
    await page.reload();
    await page.locator('input[type="url"]').fill(TEST_VIDEO_URL);
    await page.getByRole("button", { name: /extract/i }).click();
    await expect(page.getByTestId("save-folder-name")).toHaveText("Music", { timeout: 60_000 });
  });

  test("Recent Extractions can be searched, with suggestions and date filters", async ({
    page,
  }) => {
    // A made-up history, so the test doesn't depend on what's been downloaded.
    const day = 24 * 60 * 60 * 1000;
    const songs: [string, number][] = [
      ["Progression - Ocean Green (2004)", 0.1],
      ["Progression - Ocean Green (2004)", 0.2], // downloaded twice
      ["Ocean Eyes - Billie Eilish", 2],
      ["Queen - Bohemian Rhapsody", 10],
      ...Array.from({ length: 30 }, (_, i): [string, number] => [`Old song ${i + 1}`, 40 + i]),
    ];
    const history = songs.map(([title, daysAgo], i) => ({
      id: songs.length - i,
      url: `https://www.youtube.com/watch?v=test${String(i).padStart(7, "0")}`,
      title,
      downloadedAt: new Date(Date.now() - daysAgo * day).toISOString(),
    }));
    await page.route("**/api/downloads", (route) => route.fulfill({ json: history }));
    await page.goto("/");

    const section = page.locator("section", {
      has: page.getByRole("heading", { name: /recent extractions/i }),
    });
    const rows = section.getByRole("listitem");
    const search = section.getByRole("combobox", { name: /search your extractions/i });
    const suggestions = page.getByRole("option");

    // A long history shows a page at a time.
    await expect(rows).toHaveCount(25);
    await section.getByRole("button", { name: /show more/i }).click();
    await expect(rows).toHaveCount(history.length);

    // Every word typed must match, and partial words count.
    await search.fill("ocea gre");
    await expect(rows).toHaveCount(2);
    // Suggestions list each song once, with how many times it was downloaded.
    await expect(suggestions).toHaveCount(1);
    await expect(suggestions.first()).toContainText("2×");

    // Picking a suggestion (keyboard) shows exactly that song.
    await search.fill("ocean");
    await expect(suggestions).toHaveCount(2);
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(search).toHaveValue("Ocean Eyes - Billie Eilish");
    await expect(suggestions).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(section.getByText(/showing only/i)).toBeVisible();

    // Date filters, alone and with a search.
    await section.getByRole("button", { name: /show everything/i }).click();
    await section.getByRole("button", { name: /^older$/i }).click();
    await expect(rows).toHaveCount(25);
    await expect(section.getByText("30 of 34")).toBeVisible();
    await section.getByRole("button", { name: /^past week$/i }).click();
    await expect(rows).toHaveCount(3);
    await search.fill("queen");
    await expect(section.getByText(/nothing found/i)).toBeVisible();
    await section.getByRole("button", { name: /clear search and filters/i }).click();
    await expect(search).toHaveValue("");
    await expect(rows).toHaveCount(25);
  });

  test("invalid URL surfaces a friendly error toast", async ({ page }) => {
    await page.goto("/");

    const input = page.locator('input[type="url"]');
    await input.fill("https://example.com/not-a-youtube-video");
    await page.getByRole("button", { name: /extract/i }).click();

    // Either an inline error block or a toast should appear with a message.
    const errorRegion = page.getByText(/invalid youtube url|couldn't fetch|invalid url/i);
    await expect(errorRegion.first()).toBeVisible({ timeout: 30_000 });
  });
});
