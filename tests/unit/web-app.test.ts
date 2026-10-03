import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * What a phone's "Add to Home Screen" (or a browser's "Install") uses: the web
 * app manifest and its icons, made by scripts/make-icons.ts.
 */
const PUBLIC = fileURLToPath(new URL("../../client/public", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(PUBLIC, "manifest.webmanifest"), "utf8"));
const html = readFileSync(
  fileURLToPath(new URL("../../client/index.html", import.meta.url)),
  "utf8",
);

type Icon = { src: string; sizes: string; type: string; purpose: string };

/** A PNG's size, "192x192", from its header. */
function pngSize(file: string): string {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

describe("the web app manifest", () => {
  it("names the app and opens it in a window of its own", () => {
    expect(manifest).toMatchObject({
      short_name: "SonicExtract",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(manifest.name).toMatch(/SonicExtract/);
  });

  it("has the icons phones ask for, each the size it says", () => {
    const icons = manifest.icons as Icon[];
    expect(icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(
      expect.arrayContaining(["192x192 any", "512x512 any", "512x512 maskable"]),
    );
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      expect(pngSize(path.join(PUBLIC, icon.src)), icon.src).toBe(icon.sizes);
    }
  });

  it("is linked from the page, with the iPhone's icon and the tab's", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(pngSize(path.join(PUBLIC, "apple-touch-icon.png"))).toBe("180x180");
    expect(pngSize(path.join(PUBLIC, "favicon.png"))).toBe("48x48");
    expect(existsSync(path.join(PUBLIC, "icon.svg"))).toBe(true);
  });
});
