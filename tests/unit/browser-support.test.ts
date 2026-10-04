import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * The page has to work in every current browser — back to Safari 16.4, the
 * oldest one the build supports (Vite 8 and Tailwind CSS 4 need it; Chrome
 * and Edge 111, Firefox 128). Some JavaScript that Chrome and Firefox accept
 * still breaks in Safari when it runs, so no test in Chrome would notice. This
 * keeps it out of the page's code. (Regex lookbehind, which Safari before 16.4
 * rejected, is fine now.)
 */
// The page's own code, and the shared code it uses too.
const files = ["../../client/src", "../../shared"].flatMap((dir) => {
  const root = fileURLToPath(new URL(dir, import.meta.url));
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.split(/[\\/]/).includes("ui"))
    .map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));
});

describe("the page's code runs in every current browser", () => {
  it("finds the code to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each([
    [
      "`for await (` loops (Safari can't loop over a download stream; use getReader)",
      /\bfor\s+await\s*\(/,
    ],
  ])("has no %s", (_what, pattern) => {
    expect(files.filter(({ text }) => pattern.test(text)).map(({ file }) => file)).toEqual([]);
  });
});
