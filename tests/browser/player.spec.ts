import { test, expect, type Page } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import ffmpegPath from "ffmpeg-static";

// The music player, with real songs made for the test (no YouTube needed):
// on the computer running the app it plays the Save to folder; on a phone it
// plays songs picked on the phone, which stay there.
//
// Starting a song can hold up Playwright's WebKit on Windows for several
// seconds (its media engine opens the file before letting the page go on),
// so clicks that start one get longer to finish.
const START_SONG = { timeout: 90_000 };

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

/** What the player's audio element is doing. */
const audio = (page: Page) =>
  page.evaluate(() => {
    const element = document.querySelector<HTMLAudioElement>("[data-testid=music-player-audio]")!;
    return {
      playing: !element.paused && element.currentTime > 0.2,
      paused: element.paused,
      src: element.currentSrc,
      hasSource: element.hasAttribute("src"),
      error: element.error?.code ?? null,
      time: element.currentTime,
      muted: element.muted,
    };
  });

/** Can this browser play AIFF itself? (Safari can; Chrome and WebKit on Windows can't.) */
const playsAiff = (page: Page) =>
  page.evaluate(() => document.createElement("audio").canPlayType("audio/aiff") !== "");

let folder: string;
let mp3: string;
let aiff: string;

test.beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-player-test-"));
  // A 24-bit AIFF most browsers can't play, then (newer, so listed first) an
  // MP3 the way the app saves them, tags and all.
  aiff = path.join(folder, "Studio Master.aiff");
  await ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=330:duration=20"],
    ...["-c:a", "pcm_s24be", aiff],
  ]);
  mp3 = path.join(folder, "Test Tone.mp3");
  await ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=20"],
    ...["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"],
    ...["-metadata", "title=Test Tone", "-metadata", "artist=Sine Wave", mp3],
  ]);
});

test.afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

test.describe("Music player (browser)", () => {
  test.beforeEach(async ({ request }) => {
    await request.put("/api/settings", { data: { saveFolder: null } });
  });

  test("plays the Save to folder's songs, converting one the browser can't play", async ({
    page,
    request,
  }) => {
    await request.put("/api/settings", { data: { saveFolder: folder } });
    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    await expect(library.getByText(`Songs in “${path.basename(folder)}”`)).toBeVisible();
    const testTone = library.getByRole("button", { name: /^Play “Test Tone”, by Sine Wave, 0:20/ });
    await expect(testTone).toBeVisible();
    await expect(
      library.getByRole("button", { name: /^Play “Studio Master”, 0:20/ }),
    ).toBeVisible();

    // Click a song: the player opens and plays it, as it is.
    await testTone.click(START_SONG);
    const player = page.getByRole("region", { name: "Music player" });
    await expect(player.getByTestId("player-title")).toHaveText("Test Tone");
    await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
    expect((await audio(page)).src).toMatch(/\/api\/music\/[\w-]{22}$/);
    await expect(library.getByRole("button", { name: /^Pause “Test Tone”/ })).toBeVisible();

    await player.getByRole("button", { name: "Pause" }).click();
    await expect.poll(() => audio(page)).toMatchObject({ paused: true });

    // The next song is an AIFF: the app converts it to FLAC for a browser
    // that can't play it.
    await player.getByRole("button", { name: "Next song" }).click(START_SONG);
    await expect(player.getByTestId("player-title")).toHaveText("Studio Master");
    await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
    expect((await audio(page)).src).toMatch(
      (await playsAiff(page)) ? /\/api\/music\/[\w-]{22}$/ : /\/api\/music\/[\w-]{22}\/flac$/,
    );

    // Repeat cycles off → all → one; Close stops the song and hides the player.
    await player.getByRole("button", { name: "Repeat: off" }).click();
    await expect(player.getByRole("button", { name: "Repeat: all songs" })).toBeVisible();
    await player.getByRole("button", { name: "Close the player" }).click(START_SONG);
    await expect(player).toBeHidden();
    await expect.poll(() => audio(page)).toMatchObject({ paused: true, hasSource: false });
  });

  test("on a phone, plays songs picked on the phone — nothing is uploaded", async ({
    page,
    browserName,
  }) => {
    // What the app answers a browser on another device.
    await page.route("**/api/settings", (route) =>
      route.fulfill({ json: { saveFolder: null, canSaveToFolder: false } }),
    );
    const sent: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET" || req.url().includes("/api/music")) sent.push(req.url());
    });

    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    await expect(library.getByText(/play songs stored on this device/i)).toBeVisible();
    await library.getByLabel("Choose songs").setInputFiles([mp3, aiff]);

    // The tags are read in the browser; a song it can't play is marked.
    const testTone = library.getByRole("button", { name: /^Play “Test Tone”, by Sine Wave/ });
    await expect(testTone).toBeVisible();
    const studioMaster = library.getByRole("button", { name: /^Play “Studio Master”/ });
    if (await playsAiff(page)) {
      await expect(studioMaster).toBeEnabled();
    } else {
      await expect(studioMaster).toHaveAccessibleName(/can't play it/);
      await expect(studioMaster).toBeDisabled();
      await expect(library.getByText(/1 song can't play in this browser \(\.aiff\)/)).toBeVisible();
    }

    await testTone.click(START_SONG);
    const player = page.getByRole("region", { name: "Music player" });
    await expect(player.getByTestId("player-title")).toHaveText("Test Tone");
    if (browserName === "webkit" && process.platform === "win32") {
      // Playwright's WebKit on Windows plays media with Windows Media
      // Foundation, which can't open a page's own files (blob: addresses) —
      // Safari, Chrome and Firefox can. The player says so instead.
      await expect(player.getByRole("alert")).toContainText("can't play");
    } else {
      await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
      expect((await audio(page)).src).toMatch(/^blob:/);
    }
    expect(sent).toEqual([]);

    // Picked songs can be cleared.
    await library.getByRole("button", { name: "Clear the opened songs" }).click();
    await expect(testTone).toBeHidden();
  });

  test("Up next lists the songs to come; Play next and Add to queue line songs up", async ({
    page,
    request,
  }) => {
    await request.put("/api/settings", { data: { saveFolder: folder } });
    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    const player = page.getByRole("region", { name: "Music player" });
    const upNext = page.getByRole("region", { name: "Up next" });

    // Nothing playing: Play next starts the song.
    await library.getByRole("button", { name: "Play next: “Test Tone”" }).click(START_SONG);
    await expect(player.getByTestId("player-title")).toHaveText("Test Tone");
    await player.getByRole("button", { name: "Up next" }).click();
    await expect(upNext.getByText(/Nothing after this song/)).toBeVisible();

    // Add to queue puts it after the song playing (Up next shows it, so no note pops up).
    await library.getByRole("button", { name: "Add to queue: “Studio Master”" }).click();
    const queued = upNext.getByRole("button", { name: /^Play “Studio Master” now/ });
    await expect(queued).toBeVisible();
    await expect(player.getByRole("button", { name: "Next song" })).toBeEnabled();

    // Removed again: nothing comes next.
    await upNext.getByRole("button", { name: "Remove “Studio Master” from the queue" }).click();
    await expect(queued).toBeHidden();
    await expect(player.getByRole("button", { name: "Next song" })).toBeDisabled();

    // Clicking a song in Up next plays it now.
    await library.getByRole("button", { name: "Play next: “Studio Master”" }).click();
    await queued.click(START_SONG);
    await expect(player.getByTestId("player-title")).toHaveText("Studio Master");
    await expect(upNext.getByText(/Nothing after this song/)).toBeVisible();

    // Esc closes it. With it closed, a note says the song was added.
    await page.keyboard.press("Escape");
    await expect(upNext).toBeHidden();
    await library.getByRole("button", { name: "Add to queue: “Test Tone”" }).click();
    await expect(page.getByText("Added to the queue", { exact: true })).toBeVisible();
    await expect(player.getByRole("button", { name: "Next song" })).toBeEnabled();
    await player.getByRole("button", { name: "Close the player" }).click(START_SONG);
  });

  test("shows the song's lyrics, following along, and plays from a line clicked", async ({
    page,
    request,
  }) => {
    await request.put("/api/settings", { data: { saveFolder: folder } });
    // Made-up lyrics (the app gets them from LRCLIB): timed for Test Tone, none for the other.
    const asked: Record<string, string>[] = [];
    await page.route("**/api/lyrics?*", (route) => {
      const params = Object.fromEntries(new URL(route.request().url()).searchParams);
      asked.push(params);
      const synced = Array.from({ length: 10 }, (_, i) => ({ time: i * 2, text: `Line ${i + 1}` }));
      return route.fulfill({
        json: {
          lyrics:
            params.title === "Test Tone"
              ? {
                  synced,
                  plain: null,
                  instrumental: false,
                  track: "Test Tone",
                  artist: "Sine Wave",
                }
              : null,
        },
      });
    });
    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    const player = page.getByRole("region", { name: "Music player" });
    const lyrics = page.getByRole("region", { name: "Lyrics" });

    await library
      .getByRole("button", { name: /^Play “Test Tone”, by Sine Wave/ })
      .click(START_SONG);
    await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
    await player.getByRole("button", { name: "Lyrics" }).click();
    await expect(lyrics.getByRole("button", { name: "Line 1", exact: true })).toBeVisible();
    expect(asked[0]).toEqual({ title: "Test Tone", artist: "Sine Wave", duration: "20" });

    // The line being sung is marked, and moves on with the song.
    const current = lyrics.locator("[aria-current=true]");
    await expect(current).toHaveText(/^Line [1-3]$/, { timeout: 10_000 });
    // Clicking a line plays from there.
    await lyrics.getByRole("button", { name: "Line 6", exact: true }).click();
    await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(10);
    await expect(current).toHaveText(/^Line (6|7)$/);

    // Up next opens in its place; a song without lyrics says so.
    await player.getByRole("button", { name: "Up next" }).click();
    await expect(lyrics).toBeHidden();
    await page.keyboard.press("Escape");
    await player.getByRole("button", { name: "Next song" }).click(START_SONG);
    await expect(player.getByTestId("player-title")).toHaveText("Studio Master");
    await player.getByRole("button", { name: "Lyrics" }).click();
    await expect(lyrics.getByText("No lyrics found for this song.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(lyrics).toBeHidden();
    await player.getByRole("button", { name: "Close the player" }).click(START_SONG);
  });

  test("keyboard shortcuts work anywhere on the page, except while typing", async ({
    page,
    request,
  }) => {
    await request.put("/api/settings", { data: { saveFolder: folder } });
    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    const player = page.getByRole("region", { name: "Music player" });
    await library.getByRole("button", { name: /^Play “Test Tone”/ }).click(START_SONG);
    await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });

    // K pauses and plays; L goes 10 seconds on; M mutes.
    await page.keyboard.press("k");
    await expect.poll(() => audio(page)).toMatchObject({ paused: true });
    await page.keyboard.press("l");
    await expect.poll(async () => (await audio(page)).time).toBeGreaterThanOrEqual(9.5);
    await page.keyboard.press("j");
    await expect.poll(async () => (await audio(page)).time).toBeLessThan(5);
    await page.keyboard.press("m");
    await expect.poll(() => audio(page)).toMatchObject({ muted: true });
    await page.keyboard.press("m");
    await expect.poll(() => audio(page)).toMatchObject({ muted: false });

    // Typing in a box types; the song stays paused.
    const filter = page.getByLabel("YouTube link", { exact: true });
    await filter.click();
    await page.keyboard.type("k");
    await expect(filter).toHaveValue("k");
    expect((await audio(page)).paused).toBe(true);
    await filter.fill("");
    await filter.blur();

    // Shift+N: the next song.
    await page.keyboard.press("Shift+N", START_SONG);
    await expect(player.getByTestId("player-title")).toHaveText("Studio Master");

    // ? lists the shortcuts.
    await page.keyboard.press("?");
    await expect(page.getByText("Keyboard shortcuts", { exact: true })).toBeVisible();
    await player.getByRole("button", { name: "Close the player" }).click(START_SONG);
  });

  test("carries on where it left off, after the page is opened again", async ({
    page,
    request,
  }) => {
    await request.put("/api/settings", { data: { saveFolder: folder } });
    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    const player = page.getByRole("region", { name: "Music player" });
    await library.getByRole("button", { name: /^Play “Test Tone”/ }).click(START_SONG);
    await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
    await page.keyboard.press("k");
    await expect.poll(() => audio(page)).toMatchObject({ paused: true });
    await player.getByRole("slider", { name: "Seek" }).fill("12");

    // Opened again: the same song, paused where it was, and nothing loaded yet.
    await page.reload();
    await expect(player.getByTestId("player-title")).toHaveText("Test Tone");
    await expect(player.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    await expect(player.getByRole("slider", { name: "Seek" })).toHaveAttribute(
      "aria-valuetext",
      "0:12 of 0:20",
    );
    expect(await audio(page)).toMatchObject({ paused: true, hasSource: false });
    // The rest of the queue is there too.
    await expect(player.getByRole("button", { name: "Next song" })).toBeEnabled();

    // Play carries on from there.
    await player.getByRole("button", { name: "Play", exact: true }).click(START_SONG);
    await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
    expect((await audio(page)).time).toBeGreaterThanOrEqual(11.5);

    // Closed, it's forgotten.
    await player.getByRole("button", { name: "Close the player" }).click(START_SONG);
    await page.reload();
    await expect(library.getByRole("button", { name: /^Play “Test Tone”/ })).toBeVisible();
    await expect(player).toBeHidden();
  });

  test("the folder's songs can be filtered and put in order", async ({ page, request }) => {
    await request.put("/api/settings", { data: { saveFolder: folder } });
    await page.goto("/");
    const library = page.getByRole("region", { name: "Your music" });
    const rows = library.getByRole("listitem");
    await expect(rows).toHaveCount(2);
    // Newest first, then by title.
    await expect(rows.first()).toContainText("Test Tone");
    await library.getByRole("combobox", { name: "Order songs by" }).selectOption("title");
    await expect(rows.first()).toContainText("Studio Master");
  });
});
