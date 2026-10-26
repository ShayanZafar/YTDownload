import { test as base, expect, type Page } from "@playwright/test";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { verifyMp3File } from "../utils/mp3";
import {
  THUMBNAIL,
  answerHistory,
  downloadHeaders,
  makeSong,
  queryOf,
  startFront,
  stayOffline,
  type Front,
} from "./stand-ins";

// Getting a song, in the browser: from a pasted YouTube or Spotify link, into
// the browser's downloads or a folder picked in the app, and from SoundCloud
// when YouTube can't answer. YouTube, Spotify and SoundCloud are played by
// stand-ins (./stand-ins.ts): the app's answers that need them come from the
// test, the audio is a song ffmpeg makes, and nothing reaches another site.
// The rest is the real app. (download.spec.ts's @live tests use the real ones.)

/** Each test opens the page through a stand-in front, which can answer browser downloads. */
const test = base.extend<{ front: Front }>({
  front: async ({ baseURL }, use) => {
    const front = await startFront(baseURL!);
    await use(front);
    await front.close();
  },
});

const VIDEO_ID = "jNQXAC9IVRw";
const VIDEO = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

/** The download link of the video or track that's open. */
const downloadLink = (page: Page) =>
  page.locator('a[href^="/api/video/download"]', { hasText: /download audio/i });

/**
 * The name the browser saves a download under, given the name the app sends. Playwright's WebKit
 * on Linux (WebKitGTK) puts underscores for the spaces of a name it's sent (both with and without
 * `filename*`); every other engine, and WebKit elsewhere, keeps the name as sent.
 */
const savedName = (sent: string, browserName: string) =>
  browserName === "webkit" && process.platform === "linux" ? sent.replaceAll(" ", "_") : sent;

/** The rows of Recent Extractions that match `text`. */
const historyRows = (page: Page, text: RegExp) =>
  page
    .locator("section", { has: page.getByRole("heading", { name: /recent extractions/i }) })
    .getByRole("listitem")
    .filter({ hasText: text });

/** The app's answer to opening a pasted link: the video's title, thumbnail and channel. */
async function answerVideoInfo(page: Page, title: string, asked: string[] = [], channel?: string) {
  await page.route("**/api/video/info", async (route) => {
    const { url } = route.request().postDataJSON() as { url: string };
    asked.push(url);
    await route.fulfill({
      json: { title, thumbnail: THUMBNAIL, url, ...(channel && { channel }) },
    });
  });
  return asked;
}

/**
 * The app's answer to a download, through the front: `song`, under the name the page asked for
 * (or `title`); `done` is told what was asked once the browser has the whole file.
 */
function answerDownloads(
  front: Front,
  song: Buffer,
  title: string,
  done: (query: Record<string, string>) => void,
) {
  front.answer("/api/video/download", (_req, res, url) => {
    const query = Object.fromEntries(url.searchParams);
    res.writeHead(200, downloadHeaders(`${query.name ?? title}.mp3`));
    res.end(song, () => done(query));
  });
}

test.describe("getting a song (YouTube, Spotify and SoundCloud played by stand-ins)", () => {
  // Downloads go to the browser unless a test chooses a folder (the setting is
  // kept by the app, so one test's choice would otherwise carry over).
  test.beforeEach(async ({ page, request }) => {
    await request.put("/api/settings", { data: { saveFolder: null } });
    await stayOffline(page);
  });

  // Temp folders a test makes, deleted after it, even if it failed or timed out.
  const tempFolders: string[] = [];
  const deletedAfterTest = async (prefix: string) => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    tempFolders.push(folder);
    return folder;
  };
  test.afterEach(async ({ page }) => {
    if (!tempFolders.length) return;
    await page.close();
    for (const folder of tempFolders.splice(0)) {
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test("pastes a YouTube link, renames it, and the browser saves the MP3, then lists it", async ({
    page,
    front,
    browserName,
  }) => {
    const pasted = `https://youtu.be/${VIDEO_ID}?si=shared`;
    const videos = await answerVideoInfo(page, "Me at the zoo");
    const downloads: Record<string, string>[] = [];
    const history: { url: string; title: string }[] = [];
    await answerHistory(page, () => history);
    answerDownloads(front, await makeSong(), "Me at the zoo", (query) => {
      downloads.push(query);
      history.push({ url: query.url, title: "Me at the zoo" });
    });

    await page.goto(front.url);
    await expect(page.getByRole("heading", { name: /Convert any YouTube video/i })).toBeVisible();
    await page.locator('input[type="url"]').fill(pasted);
    await page.getByRole("button", { name: /extract/i }).click();

    // The video is open: its title and thumbnail, and a link to download it.
    await expect(downloadLink(page)).toBeVisible();
    await expect(downloadLink(page)).toContainText(/mp3/i); // MP3 is the default
    await expect(page.getByRole("img", { name: "Me at the zoo" })).toBeVisible();
    expect(videos).toEqual([pasted]);

    // Renamed in place, it's saved under that name (":" isn't allowed in Windows file names).
    await page.getByRole("button", { name: /^rename file: me at the zoo/i }).click();
    const nameBox = page.getByRole("textbox", { name: /file name/i });
    await expect(nameBox).toHaveValue(/me at the zoo/i);
    await nameBox.fill("Zoo clip: the first video");
    await nameBox.press("Enter");
    await expect(
      page.getByRole("button", { name: /^rename file: zoo clip - the first video$/i }),
    ).toBeVisible();
    await expect(page.getByText(/renamed from/i)).toBeVisible();
    await expect(historyRows(page, /me at the zoo/i)).toHaveCount(0);

    const downloadStarted = page.waitForEvent("download");
    await downloadLink(page).click();
    const download = await downloadStarted;
    expect(download.suggestedFilename()).toBe(
      savedName("Zoo clip - the first video.mp3", browserName),
    );
    const saved = path.join(await deletedAfterTest("yt-audio-e2e-download-"), "song.mp3");
    await download.saveAs(saved);
    const verdict = await verifyMp3File(saved);
    expect(verdict.isValid, `Not a valid MP3: ${verdict.reason}`).toBe(true);
    // The app was asked for the video's MP3, under the new name.
    expect(downloads).toEqual([{ url: pasted, name: "Zoo clip - the first video" }]);

    // Once the app has it in the history, it shows in Recent Extractions by itself.
    await expect(historyRows(page, /me at the zoo/i)).toHaveCount(1, { timeout: 20_000 });
  });

  test("a video's song is named “Artist - Title”: the artist its title names, not the channel that uploaded it", async ({
    page,
    front,
  }) => {
    const pasted = `https://youtu.be/${VIDEO_ID}`;
    // From the owner's folder: a channel that uploads other people's songs.
    await answerVideoInfo(
      page,
      "Paul van Dyk - For An Angel (Official Video) HD",
      [],
      "Trance Classics",
    );
    const downloads: Record<string, string>[] = [];
    answerDownloads(front, await makeSong(), "Paul van Dyk - For An Angel", (query) =>
      downloads.push(query),
    );

    await page.goto(front.url);
    await page.locator('input[type="url"]').fill(pasted);
    await page.getByRole("button", { name: /extract/i }).click();

    // Shown as it will be saved; the channel is shown as who uploaded it.
    const title = page.getByRole("button", { name: "Rename file: Paul van Dyk - For An Angel" });
    await expect(title).toBeVisible();
    await expect(page.getByText("Trance Classics")).toBeVisible();
    // Renamed and back: to the name it came with.
    await title.click();
    const nameBox = page.getByRole("textbox", { name: /file name/i });
    await expect(nameBox).toHaveValue("Paul van Dyk - For An Angel");
    await nameBox.fill("For An Angel");
    await nameBox.press("Enter");
    await expect(page.getByText("Renamed from “Paul van Dyk - For An Angel”")).toBeVisible();
    await page.getByRole("button", { name: "Use that name" }).click();
    await expect(title).toBeVisible();

    // Not renamed, the page leaves the name to the app (which names it the same way).
    const downloadStarted = page.waitForEvent("download");
    await downloadLink(page).click();
    await downloadStarted;
    expect(downloads).toEqual([{ url: pasted }]);
  });

  test("a pasted Spotify song link is searched for, and the same-length match downloads under the song's name", async ({
    page,
    front,
    browserName,
  }) => {
    const SONG = "4u7EnebtmKWzUH433cf5Qv";
    const link = `https://open.spotify.com/track/${SONG}?si=e2e`;
    const searches: string[] = [];
    await page.route("**/api/search?*", async (route) => {
      searches.push(queryOf(route).get("q") ?? "");
      await route.fulfill({
        json: {
          // As the app ranks them: the upload as long as the Spotify song first.
          results: [
            {
              id: "yk3prd8GER4",
              url: "https://www.youtube.com/watch?v=yk3prd8GER4",
              title: "Bohemian Rhapsody (Remastered 2011)",
              channel: "Queen - Topic",
              duration: 355,
              thumbnail: THUMBNAIL,
              official: true,
              source: "youtube",
            },
            {
              id: "fJ9rUzIMcZQ",
              url: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
              title: "Queen – Bohemian Rhapsody (Official Video Remastered)",
              channel: "Queen Official",
              duration: 412,
              thumbnail: THUMBNAIL,
              official: true,
              source: "youtube",
            },
          ],
          source: "youtube",
          spotify: {
            id: SONG,
            url: `https://open.spotify.com/track/${SONG}`,
            title: "Bohemian Rhapsody - Remastered 2011",
            artists: ["Queen"],
            duration: 354,
            thumbnail: null,
          },
        },
      });
    });
    const downloads: Record<string, string>[] = [];
    const history: { url: string; title: string; spotifyId?: string }[] = [];
    await answerHistory(page, () => history);
    answerDownloads(front, await makeSong(), "Bohemian Rhapsody", (query) => {
      downloads.push(query);
      history.push({ url: query.url, title: "Bohemian Rhapsody", spotifyId: query.spotifyId });
    });

    await page.goto(front.url);
    // Pasted into the link box: it's a song to look up, so it's searched for.
    await page.locator('input[type="url"]').fill(link);
    await page.locator('button[type="submit"]').click();
    await expect(page.getByRole("button", { name: /search by song/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const results = page.getByRole("region", { name: /search results/i });
    await expect(results.getByText(/from spotify/i)).toBeVisible();
    expect(searches).toEqual([link]);

    // The same-length upload is marked, and picked straight away.
    const best = results.getByRole("button", { name: /^bohemian rhapsody \(remastered 2011\)/i });
    await expect(best).toHaveAttribute("aria-pressed", "true");
    await expect(best).toHaveAccessibleName(/same length as the spotify song/i);
    await expect(results.getByRole("button", { pressed: true })).toHaveCount(1);
    await expect(results.getByText("Same length", { exact: true })).toHaveCount(1);

    // Named like a music folder would: "Artist - Title", not the video's title,
    // and the download says which Spotify song it is.
    await expect(
      page.getByRole("button", { name: "Rename file: Queen - Bohemian Rhapsody" }),
    ).toBeVisible();
    const downloadStarted = page.waitForEvent("download");
    await downloadLink(page).click();
    const download = await downloadStarted;
    expect(download.suggestedFilename()).toBe(
      savedName("Queen - Bohemian Rhapsody.mp3", browserName),
    );
    await expect.poll(() => downloads).toHaveLength(1);
    expect(downloads).toEqual([
      {
        url: "https://www.youtube.com/watch?v=yk3prd8GER4",
        name: "Queen - Bohemian Rhapsody",
        spotifyId: SONG,
      },
    ]);
    await expect(historyRows(page, /bohemian rhapsody/i)).toHaveCount(1, { timeout: 20_000 });
  });

  test("a Spotify song whose only matches are a full set or a mix of another length: none is picked, and the page says why", async ({
    page,
    front,
  }) => {
    const SONG = "7deQKNLOrwQj2NernulnyW";
    await page.route("**/api/search?*", async (route) => {
      await route.fulfill({
        json: {
          results: [
            {
              id: "CiPbJ0XBu4k",
              url: "https://www.youtube.com/watch?v=CiPbJ0XBu4k",
              title: "Ace Ventura | Ozora Festival 2026 | Full Set",
              channel: "Ace Ventura",
              duration: 6279,
              thumbnail: THUMBNAIL,
              official: true,
              source: "youtube",
            },
          ],
          source: "youtube",
          spotify: {
            id: SONG,
            url: `https://open.spotify.com/track/${SONG}`,
            title: "Incoming Signal - Original mix",
            artists: ["Ace Ventura", "Ritmo", "Volcano"],
            duration: 425,
            thumbnail: null,
          },
        },
      });
    });
    await answerHistory(page, () => []);

    await page.goto(front.url);
    await page.locator('input[type="url"]').fill(`https://open.spotify.com/track/${SONG}`);
    await page.locator('button[type="submit"]').click();
    const results = page.getByRole("region", { name: /search results/i });
    await expect(results.getByText(/from spotify/i)).toBeVisible();
    await expect(results.getByRole("status")).toHaveText(
      /no upload found is near the song's length/i,
    );
    const set = results.getByRole("button", { name: /^ace ventura \| ozora festival/i });
    await expect(set).toHaveAccessibleName(/not the spotify song's length/i);
    await expect(results.getByText("Not the song's length", { exact: true })).toBeVisible();
    // Nothing is picked, so nothing is ready to download…
    await expect(set).toHaveAttribute("aria-pressed", "false");
    await expect(downloadLink(page)).toHaveCount(0);
    // …until you pick it yourself.
    await set.click();
    await expect(set).toHaveAttribute("aria-pressed", "true");
    await expect(downloadLink(page)).toBeVisible();
  });

  test("Save to: a save the source stops part-way through says why it failed, and can be tried again", async ({
    page,
    front,
  }) => {
    const folder = await deletedAfterTest("yt-audio-e2e-save-fails-");
    expect((await page.request.put("/api/settings", { data: { saveFolder: folder } })).ok()).toBe(
      true,
    );
    await answerVideoInfo(page, "Me at the zoo");
    await answerHistory(page, () => []);
    const saves: unknown[] = [];
    await page.route("**/api/video/save", async (route) => {
      saves.push(route.request().postDataJSON());
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          { type: "progress", bytes: 65_536 },
          {
            type: "error",
            message:
              "Couldn't download the audio: YouTube stopped sending the audio (nothing for 60 s) (tried 2 times)",
          },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
      });
    });

    try {
      await page.goto(front.url);
      await page.locator('input[type="url"]').fill(VIDEO);
      await page.getByRole("button", { name: /extract/i }).click();
      await downloadLink(page).click();
      await expect(page.getByText(/couldn't save the audio/i).first()).toBeVisible();
      await expect(
        page
          .getByText(/youtube stopped sending the audio \(nothing for 60 s\) \(tried 2 times\)/i)
          .first(),
      ).toBeVisible();
      // Nothing was left in the folder by the page, and the song can be saved again.
      await expect(downloadLink(page)).toBeVisible();
      await downloadLink(page).click();
      await expect.poll(() => saves.length).toBe(2);
      expect(await fs.readdir(folder)).toEqual([]);
    } finally {
      await page.request.put("/api/settings", { data: { saveFolder: null } });
    }
  });

  test("Save to: downloads go into the folder picked in the app's folder browser; Cancel stops one", async ({
    page,
    front,
  }) => {
    // A real folder on this computer, picked with the app's own folder browser
    // (the real app). The saves into it are the stand-in's.
    const folder = await deletedAfterTest("yt-audio-e2e-save-to-");
    await fs.mkdir(path.join(folder, "Albums"));
    const target = path.join(folder, "Test Music");
    let browserDownloads = 0;
    page.on("download", () => browserDownloads++);

    await answerVideoInfo(page, "Me at the zoo");
    const history: { url: string; title: string }[] = [];
    await answerHistory(page, () => history);
    // The first save is held until it's cancelled; the next one is saved.
    const saves: unknown[] = [];
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
    await page.route("**/api/video/save", async (route) => {
      const body = route.request().postDataJSON() as { url: string };
      saves.push(body);
      if (saves.length === 1) {
        await firstReleased;
        return route.abort().catch(() => {}); // the page has given up on it by then
      }
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          { type: "progress", bytes: 65_536 },
          {
            type: "done",
            fileName: "Me at the zoo.mp3",
            folder: target,
            path: path.join(target, "Me at the zoo.mp3"),
            bytes: 98_304,
          },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(""),
      });
      history.push({ url: body.url, title: "Me at the zoo" });
    });

    await page.goto(front.url);
    // The setting is right under the search box, before any video is opened.
    await page.getByRole("button", { name: /choose folder/i }).click();
    const picker = page.getByRole("dialog", { name: /choose where to save/i });
    await expect(picker).toBeVisible();

    // Go to the folder by typing its path, make a new folder there, and use it.
    const pathBox = picker.getByRole("textbox", { name: /folder path/i });
    await pathBox.fill(folder);
    await pathBox.press("Enter");
    await expect(picker.getByRole("button", { name: "Albums", exact: true })).toBeVisible();
    await picker.getByRole("button", { name: /new folder/i }).click();
    await picker.getByRole("textbox", { name: /new folder name/i }).fill("Test Music");
    await picker.getByRole("button", { name: /^create$/i }).click();
    await expect(pathBox).toHaveValue(target);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    await picker.getByRole("button", { name: /^use “test music”/i }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByTestId("save-folder-name")).toHaveText("Test Music");
    await expect(page.getByTestId("save-folder-name")).toHaveAttribute("title", target);

    await page.locator('input[type="url"]').fill(VIDEO);
    await page.getByRole("button", { name: /extract/i }).click();
    await expect(downloadLink(page)).toBeVisible();

    // Cancelled part-way: the page calls the app's save off, and nothing is listed.
    const calledOff = page.waitForEvent("requestfailed", (r) =>
      r.url().endsWith("/api/video/save"),
    );
    await downloadLink(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: /^saving to test music/i }),
    ).toBeVisible();
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await calledOff;
    releaseFirst();
    await expect(page.getByText(/download cancelled/i).first()).toBeVisible();
    await expect(downloadLink(page)).toBeVisible();

    // A whole save: the app saves the file itself, so the browser downloads nothing.
    await downloadLink(page).click();
    await expect(page.getByText(/saved to “test music”/i).first()).toBeVisible();
    expect(saves).toEqual([
      { url: VIDEO, format: "mp3" },
      { url: VIDEO, format: "mp3" },
    ]);
    expect(browserDownloads).toBe(0);
    await expect(historyRows(page, /me at the zoo/i)).toHaveCount(1, { timeout: 20_000 });

    // The app remembers the folder (for every browser on this computer).
    await page.reload();
    await expect(page.getByTestId("save-folder-name")).toHaveText("Test Music");

    // Back to the browser's own downloads.
    await page.getByRole("button", { name: /use the browser's downloads folder instead/i }).click();
    await expect(page.getByText(/your browser's downloads folder/i)).toBeVisible();
  });

  test("when YouTube can't answer a search, SoundCloud's tracks are offered and download the same way", async ({
    page,
    front,
    browserName,
  }) => {
    const TRACK = "https://api.soundcloud.com/tracks/300000002";
    const searches: Record<string, string>[] = [];
    await page.route("**/api/search?*", async (route) => {
      searches.push(Object.fromEntries(queryOf(route)));
      // What the app answers when YouTube refused the search: SoundCloud's, the preview last.
      await route.fulfill({
        json: {
          results: [
            {
              id: "soundcloud:tracks:300000002",
              url: TRACK,
              title: "One More Time",
              channel: "Daft Punk",
              duration: 320,
              thumbnail: THUMBNAIL,
              official: false,
              source: "soundcloud",
            },
            {
              id: "soundcloud:tracks:254112129",
              url: "https://api.soundcloud.com/tracks/254112129",
              title: "One More Time (preview)",
              channel: "Daft Punk",
              duration: 30,
              thumbnail: THUMBNAIL,
              official: false,
              source: "soundcloud",
            },
          ],
          source: "soundcloud",
        },
      });
    });
    const downloads: Record<string, string>[] = [];
    const history: { url: string; title: string; source: "soundcloud" }[] = [];
    await answerHistory(page, () => history);
    // Saved as the app names it: "Artist - Title".
    answerDownloads(front, await makeSong(), "Daft Punk - One More Time", (query) => {
      downloads.push(query);
      history.push({ url: query.url, title: "One More Time", source: "soundcloud" });
    });

    await page.goto(front.url);
    await page.getByRole("button", { name: /search by song/i }).click();
    await page.getByRole("searchbox", { name: /song search/i }).fill("daft punk one more time");
    await page.getByRole("button", { name: /^search$/i }).click();

    // Said to be SoundCloud's, each one marked.
    const results = page.getByRole("region", { name: /search results/i });
    await expect(results.getByText("From SoundCloud: YouTube couldn't answer")).toBeVisible();
    await expect(results.getByText("SoundCloud", { exact: true })).toHaveCount(2);
    expect(searches).toEqual([{ q: "daft punk one more time" }]);

    // Picked, it opens like a YouTube video, marked as SoundCloud's.
    const track = results.getByRole("button", { name: /^one more time, by daft punk/i });
    await track.click();
    await expect(track).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("button", { name: /^rename file: daft punk - one more time/i }),
    ).toBeVisible();
    await expect(page.getByText(/soundcloud's own stream/i)).toBeVisible();

    const downloadStarted = page.waitForEvent("download");
    await downloadLink(page).click();
    const download = await downloadStarted;
    expect(download.suggestedFilename()).toBe(
      savedName("Daft Punk - One More Time.mp3", browserName),
    );
    const saved = path.join(await deletedAfterTest("yt-audio-e2e-download-"), "track.mp3");
    await download.saveAs(saved);
    expect((await verifyMp3File(saved)).isValid).toBe(true);
    // By the track's canonical link: the only kind the app hands to yt-dlp.
    expect(downloads).toEqual([{ url: TRACK }]);

    // Recent Extractions says where it came from.
    await expect(historyRows(page, /one more time.*from soundcloud/i)).toHaveCount(1, {
      timeout: 20_000,
    });
  });
});
