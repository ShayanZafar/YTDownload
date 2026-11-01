import { test, expect, type Locator, type Page } from "@playwright/test";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import { stayOffline } from "./stand-ins";

// Your music's filters (the comboboxes) and the card around the list of songs:
// opening a filter, whichever one and however wide the window, must leave the
// card where it was. The bug this guards against (the owner's, Oct 27, 2026):
// the rightmost filter's list hung past the card's right edge, and keeping its
// active choice in view scrolled the card — which hides its overflow — so the
// whole list of songs lurched to the left and was cut off.

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

const song = (file: string, tags: Record<string, string>) =>
  ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=1"],
    ...["-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "3"],
    ...Object.entries(tags).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]),
    file,
  ]);

// Enough years for the year filter's list to scroll (it shows about ten), and
// one album for all, so the filters are genre, artist and year: at 880 px and
// up the year filter is the last thing on its row, against the card's right edge.
const SONGS = 14;

let folder: string;

test.beforeAll(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-layout-e2e-"));
  for (let i = 1; i <= SONGS; i++) {
    await song(path.join(folder, `Song ${i}.mp3`), {
      title: `Song ${i}`,
      artist: `Artist ${i % 3}`,
      album: "One Album",
      genre: i % 2 ? "Rock" : "Jazz",
      date: String(1990 + i),
    });
  }
});

test.afterAll(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});

type Box = { x: number; y: number; width: number; height: number };
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;

/** Where the card around the songs is and how far it's scrolled, with the page's own scroll. */
const placeOf = (card: Locator) =>
  card.evaluate((el) => {
    const { x, y, width, height } = el.getBoundingClientRect();
    return {
      x,
      y,
      width,
      height,
      left: el.scrollLeft,
      top: el.scrollTop,
      page: [window.scrollX, window.scrollY],
    };
  });

/** Every control above the songs: the folder row's buttons, the filter row, and panels opened from it. */
const controlsOf = (card: Locator) => card.locator(":scope > div :is(button, input, select)");

/** Each control sits whole inside the card and the window: none cut off, none pushed out of sight. */
async function allInView(page: Page, card: Locator) {
  const cardBox = (await card.boundingBox())!;
  const viewport = { x: 0, y: 0, ...page.viewportSize()! };
  const controls = controlsOf(card);
  for (let i = 0; i < (await controls.count()); i++) {
    const control = controls.nth(i);
    const box = await control.boundingBox();
    expect(
      box,
      `control ${i} (${await control.getAttribute("aria-label")}) is laid out`,
    ).not.toBeNull();
    const text = (await control.getAttribute("aria-label")) ?? (await control.innerText());
    expect(inside(box!, cardBox), `“${text}” is whole inside the card`).toBe(true);
    expect(inside(box!, viewport), `“${text}” is on screen`).toBe(true);
  }
}

async function opensWithoutMovingTheCard(page: Page, box: Locator, card: Locator, list: Locator) {
  const before = await placeOf(card);
  await box.focus();
  await expect(list).toBeVisible();
  // Down the list, past what it shows at once: the list scrolls, nothing else does.
  for (let i = 0; i < SONGS; i++) await box.press("ArrowDown");
  const active = list.getByRole("option").last();
  await expect(box).toHaveAttribute("aria-activedescendant", (await active.getAttribute("id"))!);
  await expect.poll(() => placeOf(card)).toEqual(before);
  expect(inside((await active.boundingBox())!, (await list.boundingBox())!)).toBe(true);
  // The list hangs inside the card, not past its edge.
  const [listBox, cardBox] = [await list.boundingBox(), await card.boundingBox()];
  expect(listBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
  expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 0.5);
  await box.press("Escape");
  await expect(list).toBeHidden();
  expect(await placeOf(card)).toEqual(before);
}

test("opening a filter leaves the card around the songs where it was, at three widths", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  await request.put("/api/settings", { data: { saveFolder: folder } });
  // Wide enough for the year filter to end its row at the card's edge (880 and up), and not.
  for (const width of [1280, 880, 700]) {
    await test.step(`${width} px wide`, async () => {
      await page.setViewportSize({ width, height: 720 });
      await page.goto("/");
      const library = page.getByRole("region", { name: "Your music" });
      await expect(library.getByRole("listitem")).toHaveCount(SONGS);
      const card = library
        .getByRole("listitem")
        .first()
        .locator("xpath=ancestor::div[contains(@class, 'overflow-hidden')][1]");
      await library.scrollIntoViewIfNeeded();

      await allInView(page, card);

      for (const name of ["year", "genre", "artist"]) {
        const box = library.getByRole("combobox", { name: `Show songs of ${name}` });
        const list = library.getByRole("listbox", { name: `Show songs of ${name}` });
        await opensWithoutMovingTheCard(page, box, card, list);
      }

      // Every other control too: focusing it moves nothing, and nothing goes missing.
      const place = await placeOf(card);
      const controls = controlsOf(card);
      for (let i = 0; i < (await controls.count()); i++) {
        const control = controls.nth(i);
        if (!(await control.isEnabled())) continue;
        await control.focus();
        await expect(control).toBeFocused();
        expect(await placeOf(card)).toEqual(place);
        await allInView(page, card);
      }
      await page.mouse.click(5, 5);

      // The panels the filter row opens (Fill in details, Sanitize Filename, Housekeeping)
      // make the card taller, and nothing else: it stays as wide, where it was, unscrolled.
      for (const name of ["Fill in details", "Sanitize Filename", "Housekeeping"]) {
        const button = library.getByRole("button", { name, pressed: false });
        await button.click();
        const pressed = library.getByRole("button", { name, pressed: true });
        await expect(pressed).toBeVisible();
        const { height: _height, ...rest } = await placeOf(card);
        const { height: _was, ...wanted } = place;
        expect(rest).toEqual(wanted);
        await allInView(page, card);
        await pressed.click();
        await expect(button).toBeVisible();
      }
      expect(await placeOf(card)).toEqual(place);
    });
  }
});
