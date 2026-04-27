import { test, expect } from "@playwright/test";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { verifyMp3File } from "../utils/mp3";

// Stable, public, non-restricted test video:
// "Me at the zoo" - the very first video uploaded to YouTube (April 2005).
const TEST_VIDEO_URL = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

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

    await fs.rm(tmpDir, { recursive: true, force: true });
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
