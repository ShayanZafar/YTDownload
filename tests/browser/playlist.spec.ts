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

// Opening a song can block WebKit on Windows for several seconds (see .claude/rules/music-player.md).
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
      await route.fulfill({ json: { results: [], source: "youtube" } });
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
      page.getByRole("button", { name: /^rename file: rick astley - never gonna give you up/i }),
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
      await route.fulfill({ json: { results: [], source: "youtube" } });
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

  test("with a Save to folder, each tick box changes its own song, and Download saves just the ticked ones", async ({
    page,
    request,
  }) => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-yt-playlist-"));
    await request.put("/api/settings", { data: { saveFolder: folder } });
    await page.route("**/api/youtube/playlist?*", (route) => route.fulfill({ json: PLAYLIST }));
    const saved: string[] = [];
    await page.route("**/api/video/save", async (route) => {
      const body = route.request().postDataJSON() as { url: string };
      saved.push(body.url);
      const video = videos.find(([id]) => body.url.endsWith(id));
      const fileName = `${video?.[1]}.mp3`;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          JSON.stringify({ type: "done", fileName, folder, path: fileName, bytes: 2048 }),
          "",
        ].join("\n"),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    await page.getByRole("textbox", { name: /playlist link/i }).fill(LINK);
    await page.getByRole("button", { name: /open playlist/i }).click();

    const panel = page.getByRole("region", { name: /youtube playlist/i });
    const download = (n: string) => panel.getByRole("button", { name: `Download ${n}` });
    await expect(download("3 songs")).toBeVisible({ timeout: 30_000 });

    // Each tick box changes only its own song, every time it's clicked.
    const tick = (title: string) => panel.getByRole("checkbox", { name: `Download “${title}”` });
    await tick("Never Gonna Give You Up").click();
    await expect(tick("Never Gonna Give You Up")).not.toBeChecked();
    await expect(download("2 songs")).toBeVisible();
    await tick("Me at the zoo").click();
    await expect(download("1 song")).toBeVisible();
    await tick("Never Gonna Give You Up").click();
    await expect(tick("Never Gonna Give You Up")).toBeChecked();
    await expect(tick("Me at the zoo")).not.toBeChecked();
    await expect(tick("Bohemian Rhapsody")).toBeChecked();
    await expect(download("2 songs")).toBeVisible();

    await download("2 songs").click();
    await expect(
      panel.getByRole("button", { name: /^bohemian rhapsody.*saved as/i }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: /^never gonna give you up.*saved as/i }),
    ).toBeVisible();
    expect(saved.sort()).toEqual([
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
    ]);
    await expect(tick("Me at the zoo")).not.toBeChecked();
  });

  test("Download keeps going through a new search and another playlist opened; only Stop cancels it", async ({
    page,
    request,
  }) => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-yt-playlist-"));
    await request.put("/api/settings", { data: { saveFolder: folder } });
    const OTHER_LIST = "PLaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER_LINK = `https://www.youtube.com/playlist?list=${OTHER_LIST}`;
    await page.route("**/api/youtube/playlist?*", (route) =>
      route.fulfill({
        json: route.request().url().includes(OTHER_LIST)
          ? {
              ...PLAYLIST,
              id: OTHER_LIST,
              url: OTHER_LINK,
              name: "Encores",
              tracks: [
                {
                  ...PLAYLIST.tracks[0],
                  id: "9bZkp7q19f0",
                  url: "https://www.youtube.com/watch?v=9bZkp7q19f0",
                  title: "Gangnam Style",
                },
              ],
            }
          : PLAYLIST,
      }),
    );
    await page.route("**/api/search?*", (route) =>
      route.fulfill({ json: { results: [], source: "youtube" } }),
    );
    // The saves are held until the search and the other playlist are open.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const saved: string[] = [];
    const aborted: string[] = [];
    await page.route("**/api/video/save", async (route) => {
      const body = route.request().postDataJSON() as { url: string };
      await held;
      const video = videos.find(([id]) => body.url.endsWith(id));
      const fileName = `${video?.[1]}.mp3`;
      try {
        await route.fulfill({
          contentType: "application/x-ndjson",
          body: [
            JSON.stringify({ type: "done", fileName, folder, path: fileName, bytes: 2048 }),
            "",
          ].join("\n"),
        });
        saved.push(body.url);
      } catch {
        aborted.push(body.url); // the page cancelled it
      }
    });
    page.on("requestfailed", (req) => {
      if (req.url().includes("/api/video/save")) aborted.push(req.url());
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    const box = page.getByRole("textbox", { name: /playlist link/i });
    await box.fill(LINK);
    await page.getByRole("button", { name: /open playlist/i }).click();
    const panel = page.getByRole("region", { name: /youtube playlist/i });
    await panel.getByRole("button", { name: "Download 3 songs" }).click({ timeout: 30_000 });
    await expect(panel.getByText("Downloading: 0 of 3 done…")).toBeVisible();

    // A new search, then another playlist: the download goes on, Stop still at hand.
    await page.getByRole("button", { name: "Search by song" }).click();
    const search = page.getByLabel("Song search", { exact: true });
    await search.fill("some other song");
    await search.press("Enter");
    await expect(page.getByText("No songs found")).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    await box.fill(OTHER_LINK);
    await page.getByRole("button", { name: /open playlist/i }).click();
    await expect(panel.getByRole("heading", { name: "Encores" })).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText("Downloading: 0 of 3 done…")).toBeVisible();

    release();
    await expect(page.getByText("Saved 3 songs to", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    expect(saved.sort()).toEqual([
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    ]);
    expect(aborted).toEqual([]);
    await expect(page.getByText("Downloads stopped")).toHaveCount(0);
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

// A long Spotify playlist that Spotify wouldn't share past 100 songs: the
// answers are the test's own (no Spotify); the Save to folder, and the check
// of which songs are in it, are real.
test.describe("a long Spotify playlist", () => {
  const ID = "1aBcDeFgHiJkLmNoPqRsTu";
  const SPOTIFY_LINK = `https://open.spotify.com/playlist/${ID}`;
  // The first 100 are "Song n", the ones that come later "Encore n".
  const song = (n: number) => {
    const id = `${String(n).padStart(4, "0")}Foc5Q5nqNiosCNqttz`.slice(0, 22);
    return {
      id,
      url: `https://open.spotify.com/track/${id}`,
      title: n < 100 ? `Song ${n}` : `Encore ${n}`,
      artists: "Band",
      duration: 200,
      explicit: false,
    };
  };
  const answer = (songs: number, more?: Record<string, string>) => ({
    source: "spotify",
    kind: "playlist",
    id: ID,
    url: SPOTIFY_LINK,
    name: "Trance Legends",
    by: "Shayan",
    image: null,
    tracks: Array.from({ length: songs }, (_, n) => song(n)),
    maybeMore: more !== undefined,
    ...(more && { more }),
  });
  const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

  /**
   * The playlist route: first Spotify's refusal (asking again in 2 seconds),
   * then — once the test lets it — the whole playlist.
   */
  async function refusedThenWhole(page: import("@playwright/test").Page) {
    let asked = 0;
    let letThrough!: () => void;
    const held = new Promise<void>((resolve) => (letThrough = resolve));
    await page.route("**/api/spotify/playlist?*", async (route) => {
      asked++;
      if (asked === 1) {
        return route.fulfill({ json: answer(100, { reason: "refused", retryAt: inSeconds(2) }) });
      }
      await held;
      await route.fulfill({ json: answer(150) });
    });
    return { asked: () => asked, letThrough };
  }

  /** Holds the page's looks through the folder (the real route) while the test says. */
  async function folderChecks(page: import("@playwright/test").Page) {
    let held: Promise<void> | undefined;
    let release = () => {};
    let waiting = 0;
    await page.route("**/api/folders/songs", async (route) => {
      if (held) {
        waiting++;
        await held;
      }
      await route.continue();
    });
    return {
      hold() {
        held = new Promise((resolve) => (release = resolve));
      },
      release() {
        held = undefined;
        release();
      },
      waiting: () => waiting,
    };
  }

  let folder: string | undefined;
  test.beforeEach(async ({ request }) => {
    folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-sp-playlist-"));
    // One of the songs that come later is in the folder already, named as the app names it.
    await fs.writeFile(path.join(folder, "Band - Encore 140.mp3"), "");
    await request.put("/api/settings", { data: { saveFolder: folder } });
  });
  test.afterEach(async ({ page, request }) => {
    await page.close();
    await request.put("/api/settings", { data: { saveFolder: null } });
    if (folder)
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    folder = undefined;
  });

  const open = async (page: import("@playwright/test").Page) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    await page.getByRole("textbox", { name: /playlist link/i }).fill(SPOTIFY_LINK);
    await page.getByRole("button", { name: /open playlist/i }).click();
    return page.getByRole("region", { name: /spotify playlist/i });
  };

  test("fills in by itself when Spotify refused the rest, keeping the filter and ticks", async ({
    page,
  }) => {
    const spotify = await refusedThenWhole(page);
    const checks = await folderChecks(page);
    const panel = await open(page);
    const name = path.basename(folder!);
    await expect(
      panel.getByText(`by Shayan · 100 songs · 0 in “${name}” · 100 missing`),
    ).toBeVisible({ timeout: 30_000 });
    // The time Spotify gave, or "shortly" once it has passed (2 seconds go by
    // quickly in a slow browser).
    await expect(panel.getByTestId("playlist-more")).toHaveText(
      /^Spotify isn't sharing more of this playlist right now \(too many requests from this computer\)\. The app asks again by itself ((tomorrow )?at about .+|shortly), and the rest appear here then\.$/,
    );

    // While it waits: a filter, and a song unticked.
    const filter = panel.getByRole("searchbox", { name: "Filter the playlist's songs" });
    await filter.fill("12");
    await expect(panel.getByRole("checkbox")).toHaveCount(1);
    await panel.getByRole("checkbox", { name: "Download “Song 12”" }).uncheck();

    // At the time Spotify gave, the page asks again by itself; the rest arrive.
    await expect.poll(spotify.asked, { timeout: 20_000 }).toBe(2);
    checks.hold();
    spotify.letThrough();
    // Song 12, Encore 112 and Encore 120–129.
    await expect(panel.getByRole("checkbox")).toHaveCount(12, { timeout: 20_000 });
    await expect(filter).toHaveValue("12");
    await expect(panel.getByRole("checkbox", { name: "Download “Song 12”" })).not.toBeChecked();
    await expect(panel.getByRole("checkbox", { name: "Download “Encore 125”" })).toBeChecked();
    await expect(panel.getByTestId("playlist-more")).toHaveCount(0);
    // Until the folder has been looked through for the new songs, nothing can
    // be downloaded: some of them may be there already.
    await expect.poll(checks.waiting, { timeout: 20_000 }).toBeGreaterThan(0);
    const download = panel.getByRole("button", { name: /^Download\b/ });
    await expect(download).toBeDisabled();
    checks.release();
    await expect(download).toBeEnabled({ timeout: 30_000 });

    // The folder was looked through for the new songs too.
    await filter.fill("");
    await expect(
      panel.getByText(`by Shayan · 150 songs · 1 in “${name}” · 149 missing`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      panel.getByRole("button", { name: /^encore 140.*in the folder as/i }),
    ).toBeVisible();
    expect(spotify.asked()).toBe(2);
  });

  test("another playlist never shows the last one's folder marks while its own are looked for", async ({
    page,
  }) => {
    const OTHER = "9zYxWvUtSrQpOnMlKjIhGf";
    const OTHER_LINK = `https://open.spotify.com/playlist/${OTHER}`;
    await page.route("**/api/spotify/playlist?*", (route) =>
      route.fulfill({
        json: new URL(route.request().url()).searchParams.get("link")?.includes(OTHER)
          ? {
              ...answer(0),
              id: OTHER,
              url: OTHER_LINK,
              name: "Encores",
              tracks: [song(140), song(141)],
            }
          : answer(150),
      }),
    );
    const checks = await folderChecks(page);
    const panel = await open(page);
    const name = path.basename(folder!);
    await expect(
      panel.getByText(`by Shayan · 150 songs · 1 in “${name}” · 149 missing`),
    ).toBeVisible({ timeout: 30_000 });

    checks.hold();
    await page.getByRole("textbox", { name: /playlist link/i }).fill(OTHER_LINK);
    await page.getByRole("button", { name: /open playlist/i }).click();
    await expect(panel.getByRole("heading", { name: "Encores" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(checks.waiting, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(panel.getByText(`by Shayan · 2 songs · checking “${name}”…`)).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Download\b/ })).toHaveCount(0);

    checks.release();
    await expect(panel.getByText(`by Shayan · 2 songs · 1 in “${name}” · 1 missing`)).toBeVisible({
      timeout: 30_000,
    });
  });

  test("after Untick all, the songs that arrive later are unticked too", async ({ page }) => {
    const spotify = await refusedThenWhole(page);
    const panel = await open(page);
    await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(100, {
      timeout: 30_000,
    });
    await panel.getByRole("button", { name: "Untick all" }).click();
    await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(0);

    await expect.poll(spotify.asked, { timeout: 20_000 }).toBe(2);
    spotify.letThrough();
    await expect(panel.getByRole("checkbox")).toHaveCount(149, { timeout: 30_000 });
    await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Tick all" })).toBeVisible();
  });

  test("says what failed, and that the app tries again in a minute", async ({ page }) => {
    await page.route("**/api/spotify/playlist?*", (route) =>
      route.fulfill({
        json: answer(100, { reason: "failed", note: "HTTP 503", retryAt: inSeconds(60) }),
      }),
    );
    const panel = await open(page);
    await expect(panel.getByTestId("playlist-more")).toHaveText(
      "Couldn't get the rest of this playlist from Spotify (HTTP 503). The app tries again in a minute.",
    );
  });
});
