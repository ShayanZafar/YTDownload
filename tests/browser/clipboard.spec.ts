import { test, expect, type Page } from "@playwright/test";

// The Paste button and the copied-link suggestion under the main box. They run
// against a stand-in clipboard, never this computer's real one, and the app's
// answers (a video, a search, a Spotify playlist) come from the test, not from
// YouTube or Spotify.

const VIDEO_ID = "jNQXAC9IVRw";
const LINK = `https://youtu.be/${VIDEO_ID}?si=test`;
const OTHER_ID = "dQw4w9WgXcQ";
const OTHER_LINK = `https://www.youtube.com/watch?v=${OTHER_ID}`;
const PLAYLIST_ID = "37i9dQZF1DXcBWIGoYBM5M";
const PLAYLIST_LINK = `https://open.spotify.com/playlist/${PLAYLIST_ID}?si=test`;
const THUMBNAIL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";
const PLAYLIST = {
  kind: "playlist",
  id: PLAYLIST_ID,
  url: `https://open.spotify.com/playlist/${PLAYLIST_ID}`,
  name: "Clipboard Mix",
  by: "Moomoo",
  image: null,
  maybeMore: false,
  tracks: [
    {
      id: "4u7EnebtmKWzUH433cf5Qv",
      url: "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
      title: "Bohemian Rhapsody",
      artists: "Queen",
      duration: 354,
      explicit: false,
    },
  ],
};

type FakeClipboard = {
  /** What's copied; null: reading it is refused. */
  text: string | null;
  /**
   * The clipboard-read permission, as Chrome and Edge report it ("granted" once
   * you've allowed it). "unsupported": an error, as in Firefox and Safari, which
   * don't know that permission and confirm every read instead.
   */
  permission?: "granted" | "prompt" | "denied" | "unsupported";
  /** false: the browser has no Clipboard API. */
  api?: boolean;
  /** false: not a secure context, like plain http from a phone. */
  secure?: boolean;
};

type TestWindow = {
  copyForTest(text: string): void;
  clipboardStats(): { reads: number; queries: number };
};

/**
 * Replaces `navigator.clipboard` and the clipboard-read permission in the page.
 * `copy()` copies something else; `stats()` says how often the page asked about
 * the permission and read the clipboard.
 */
async function fakeClipboard(
  page: Page,
  { text, permission = "unsupported", api = true, secure = true }: FakeClipboard,
) {
  await page.addInitScript(
    ({ text, permission, api, secure }) => {
      const state = { text, reads: 0, queries: 0 };
      Object.assign(window, {
        copyForTest: (next: string) => (state.text = next),
        clipboardStats: () => ({ reads: state.reads, queries: state.queries }),
      });
      if (!secure) {
        Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
      }
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: api
          ? {
              readText: () => {
                state.reads++;
                return state.text === null
                  ? Promise.reject(new DOMException("Read permission denied.", "NotAllowedError"))
                  : Promise.resolve(state.text);
              },
            }
          : undefined,
      });
      const permissions = navigator.permissions as Permissions | undefined;
      Object.defineProperty(navigator, "permissions", {
        configurable: true,
        value: {
          query: (descriptor: PermissionDescriptor) => {
            if ((descriptor.name as string) !== "clipboard-read") {
              return permissions?.query(descriptor);
            }
            state.queries++;
            return permission === "unsupported"
              ? Promise.reject(new TypeError("Not a permission this browser knows"))
              : Promise.resolve({ name: "clipboard-read", state: permission });
          },
        },
      });
    },
    { text, permission, api, secure },
  );
}

const copy = (page: Page, text: string) =>
  page.evaluate((next) => (window as unknown as TestWindow).copyForTest(next), text);
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as TestWindow).clipboardStats());

/** Brings the page back to the front, and waits while it looks at the clipboard. */
async function comeBack(page: Page) {
  const { queries } = await stats(page);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(async () => (await stats(page)).queries).toBeGreaterThan(queries);
  await page.waitForTimeout(500); // for what it found to show
}

/** The app's answers: opening a video, a search, a Spotify playlist. Returns what was asked. */
async function answerApp(page: Page) {
  const asked = { videos: [] as string[], searches: [] as string[], playlists: [] as string[] };
  // spotify.link short links: "/Mix" leads to the playlist, "/Song" to its song.
  await page.route("**/api/spotify/link?*", async (route) => {
    const link = new URL(route.request().url()).searchParams.get("link") ?? "";
    await route.fulfill({
      json: link.endsWith("/Mix")
        ? { kind: "playlist", url: PLAYLIST.url }
        : { kind: "track", url: PLAYLIST.tracks[0].url },
    });
  });
  await page.route("**/api/video/info", async (route) => {
    const { url } = route.request().postDataJSON() as { url: string };
    asked.videos.push(url);
    await route.fulfill({ json: { title: "Clipboard test video", thumbnail: THUMBNAIL, url } });
  });
  await page.route("**/api/search?*", async (route) => {
    asked.searches.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    await route.fulfill({
      json: {
        results: [
          {
            id: OTHER_ID,
            url: OTHER_LINK,
            title: "Clipboard test song",
            channel: "Test Channel",
            duration: 212,
            thumbnail: THUMBNAIL,
            official: false,
            source: "youtube",
          },
        ],
        source: "youtube",
      },
    });
  });
  await page.route("**/api/spotify/playlist?*", async (route) => {
    asked.playlists.push(new URL(route.request().url()).searchParams.get("link") ?? "");
    await route.fulfill({ json: PLAYLIST });
  });
  return asked;
}

// The main box, named after the Link / Search / Spotify playlist switch.
const box = (page: Page, name = "YouTube link") => page.getByLabel(name, { exact: true });
const mode = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const pasteButton = (page: Page) => page.getByRole("button", { name: "Paste from the clipboard" });
const suggestion = (page: Page, label: string) =>
  page.getByRole("option", { name: `Link you copied: ${label}` });
const openedVideo = (page: Page) =>
  page.getByRole("button", { name: /^rename file: clipboard test video/i });
const toasts = (page: Page) =>
  page.getByRole("region", { name: /notifications/i }).getByRole("listitem");

test.describe("Paste", () => {
  test("opens a copied YouTube link, as if typed", async ({ page }) => {
    await fakeClipboard(page, { text: `  ${LINK}\n` });
    const asked = await answerApp(page);
    await page.goto("/");

    await pasteButton(page).click();
    await expect(openedVideo(page)).toBeVisible();
    await expect(box(page)).toHaveValue(LINK);
    expect(asked.videos).toEqual([LINK]);
  });

  test("opens a copied Spotify playlist in the playlist panel", async ({ page }) => {
    await fakeClipboard(page, { text: PLAYLIST_LINK });
    const asked = await answerApp(page);
    await page.goto("/");

    await pasteButton(page).click();
    const panel = page.getByRole("region", { name: /spotify playlist/i });
    await expect(panel.getByRole("heading", { name: "Clipboard Mix" })).toBeVisible();
    await expect(mode(page, "Playlist")).toHaveAttribute("aria-pressed", "true");
    await expect(box(page, "Playlist link")).toHaveValue(PLAYLIST_LINK);
    expect(asked.playlists).toEqual([PLAYLIST_LINK]);
  });

  test("opens a copied spotify.link short link where it leads", async ({ page }) => {
    await fakeClipboard(page, { text: "https://spotify.link/Mix" });
    const asked = await answerApp(page);
    await page.goto("/");

    await pasteButton(page).click();
    const panel = page.getByRole("region", { name: /spotify playlist/i });
    await expect(panel.getByRole("heading", { name: "Clipboard Mix" })).toBeVisible();
    await expect(mode(page, "Playlist")).toHaveAttribute("aria-pressed", "true");
    expect(asked.playlists).toEqual([PLAYLIST.url]);

    // A short link to a song searches for that song.
    await copy(page, "https://spotify.link/Song");
    await pasteButton(page).click();
    await expect(mode(page, "Search by song")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => asked.searches).toEqual([PLAYLIST.tracks[0].url]);
  });

  test("searches for other text, put in the box on one line", async ({ page }) => {
    await fakeClipboard(page, { text: "  daft punk\r\n one   more time \t" });
    const asked = await answerApp(page);
    await page.goto("/");

    await pasteButton(page).click();
    const results = page.getByRole("region", { name: /search results/i });
    await expect(results.getByRole("button", { name: /^clipboard test song, by /i })).toBeVisible();
    await expect(mode(page, "Search by song")).toHaveAttribute("aria-pressed", "true");
    await expect(box(page, "Song search")).toHaveValue("daft punk one more time");
    expect(asked).toEqual({ videos: [], searches: ["daft punk one more time"], playlists: [] });
  });

  test("says so when there's no text on the clipboard", async ({ page }) => {
    await fakeClipboard(page, { text: " \n " });
    const asked = await answerApp(page);
    await page.goto("/");

    await box(page).fill("keep me");
    await pasteButton(page).click();
    await expect(page.getByText("Nothing to paste").first()).toBeVisible();
    await expect(toasts(page)).toHaveCount(1);
    await expect(box(page)).toHaveValue("keep me");
    expect(asked).toEqual({ videos: [], searches: [], playlists: [] });
  });

  test("says how to allow it when Chrome or Edge blocks the clipboard", async ({ page }) => {
    await fakeClipboard(page, { text: null, permission: "denied" });
    await page.goto("/");

    await pasteButton(page).click();
    await expect(page.getByText("The browser blocked the clipboard").first()).toBeVisible();
    await expect(toasts(page)).toHaveCount(1);
    await expect(
      page.getByText(/turn on Clipboard\. Or press (Ctrl\+V|⌘V) in the box\./).first(),
    ).toBeVisible();
    await expect(box(page)).toBeFocused();
  });

  test("does nothing when the browser's own Paste button or question is dismissed", async ({
    context,
  }) => {
    // Firefox and Safari: their Paste button. Chrome and Edge: "Allow?", the first time.
    for (const permission of ["unsupported", "prompt"] as const) {
      const page = await context.newPage();
      await fakeClipboard(page, { text: null, permission });
      const asked = await answerApp(page);
      await page.goto("/");

      await pasteButton(page).click();
      await expect.poll(async () => (await stats(page)).reads, { message: permission }).toBe(1);
      await page.waitForTimeout(500); // for a toast to show, if there were one
      await expect(toasts(page), permission).toHaveCount(0);
      await expect(box(page), permission).toHaveValue("");
      expect(asked, permission).toEqual({ videos: [], searches: [], playlists: [] });
      await page.close();
    }
  });

  test("isn't there where the page can't read the clipboard", async ({ context }) => {
    // No Clipboard API; plain http from another device, like a phone.
    for (const clipboard of [{ api: false }, { secure: false }]) {
      const page = await context.newPage();
      await fakeClipboard(page, { text: LINK, permission: "granted", ...clipboard });
      await page.goto("/");

      await expect(box(page)).toBeVisible();
      await expect(pasteButton(page)).toHaveCount(0);
      await box(page).focus();
      await page.waitForTimeout(500);
      await expect(suggestion(page, `youtu.be/${VIDEO_ID}`)).toHaveCount(0);
      expect(await stats(page)).toEqual({ reads: 0, queries: 0 });
      await page.close();
    }
  });
});

test.describe("a copied link, suggested under the empty box", () => {
  test("shows once the browser lets the page read the clipboard unasked; a click opens it", async ({
    page,
  }) => {
    await fakeClipboard(page, { text: `Have you seen this? ${LINK}`, permission: "granted" });
    const asked = await answerApp(page);
    await page.goto("/");

    const option = suggestion(page, `youtu.be/${VIDEO_ID}`);
    await expect(option).toBeVisible();
    await expect(page.getByRole("combobox", { name: "YouTube link" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // Just the link: never the rest of what was copied.
    await expect(page.getByText("Have you seen this?")).toHaveCount(0);

    // Typing hides it; emptying the box brings it back.
    await box(page).fill("abc");
    await expect(option).toHaveCount(0);
    await box(page).fill("");
    await expect(option).toBeVisible();

    await option.click();
    await expect(openedVideo(page)).toBeVisible();
    await expect(box(page)).toHaveValue(LINK);
    await expect(option).toHaveCount(0);
    expect(asked.videos).toEqual([LINK]);

    // A copied Spotify playlist too: it opens in the playlist panel.
    await copy(page, PLAYLIST_LINK);
    await box(page).fill("");
    await comeBack(page);
    const playlist = suggestion(page, `spotify.com/playlist/${PLAYLIST_ID}`);
    await expect(playlist).toBeVisible();
    await playlist.click();
    const panel = page.getByRole("region", { name: /spotify playlist/i });
    await expect(panel.getByRole("heading", { name: "Clipboard Mix" })).toBeVisible();
    await expect(box(page, "Playlist link")).toHaveValue(PLAYLIST_LINK);
    expect(asked.playlists).toEqual([PLAYLIST_LINK]);
  });

  test("Enter opens it; Esc dismisses it, even after a reload, until something else is copied", async ({
    page,
  }) => {
    await fakeClipboard(page, { text: LINK, permission: "granted" });
    const asked = await answerApp(page);
    await page.goto("/");

    const option = suggestion(page, `youtu.be/${VIDEO_ID}`);
    await box(page).focus();
    await expect(option).toBeVisible();
    await expect(option).toHaveAttribute("aria-selected", "true");
    await expect(box(page)).toHaveAttribute(
      "aria-activedescendant",
      (await option.getAttribute("id")) ?? "",
    );
    await box(page).press("Escape");
    await expect(option).toHaveCount(0);
    await expect(box(page)).toBeFocused();

    // Still on the clipboard: not suggested again, not even after a reload.
    await comeBack(page);
    await expect(option).toHaveCount(0);
    await page.reload();
    await comeBack(page);
    await expect(option).toHaveCount(0);

    // Something else copied, then that link again: it's suggested again.
    await copy(page, "just some words");
    await comeBack(page);
    await expect(page.getByRole("option")).toHaveCount(0);
    await copy(page, LINK);
    await comeBack(page);
    await expect(option).toBeVisible();

    // Enter in the empty box opens it, and then it isn't suggested again either.
    await box(page).focus();
    await box(page).press("Enter");
    await expect(openedVideo(page)).toBeVisible();
    expect(asked.videos).toEqual([LINK]);
    await page.reload();
    await comeBack(page);
    await expect(option).toHaveCount(0);

    // A newly copied link is; its × dismisses it too.
    await copy(page, OTHER_LINK);
    await comeBack(page);
    const other = suggestion(page, `youtu.be/${OTHER_ID}`);
    await expect(other).toBeVisible();
    await page.getByRole("button", { name: "Dismiss the link you copied" }).click();
    await expect(other).toHaveCount(0);
    await comeBack(page);
    await expect(other).toHaveCount(0);
    expect(asked.videos).toEqual([LINK]);
  });

  test("isn't offered unless the browser lets the page read the clipboard unasked", async ({
    context,
  }) => {
    for (const permission of ["prompt", "denied", "unsupported"] as const) {
      const page = await context.newPage();
      await fakeClipboard(page, { text: LINK, permission });
      await page.goto("/");

      await box(page).focus();
      await comeBack(page);
      await expect(suggestion(page, `youtu.be/${VIDEO_ID}`), permission).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "YouTube link" }), permission).toHaveCount(0);
      // It didn't even read the clipboard, so the browser had nothing to ask.
      expect((await stats(page)).reads, permission).toBe(0);
      await expect(pasteButton(page), permission).toBeVisible();
      await page.close();
    }
  });
});
