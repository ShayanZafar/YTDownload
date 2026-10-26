import { test, expect, type Page } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import ffmpegPath from "ffmpeg-static";
import { testServerFiles } from "./test-server-files";

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

  test("a seek past where a cut-short file stops stays on that song, and says so", async ({
    page,
    request,
  }) => {
    // A download that stopped part-way: the file says the song is 8 minutes
    // long, but has only its first part. Then a second song, after it.
    const cutShort = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-player-test-"));
    try {
      const whole = path.join(cutShort, "whole.m4a");
      await ffmpeg([
        ...["-f", "lavfi", "-i", "sine=frequency=440:duration=480"],
        ...["-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", whole],
      ]);
      const bytes = await fs.readFile(whole);
      await fs.rm(whole);
      await fs.writeFile(
        path.join(cutShort, "A Cut Short.m4a"),
        bytes.subarray(0, bytes.length / 8),
      );
      await ffmpeg([
        ...["-f", "lavfi", "-i", "sine=frequency=550:duration=60"],
        ...["-c:a", "libmp3lame", "-b:a", "64k", path.join(cutShort, "B After It.mp3")],
      ]);
      await request.put("/api/settings", { data: { saveFolder: cutShort } });
      await page.goto("/");
      const library = page.getByRole("region", { name: "Your music" });
      await library.getByRole("combobox", { name: "Order songs by" }).selectOption("title");
      await library.getByRole("button", { name: /^Play “A Cut Short”/ }).click(START_SONG);
      const player = page.getByRole("region", { name: "Music player" });
      await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });

      // Halfway: past where the file stops. It stays on the song, paused, and says why.
      await player.getByRole("slider", { name: "Seek" }).fill("240");
      await expect(player.getByRole("alert")).toContainText("The file stops before 4:00");
      await expect(player.getByTestId("player-title")).toHaveText("A Cut Short");
      await expect.poll(() => audio(page)).toMatchObject({ paused: true });

      // An earlier point plays.
      await player.getByRole("slider", { name: "Seek" }).fill("5");
      await player.getByRole("button", { name: "Play", exact: true }).click(START_SONG);
      await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
      await expect(player.getByRole("alert")).toBeHidden();
      await expect(player.getByTestId("player-title")).toHaveText("A Cut Short");
    } finally {
      await fs.rm(cutShort, { recursive: true, force: true });
    }
  });

  test.describe("with a long folder", () => {
    // 150 songs (copies of one song, named "Song 001" to "Song 150"), for the
    // list's Show more. A minute long, so none ends mid-test, and tiny.
    let manySongs: string;

    test.beforeAll(async () => {
      manySongs = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-player-test-"));
      const song = path.join(manySongs, "Song 001.mp3");
      await ffmpeg([
        ...["-f", "lavfi", "-i", "sine=frequency=550:duration=60"],
        ...["-ar", "8000", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "8k", song],
      ]);
      for (let n = 2; n <= 150; n++) {
        await fs.copyFile(song, path.join(manySongs, `Song ${String(n).padStart(3, "0")}.mp3`));
      }
    });

    test.afterAll(async () => {
      if (manySongs) await fs.rm(manySongs, { recursive: true, force: true });
    });

    test("lists it 100 songs at a time, and plays on from the song clicked", async ({
      page,
      request,
    }) => {
      await request.put("/api/settings", { data: { saveFolder: manySongs } });
      await page.goto("/");
      const library = page.getByRole("region", { name: "Your music" });
      const songs = library.getByRole("listitem");
      const player = page.getByRole("region", { name: "Music player" });
      const upNext = page.getByRole("region", { name: "Up next" });
      const comingUp = upNext.getByRole("button", { name: /^Play “.+” now/ });

      await expect(library.getByText("150 songs")).toBeVisible();
      await library.getByLabel("Order songs by").selectOption("title");
      await expect(songs).toHaveCount(100);
      await expect(songs.last()).toContainText("Song 100");

      // Show more lists the rest; their songs play like the first 100.
      await library.getByRole("button", { name: "Show more (50 more)" }).click();
      await expect(songs).toHaveCount(150);
      await expect(library.getByRole("button", { name: /^Show more/ })).toBeHidden();
      await library.getByRole("button", { name: /^Play “Song 120”/ }).click(START_SONG);
      await expect(player.getByTestId("player-title")).toHaveText("Song 120");
      await player.getByRole("button", { name: "Up next" }).click();
      await expect(comingUp.first()).toHaveAccessibleName(/^Play “Song 121” now/);

      // A filtered list plays on through the songs it shows: "13" finds Song
      // 013, 113 and 130 to 139, so after 113 comes 130.
      await library.getByLabel("Filter your music").fill("13");
      await expect(songs).toHaveCount(12);
      await library.getByRole("button", { name: /^Play “Song 113”/ }).click(START_SONG);
      await expect(player.getByTestId("player-title")).toHaveText("Song 113");
      await expect(comingUp).toHaveCount(10);
      await expect(comingUp.first()).toHaveAccessibleName(/^Play “Song 130” now/);
      await expect(comingUp.last()).toHaveAccessibleName(/^Play “Song 139” now/);
      await player.getByRole("button", { name: "Close the player" }).click(START_SONG);
    });
  });

  test("on a phone, plays songs picked on the phone — nothing is uploaded", async ({
    page,
    browserName,
  }) => {
    // What the app answers a browser on another device.
    await page.route("**/api/settings", (route) =>
      route.fulfill({ json: { saveFolder: null, canSaveToFolder: false, cpuCores: 4 } }),
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

  test("a song I'm tired of can be deleted from the folder, to the bin, and the next one plays", async ({
    page,
    request,
  }) => {
    // A folder of its own: Song A, B and C, listed by title.
    const tired = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-player-test-"));
    try {
      for (const title of ["Song A", "Song B", "Song C"]) {
        await ffmpeg([
          ...["-i", mp3, "-c", "copy", "-id3v2_version", "3"],
          ...["-metadata", `title=${title}`, path.join(tired, `${title}.mp3`)],
        ]);
      }
      await request.put("/api/settings", { data: { saveFolder: tired } });
      await page.goto("/");
      const library = page.getByRole("region", { name: "Your music" });
      const rows = library.getByRole("listitem");
      await expect(rows).toHaveCount(3);
      await library.getByRole("combobox", { name: "Order songs by" }).selectOption("title");
      await library.getByRole("button", { name: /^Play “Song A”/ }).click(START_SONG);
      const player = page.getByRole("region", { name: "Music player" });
      await expect(player.getByTestId("player-title")).toHaveText("Song A");
      await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });

      // Asked first: Cancel keeps it.
      await player.getByRole("button", { name: "Delete from folder" }).click();
      const dialog = page.getByRole("dialog", { name: "Delete from the folder?" });
      await expect(dialog).toContainText("Song A.mp3");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(rows).toHaveCount(3);
      await expect(player.getByTestId("player-title")).toHaveText("Song A");

      // Deleted: to the bin, out of the list, and the next song plays.
      await player.getByRole("button", { name: "Delete from folder" }).click();
      await dialog
        .getByRole("button", { name: /^Move to the (Trash|Recycle Bin)$/ })
        .click(START_SONG);
      await expect(dialog).toBeHidden();
      await expect(page.getByText(/^Moved to the (Trash|Recycle Bin)$/)).toBeVisible();
      await expect(rows).toHaveCount(2);
      await expect(library.getByRole("button", { name: /^Play “Song A”/ })).toHaveCount(0);
      await expect(player.getByTestId("player-title")).toHaveText("Song B");
      await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
      await expect(player.getByRole("button", { name: "Up next" })).toHaveAttribute(
        "title",
        "Up next: 1 song",
      );
      await expect(fs.stat(path.join(tired, "Song A.mp3"))).rejects.toThrow();
      await fs.stat(path.join(testServerFiles.TRASH_DIR, "files", "Song A.mp3"));

      // From the list, a song that isn't playing: it leaves the queue too.
      await library.getByRole("button", { name: "Delete from folder: “Song C”" }).click();
      await dialog
        .getByRole("button", { name: /^Move to the (Trash|Recycle Bin)$/ })
        .click(START_SONG);
      await expect(rows).toHaveCount(1);
      await expect(player.getByTestId("player-title")).toHaveText("Song B");
      await player.getByRole("button", { name: "Up next" }).click();
      await expect(page.getByText(/^Nothing after this song\./)).toBeVisible();
      await expect(fs.stat(path.join(tired, "Song C.mp3"))).rejects.toThrow();
    } finally {
      await request.put("/api/settings", { data: { saveFolder: null } });
      await fs.rm(tired, { recursive: true, force: true });
    }
  });

  test("a song that's another kind of file than its name says can be renamed, and a file that isn't audio never plays", async ({
    page,
    request,
  }) => {
    const odd = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-player-test-"));
    try {
      // An M4A named .mp3, and a program named .mp3.
      await ffmpeg([
        ...["-i", mp3, "-c:a", "aac", "-f", "mp4"],
        ...["-metadata", "title=Wrong Name", path.join(odd, "Wrong Name.mp3")],
      ]);
      await fs.writeFile(
        path.join(odd, "Not A Song.mp3"),
        Buffer.concat([Buffer.from("MZ"), Buffer.alloc(4000)]),
      );
      await request.put("/api/settings", { data: { saveFolder: odd } });
      await page.goto("/");
      const library = page.getByRole("region", { name: "Your music" });
      await expect(library.getByRole("listitem")).toHaveCount(2);

      // Not a song: it says what it is, can't be played, and can be deleted.
      const program = library.getByRole("button", { name: /^Play “Not A Song”/ });
      await expect(program).toBeDisabled();
      await expect(program).toHaveAccessibleName(/not a song: it's a Windows program/);
      await expect(library.getByText("Not a song: it's a Windows program")).toBeVisible();
      await expect(
        library.getByRole("button", { name: "Delete from folder: “Not A Song”" }),
      ).toBeVisible();

      // Fix name: renamed to .m4a, and it still plays.
      await library
        .getByRole("button", { name: "Fix name: “Wrong Name” is really a .m4a file" })
        .click();
      await expect(page.getByText("“Wrong Name” is now Wrong Name.m4a.")).toBeVisible();
      await expect(library.getByRole("button", { name: /^Fix name/ })).toHaveCount(0);
      await fs.stat(path.join(odd, "Wrong Name.m4a"));
      await expect(fs.stat(path.join(odd, "Wrong Name.mp3"))).rejects.toThrow();
      await library.getByRole("button", { name: /^Play “Wrong Name”/ }).click(START_SONG);
      await expect.poll(() => audio(page), { timeout: 30_000 }).toMatchObject({ playing: true });
    } finally {
      await request.put("/api/settings", { data: { saveFolder: null } });
      await fs.rm(odd, { recursive: true, force: true });
    }
  });
});
