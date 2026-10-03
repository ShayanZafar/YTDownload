/**
 * Makes the app's icons — the header's logo, white headphones on a dark tile —
 * for the browser tab and for phones' home screens (client/public, listed in
 * manifest.webmanifest). Run it again after changing the design:
 *
 *   npx tsx scripts/make-icons.ts
 *
 * The pictures are drawn by your installed Chrome (through Playwright).
 */
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const PUBLIC = path.resolve(import.meta.dirname, "..", "client", "public");
const TILE = "#171717"; // the theme's --primary
const GLYPH = "#fafafa"; // --primary-foreground
// lucide's "headphones" (the header's icon), drawn on a 24 x 24 grid.
const HEADPHONES =
  "M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3";

/**
 * The icon on a 512 x 512 canvas. A rounded tile for browsers; a square that
 * fills the canvas for phones, which round the corners themselves — with the
 * headphones smaller, inside the circle Android keeps ("maskable").
 */
function icon(shape: "rounded" | "square"): string {
  const scale = shape === "rounded" ? 15 : 12;
  const offset = 256 - 12 * scale;
  const tile =
    shape === "rounded"
      ? `<rect width="512" height="512" rx="112" fill="${TILE}"/>`
      : `<rect width="512" height="512" fill="${TILE}"/>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`,
    tile,
    `<path d="${HEADPHONES}" transform="translate(${offset} ${offset}) scale(${scale})"`,
    ` fill="none" stroke="${GLYPH}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    `</svg>`,
  ].join("");
}

const pictures: { file: string; shape: "rounded" | "square"; size: number }[] = [
  { file: "favicon.png", shape: "rounded", size: 48 },
  { file: "icons/icon-192.png", shape: "rounded", size: 192 },
  { file: "icons/icon-512.png", shape: "rounded", size: 512 },
  { file: "icons/maskable-512.png", shape: "square", size: 512 },
  { file: "apple-touch-icon.png", shape: "square", size: 180 },
];

async function main() {
  await mkdir(path.join(PUBLIC, "icons"), { recursive: true });
  await writeFile(path.join(PUBLIC, "icon.svg"), icon("rounded") + "\n");

  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const { file, shape, size } of pictures) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      const svg = icon(shape).replace("<svg ", `<svg width="${size}" height="${size}" `);
      await page.setContent(
        `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
      );
      await page.screenshot({ path: path.join(PUBLIC, file), omitBackground: true });
      await page.close();
      console.log(`${file} (${size} x ${size})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
