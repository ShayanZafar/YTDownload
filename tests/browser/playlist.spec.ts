import { test, expect } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import ffmpegPath from "ffmpeg-static";

// YouTube playlists in the playlist panel. The playlist and the saves are the
// test's own answers (no YouTube); the Save to folder, and the check of which
// videos are in it, are real.

const LIST = "PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb";
const LINK = `https://www.youtube.com/playlist?list=${LIST}`;
const THUMBNAIL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";
const videos = [
  ["jNQXAC9IVRw", "Me at the zoo", "jawed", 19],
  ["dQw4w9WgXcQ", "Never Gonna Give You Up", "Rick Astley", 213],
  ["fJ9rUzIMcZQ", "Bohemian Rhapsody", "Queen Official", 359],
] as const;
const PLAYLIST = {
  source: "youtube",
  kind: "playlist",
  id: LIST,
  url: LINK,
  name: "Road Trip",
  by: "Moomoo",
  image: null,
  maybeMore: false,
  tracks: videos.map(([id, title, channel, duration]) => ({
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    artists: channel,
    duration,
    explicit: false,
    thumbnail: THUMBNAIL,
  })),
};

/** Makes a short MP3 with no tags at `file` (recognised by its name, like a video saved as it is). */
function makeSong(file: string, seconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath!,
      [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`],
        ...["-c:a", "libmp3lame", "-b:a", "128k", file],
      ],
      { windowsHide: true },
    );
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
  });
}

// Opening a song can block WebKit on Windows for several seconds (see CLAUDE.md).
const START_SONG = { timeout: 90_000 };

test.describe("a YouTube playlist", () => {
  test.beforeEach(async ({ request }) => {
    await request.put("/api/settings", { data: { saveFolder: null } });
  });

  let folder: string | undefined;
  test.afterEach(async ({ page }) => {
    if (!folder) return;
    await page.close();
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    folder = undefined;
  });

  test("opens in the panel; picking a video opens it, with no search", async ({ page }) => {
    const asked = { playlists: [] as string[], searches: 0 };
    await page.route("**/api/youtube/playlist?*", async (route) => {
      asked.playlists.push(new URL(route.request().url()).searchParams.get("link") ?? "");
      await route.fulfill({ json: PLAYLIST });
    });
    await page.route("**/api/search?*", async (route) => {
      asked.searches++;
      await route.fulfill({ json: { results: [] } });
    });

    await page.goto("/");
    // Typed in the link box, without https://: it switches to Playlist.
    await page
      .getByLabel("YouTube link", { exact: true })
      .fill(`youtube.com/playlist?list=${LIST}`);
    await page.getByLabel("YouTube link", { exact: true }).press("Enter");

    const panel = page.getByRole("region", { name: /youtube playlist/i });
    await expect(panel.getByRole("heading", { name: "Road Trip" })).toBeVisible();
    await expect(panel.getByText("by Moomoo · 3 songs")).toBeVisible();
    await expect(page.getByRole("button", { name: "Playlist", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(asked.playlists).toEqual([`https://youtube.com/playlist?list=${LIST}`]);
    await expect(panel.getByRole("link", { name: "Open in YouTube" })).toHaveAttribute(
      "href",
      LINK,
    );

    await panel.getByRole("button", { name: /^never gonna give you up, by rick astley/i }).click();
    await expect(
      page.getByRole("button", { name: /^rename file: never gonna give you up/i }),
    ).toBeVisible();
    await expect(panel.getByRole("button", { name: /^never gonna give you up/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(asked.searches).toBe(0);

    // It's still open after a reload, and closes for good.
    await page.reload();
    await expect(panel.getByRole("heading", { name: "Road Trip" })).toBeVisible();
    await panel.getByRole("button", { name: "Close the YouTube playlist" }).click();
    await expect(panel).toHaveCount(0);
  });

  test("playlists opened before are listed under the box, to open again in a click", async ({
    page,
  }) => {
    const OTHER = "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI";
    await page.route("**/api/youtube/playlist?*", async (route) => {
      const link = new URL(route.request().url()).searchParams.get("link") ?? "";
      await route.fulfill({
        json: link.includes(OTHER)
          ? {
              ...PLAYLIST,
              id: OTHER,
              url: `https://www.youtube.com/playlist?list=${OTHER}`,
              name: "Chill",
              tracks: PLAYLIST.tracks.slice(0, 1),
            }
          : PLAYLIST,
      });
    });

    await page.goto("/");
    const box = page.getByLabel("YouTube link", { exact: true });
    await box.fill(LINK);
    await box.press("Enter");
    const panel = page.getByRole("region", { name: /youtube playlist/i });
    await expect(panel.getByRole("heading", { name: "Road Trip" })).toBeVisible();
    const box2 = page.getByLabel("Playlist link", { exact: true });
    await box2.fill(`https://www.youtube.com/playlist?list=${OTHER}`);
    await box2.press("Enter");
    await expect(panel.getByRole("heading", { name: "Chill" })).toBeVisible();

    // Newest first; the open one is marked.
    const recent = page.getByRole("navigation", { name: "Recent playlists" });
    const chill = recent.getByRole("button", { name: /^Chill, YouTube playlist, 1 song$/ });
    const roadTrip = recent.getByRole("button", { name: /^Road Trip, YouTube playlist, 3 songs$/ });
    await expect(recent.getByRole("listitem").first()).toContainText("Chill");
    await expect(chill).toHaveAttribute("aria-current", "true");

    await roadTrip.click();
    await expect(panel.getByRole("heading", { name: "Road Trip" })).toBeVisible();
    await expect(roadTrip).toHaveAttribute("aria-current", "true");
    await expect(recent.getByRole("listitem").first()).toContainText("Road Trip");

    // Closed, it's still listed — and the list is remembered.
    await panel.getByRole("button", { name: "Close the YouTube playlist" }).click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(chill).toBeVisible();
    await chill.click();
    await expect(panel.getByRole("heading", { name: "Chill" })).toBeVisible();

    // × takes one off the list.
    await recent.getByRole("button", { name: "Take “Road Trip” off the recent playlists" }).click();
    await expect(roadTrip).toHaveCount(0);
    await page.reload();
    await expect(chill).toBeVisible();
    await expect(roadTrip).toHaveCount(0);
  });

  test("with a Save to folder, shows what's in it, and Download saves the rest as they are", async ({
    page,
    request,
  }) => {
    // A real folder that has one of the videos already, named as the app names it.
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-yt-playlist-"));
    await fs.writeFile(path.join(folder, "Me at the zoo.mp3"), "");
    await request.put("/api/settings", { data: { saveFolder: folder } });
    const name = path.basename(folder);

    await page.route("**/api/youtube/playlist?*", (route) => route.fulfill({ json: PLAYLIST }));
    const saved: { url: string; name?: string; spotifyId?: string }[] = [];
    await page.route("**/api/video/save", async (route) => {
      const body = route.request().postDataJSON() as { url: string; name?: string };
      saved.push(body);
      const video = videos.find(([id]) => body.url.endsWith(id));
      const fileName = `${video?.[1]}.mp3`;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          JSON.stringify({ type: "progress", bytes: 1024 }),
          JSON.stringify({ type: "done", fileName, folder, path: fileName, bytes: 2048 }),
          "",
        ].join("\n"),
      });
    });
    let searches = 0;
    await page.route("**/api/search?*", async (route) => {
      searches++;
      await route.fulfill({ json: { results: [] } });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    await page.getByRole("textbox", { name: /playlist link/i }).fill(LINK);
    await page.getByRole("button", { name: /open playlist/i }).click();

    const panel = page.getByRole("region", { name: /youtube playlist/i });
    await expect(panel.getByText(`by Moomoo · 3 songs · 1 in “${name}” · 2 missing`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      panel.getByRole("button", { name: /^me at the zoo.*in the folder as/i }),
    ).toBeVisible();

    await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(2);
    await panel.getByRole("button", { name: "Download 2 songs" }).click();
    await expect(
      panel.getByRole("button", { name: /^bohemian rhapsody.*saved as/i }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: /^never gonna give you up.*saved as/i }),
    ).toBeVisible();
    await expect(page.getByText("Saved 2 songs to", { exact: false }).first()).toBeVisible();

    // Each video saved as it is: its own link, its own name, no search.
    expect(saved.map((s) => s.url)).toEqual([
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
    ]);
    expect(saved.every((s) => s.name === undefined && s.spotifyId === undefined)).toBe(true);
    expect(searches).toBe(0);
  });

  test("with a Save to folder, plays the songs in it in the playlist's order, and saves a playlist file", async ({
    page,
    request,
  }) => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-yt-playlist-"));
    // Two of the three videos, as the app saves them; the newer one listed first in Your music.
    await makeSong(path.join(folder, "Bohemian Rhapsody.mp3"), 20);
    await makeSong(path.join(folder, "Me at the zoo.mp3"), 20);
    await request.put("/api/settings", { data: { saveFolder: folder } });
    await page.route("**/api/youtube/playlist?*", (route) => route.fulfill({ json: PLAYLIST }));

    await page.goto("/");
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    await page.getByRole("textbox", { name: /playlist link/i }).fill(LINK);
    await page.getByRole("button", { name: /open playlist/i }).click();

    const panel = page.getByRole("region", { name: /youtube playlist/i });
    const play = panel.getByRole("button", { name: "Play 2 songs" });
    await expect(play).toBeVisible({ timeout: 30_000 });

    // Play: the playlist's order (the zoo first), not the folder's.
    await play.click(START_SONG);
    const player = page.getByRole("region", { name: "Music player" });
    await expect(player.getByTestId("player-title")).toHaveText("Me at the zoo");
    await player.getByRole("button", { name: "Next song" }).click(START_SONG);
    await expect(player.getByTestId("player-title")).toHaveText("Bohemian Rhapsody");
    await player.getByRole("button", { name: "Close the player" }).click(START_SONG);

    // Save playlist file: an .m3u8 in the folder, in the playlist's order.
    await panel.getByRole("button", { name: "Save playlist file" }).click();
    await expect(page.getByText("Saved “Road Trip.m3u8”").first()).toBeVisible();
    const text = await fs.readFile(path.join(folder, "Road Trip.m3u8"), "utf8");
    expect(text.split(/\r?\n/).filter((line) => line && !line.startsWith("#"))).toEqual([
      "Me at the zoo.mp3",
      "Bohemian Rhapsody.mp3",
    ]);
  });
});
