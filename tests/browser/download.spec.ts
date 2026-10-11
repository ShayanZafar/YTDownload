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
  // Downloads go to the browser unless a test chooses a folder (the setting is
  // kept by the app, so one test's choice would otherwise carry over).
  test.beforeEach(async ({ request }) => {
    await request.put("/api/settings", { data: { saveFolder: null } });
  });

  // Temp folders a test makes, deleted after it, even if it failed or timed out.
  const tempFolders: string[] = [];
  const deletedAfterTest = (folder: string) => {
    tempFolders.push(folder);
    return folder;
  };
  test.afterEach(async ({ page }) => {
    if (!tempFolders.length) return;
    // Close the page first: a save it left running is cancelled, so the app stops writing
    // into the folder and deletes its unfinished file (retried meanwhile).
    await page.close();
    for (const folder of tempFolders.splice(0)) {
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

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

    // The title can be renamed in place; the file is then saved under that name.
    await page.getByRole("button", { name: /^rename file: me at the zoo/i }).click();
    const nameBox = page.getByRole("textbox", { name: /file name/i });
    await expect(nameBox).toHaveValue(/me at the zoo/i);
    await nameBox.fill("Zoo clip: the first video");
    await nameBox.press("Enter");
    await expect(
      page.getByRole("button", { name: /^rename file: zoo clip - the first video$/i }),
    ).toBeVisible();
    await expect(page.getByText(/renamed from/i)).toBeVisible();

    // 4. Click the download link and capture the file the browser saves.
    await expect(page.getByText(/recent extractions/i)).toBeVisible();
    const rowsBefore = await historyRows(page).count();
    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
    await downloadLink.click();
    const download = await downloadPromise;

    // Saved under the new name (":" isn't allowed in Windows file names).
    expect(download.suggestedFilename()).toBe("Zoo clip - the first video.mp3");

    const tmpDir = deletedAfterTest(
      await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-browser-test-")),
    );
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

    const tmpDir = deletedAfterTest(
      await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-browser-test-")),
    );
    const savedPath = path.join(tmpDir, download.suggestedFilename());
    await download.saveAs(savedPath);
    const verdict = await verifyOriginalAudioFile(savedPath, ext!.toLowerCase());
    expect(verdict.isValid, `Not a valid .${ext}: ${verdict.reason}`).toBe(true);
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

    // Done with the results: close them; the chosen video stays ready to download.
    await results.getByRole("button", { name: /close search results/i }).click();
    await expect(results).toHaveCount(0);
    await expect(downloadLink).toBeVisible();

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

  test("a Spotify playlist opens in a panel; picking a song finds it on YouTube", async ({
    page,
  }) => {
    // A made-up playlist (Spotify's own change every day) holding a real song,
    // which is then looked up on Spotify and YouTube for real.
    const songs: [string, string, string, number][] = [
      ["4u7EnebtmKWzUH433cf5Qv", "Bohemian Rhapsody - Remastered 2011", "Queen", 354],
      ["2Foc5Q5nqNiosCNqttzHof", "Get Lucky", "Daft Punk, Pharrell Williams, Nile Rodgers", 369],
      ...Array.from({ length: 10 }, (_, i): [string, string, string, number] => [
        `${String(i).padStart(2, "0")}Foc5Q5nqNiosCNqttzHo`,
        `Road Song ${i + 1}`,
        "The Band",
        200,
      ]),
    ];
    const playlist = {
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
      url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      name: "Road Trip",
      by: "Moomoo",
      image: null,
      maybeMore: false,
      tracks: songs.map(([id, title, artists, duration]) => ({
        id,
        url: `https://open.spotify.com/track/${id}`,
        title,
        artists,
        duration,
        explicit: false,
      })),
    };
    await page.route("**/api/spotify/playlist?*", (route) => route.fulfill({ json: playlist }));
    // "Get Lucky" was downloaded before.
    await page.route("**/api/downloads", (route) =>
      route.fulfill({
        json: [
          {
            id: 1,
            url: "https://www.youtube.com/watch?v=5NV6Rdv1a3I",
            title: "Daft Punk - Get Lucky",
            downloadedAt: new Date().toISOString(),
            spotifyId: "2Foc5Q5nqNiosCNqttzHof",
          },
        ],
      }),
    );

    await page.goto("/");
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    await page.getByRole("textbox", { name: /playlist link/i }).fill(playlist.url);
    await page.getByRole("button", { name: /open playlist/i }).click();

    const panel = page.getByRole("region", { name: /spotify playlist/i });
    await expect(panel.getByRole("heading", { name: "Road Trip" })).toBeVisible();
    await expect(panel.getByRole("listitem")).toHaveCount(12);
    await expect(panel.getByText("by Moomoo · 12 songs · 1 downloaded")).toBeVisible();
    await expect(panel.getByRole("button", { name: /^get lucky.*downloaded$/i })).toBeVisible();

    // The filter narrows the list.
    await panel.getByRole("searchbox", { name: /filter/i }).fill("queen");
    await expect(panel.getByRole("listitem")).toHaveCount(1);

    // Picking a song finds it on YouTube: the best match is ready to download,
    // and the download remembers which Spotify song it is.
    const song = panel.getByRole("button", { name: /^bohemian rhapsody/i });
    await song.click();
    const downloadLink = page.locator('a[href^="/api/video/download"]', {
      hasText: /download audio/i,
    });
    await expect(downloadLink).toBeVisible({ timeout: 60_000 });
    await expect(downloadLink).toHaveAttribute("href", /spotifyId=4u7EnebtmKWzUH433cf5Qv/);
    await expect(song).toHaveAttribute("aria-pressed", "true");
    // Named like a music folder would: "Artist - Title", not the video's title.
    await expect(downloadLink).toHaveAttribute("href", /name=Queen\+-\+Bohemian\+Rhapsody(&|$)/);
    await expect(
      page.getByRole("button", { name: "Rename file: Queen - Bohemian Rhapsody" }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: /search results/i }).getByText(/from spotify/i),
    ).toBeVisible();

    // The playlist stays open across visits, until it's closed.
    await page.reload();
    await expect(panel.getByRole("heading", { name: "Road Trip" })).toBeVisible();
    await panel.getByRole("button", { name: /close the spotify playlist/i }).click();
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Playlist", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("region", { name: /spotify playlist/i })).toHaveCount(0);
  });

  test("with a Save to folder, the playlist shows what's in it, and Download saves the rest", async ({
    page,
    request,
  }) => {
    // A real folder that has one of the songs already, in a subfolder.
    const folder = deletedAfterTest(await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-playlist-")));
    await fs.mkdir(path.join(folder, "Queen"));
    await fs.writeFile(path.join(folder, "Queen", "Bohemian Rhapsody.mp3"), "");
    await request.put("/api/settings", { data: { saveFolder: folder } });
    const name = path.basename(folder);

    // A made-up playlist: Bohemian Rhapsody (in the folder already) and two
    // songs whose YouTube search is made up too, both finding YouTube's first
    // video (19 seconds, quick to download for real): one the same length as
    // that video, one not — which has to be left for someone to check.
    const songs = [
      ["4u7EnebtmKWzUH433cf5Qv", "Bohemian Rhapsody - Remastered 2011", "Queen", 354],
      ["AAAAAAAAAAAAAAAAAAAAAA", "Me at the zoo", "jawed", 19],
      ["BBBBBBBBBBBBBBBBBBBBBB", "Zoo Song", "The Keepers", 200],
    ] as const;
    const playlist = {
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
      url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
      name: "Zoo Trip",
      by: "Moomoo",
      image: null,
      maybeMore: false,
      tracks: songs.map(([id, title, artists, duration]) => ({
        id,
        url: `https://open.spotify.com/track/${id}`,
        title,
        artists,
        duration,
        explicit: false,
      })),
    };
    await page.route("**/api/spotify/playlist?*", (route) => route.fulfill({ json: playlist }));
    await page.route("**/api/search?*", (route) => {
      const query = new URL(route.request().url()).searchParams.get("q") ?? "";
      const song = songs.slice(1).find(([id]) => query.includes(id));
      if (!song) return route.continue();
      const [id, title, artists, duration] = song;
      return route.fulfill({
        json: {
          results: [
            {
              id: "jNQXAC9IVRw",
              url: TEST_VIDEO_URL,
              title: "Me at the zoo",
              channel: "jawed",
              duration: 19,
              thumbnail: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
              official: true,
              source: "youtube",
            },
          ],
          source: "youtube",
          spotify: {
            id,
            url: `https://open.spotify.com/track/${id}`,
            title,
            artists: [artists],
            duration,
            thumbnail: null,
          },
        },
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Playlist", exact: true }).click();
    await page.getByRole("textbox", { name: /playlist link/i }).fill(playlist.url);
    await page.getByRole("button", { name: /open playlist/i }).click();

    const panel = page.getByRole("region", { name: /spotify playlist/i });
    await expect(panel.getByText(`by Moomoo · 3 songs · 1 in “${name}” · 2 missing`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      panel.getByRole("button", { name: /^bohemian rhapsody.*in the folder as/i }),
    ).toBeVisible();

    // Just the missing songs, both ticked to download.
    await panel.getByRole("button", { name: "Not in folder (2)" }).click();
    await expect(panel.getByRole("listitem")).toHaveCount(2);
    await expect(panel.getByRole("checkbox", { checked: true })).toHaveCount(2);
    await panel.getByRole("button", { name: "Download 2 songs" }).click();

    // The song with a same-length upload is saved; the other one is left to check.
    await expect(panel.getByRole("button", { name: /^me at the zoo.*saved as/i })).toBeVisible({
      timeout: 90_000,
    });
    await expect(panel.getByRole("button", { name: /^zoo song.*same length/i })).toBeVisible();
    await expect(page.getByText("Saved 1 song to", { exact: false }).first()).toBeVisible();
    await expect(panel.getByText(`by Moomoo · 3 songs · 2 in “${name}” · 1 missing`)).toBeVisible();
    // The one to check isn't ticked for the next Download.
    await expect(panel.getByRole("checkbox", { name: /zoo song/i })).not.toBeChecked();
    await expect(panel.getByRole("button", { name: /^download/i })).toBeDisabled();

    // Saved as "Artist - Title", a real MP3.
    const verdict = await verifyMp3File(path.join(folder, "jawed - Me at the zoo.mp3"));
    expect(verdict.isValid, `Not a valid MP3: ${verdict.reason}`).toBe(true);
  });

  test("Save to: pick a folder in the app's folder browser; downloads are saved into it", async ({
    page,
  }) => {
    // A real folder on this computer: the app writes into it itself, so this
    // works the same in every browser.
    const folder = deletedAfterTest(await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-save-to-")));
    await fs.mkdir(path.join(folder, "Albums"));
    const target = path.join(folder, "Test Music");
    let browserDownloads = 0;
    page.on("download", () => browserDownloads++);

    await page.goto("/");
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
    await picker.getByRole("button", { name: /^use “test music”/i }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByTestId("save-folder-name")).toHaveText("Test Music");
    await expect(page.getByTestId("save-folder-name")).toHaveAttribute("title", target);

    await page.locator('input[type="url"]').fill(TEST_VIDEO_URL);
    await page.getByRole("button", { name: /extract/i }).click();
    const downloadLink = page.locator('a[href^="/api/video/download"]', {
      hasText: /download audio/i,
    });
    await expect(downloadLink).toBeVisible({ timeout: 60_000 });
    const rowsBefore = await historyRows(page).count();

    // Cancelling part-way leaves nothing in the folder and nothing in the history.
    await downloadLink.click();
    await page.getByRole("button", { name: /^cancel$/i }).click();
    await expect(page.getByText(/download cancelled/i).first()).toBeVisible();
    await expect.poll(() => fs.readdir(target), { timeout: 10_000 }).toEqual([]);

    // A full download lands in the folder as a real MP3.
    await downloadLink.click();
    await expect(page.getByText(/saved to “test music”/i).first()).toBeVisible({
      timeout: 90_000,
    });
    const files = await fs.readdir(target);
    expect(files).toEqual([expect.stringMatching(/^Me at the zoo.*\.mp3$/i)]);
    const verdict = await verifyMp3File(path.join(target, files[0]));
    expect(verdict.isValid, `Saved file is not a valid MP3: ${verdict.reason}`).toBe(true);
    expect(browserDownloads).toBe(0);
    await expect(historyRows(page)).toHaveCount(rowsBefore + 1, { timeout: 20_000 });

    // The app remembers the folder (for every browser on this computer).
    await page.reload();
    await expect(page.getByTestId("save-folder-name")).toHaveText("Test Music");

    // Back to the browser's own downloads.
    await page.getByRole("button", { name: /use the browser's downloads folder instead/i }).click();
    await expect(page.getByText(/your browser's downloads folder/i)).toBeVisible();
  });

  test("Save to: a path typed while the folder browser is still opening isn't replaced", async ({
    page,
  }) => {
    const folder = deletedAfterTest(await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-save-to-")));
    await fs.mkdir(path.join(folder, "Albums"));
    // The folder browser first asks the app for the folder it opens on, which
    // can take seconds (on Windows the app looks up where Music and the other
    // quick links are). Hold that answer until a path has been typed.
    let pathTyped!: () => void;
    const typed = new Promise<void>((resolve) => (pathTyped = resolve));
    await page.route(
      (url) => url.pathname === "/api/folders" && !url.search,
      async (route) => {
        await typed;
        await route.continue();
      },
    );

    await page.goto("/");
    await page.getByRole("button", { name: /choose folder/i }).click();
    const picker = page.getByRole("dialog", { name: /choose where to save/i });
    const pathBox = picker.getByRole("textbox", { name: /folder path/i });
    await pathBox.fill(folder);
    pathTyped();

    // The late answer brings the quick links, but leaves the typed path alone…
    await expect(picker.getByRole("group", { name: "Places" })).toBeVisible();
    await expect(pathBox).toHaveValue(folder);
    // …so Enter opens it.
    await pathBox.press("Enter");
    await expect(picker.getByRole("button", { name: "Albums", exact: true })).toBeVisible();
    await expect(pathBox).toHaveValue(folder);
  });

  test("another device (like a phone) is told where its downloads go", async ({ page }) => {
    // What the app answers a browser on another device: it can't save into a
    // folder on this computer, so downloads go to that device.
    await page.route("**/api/settings", (route) =>
      route.fulfill({ json: { saveFolder: null, canSaveToFolder: false, cpuCores: 4 } }),
    );
    await page.goto("/");
    await expect(page.getByText(/downloads go to this device's downloads folder/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /choose folder/i })).toHaveCount(0);
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
