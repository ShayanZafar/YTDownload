import { test, expect, type Page } from "@playwright/test";

// Watching a search result before choosing it: its thumbnail opens YouTube's
// own player right in the results list. The search answer comes from the test,
// and YouTube's player is a stand-in page, so nothing here reaches YouTube.

const FIRST = { id: "jNQXAC9IVRw", title: "Preview test song" };
const SECOND = { id: "dQw4w9WgXcQ", title: "Another test song" };
const THUMBNAIL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

async function answerApp(page: Page) {
  await page.route("**/api/search?*", (route) =>
    route.fulfill({
      json: {
        results: [FIRST, SECOND].map(({ id, title }) => ({
          id,
          url: `https://www.youtube.com/watch?v=${id}`,
          title,
          channel: "Test Channel",
          duration: 212,
          thumbnail: THUMBNAIL,
          official: false,
          source: "youtube",
        })),
        source: "youtube",
      },
    }),
  );
  // YouTube's embedded player, stood in for.
  const embedded: string[] = [];
  await page.route("https://www.youtube-nocookie.com/**", (route) => {
    embedded.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<p>Player</p>" });
  });
  return embedded;
}

async function searchFor(page: Page, text: string) {
  await page.getByRole("button", { name: "Search by song", exact: true }).click();
  await page.getByRole("searchbox", { name: /song search/i }).fill(text);
  await page.getByRole("button", { name: /^search$/i }).click();
  return page.getByRole("region", { name: /search results/i });
}

test("a search result's video plays in the list before it's chosen", async ({ page }) => {
  const embedded = await answerApp(page);
  await page.goto("/");
  const results = await searchFor(page, "preview test");

  // The thumbnail opens the video's player under its result, playing at once.
  const preview = results.getByRole("button", { name: `Preview ${FIRST.title}` });
  await preview.click();
  const player = results.locator(`iframe[title="Preview: ${FIRST.title}"]`);
  await expect(player).toBeVisible();
  await expect(player).toHaveAttribute("src", new RegExp(`/embed/${FIRST.id}\\?autoplay=1`));
  await expect.poll(() => embedded.length).toBe(1);
  // Nothing is chosen for download yet.
  await expect(results.getByRole("button", { name: /^preview test song, by /i })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // One at a time: another result's thumbnail swaps the player over.
  await results.getByRole("button", { name: `Preview ${SECOND.title}` }).click();
  await expect(player).toHaveCount(0);
  await expect(results.locator(`iframe[title="Preview: ${SECOND.title}"]`)).toBeVisible();

  // Choosing it from the player picks it for download; the video keeps playing.
  await results.getByRole("button", { name: "Choose this one" }).click();
  await expect(results.getByRole("button", { name: /^another test song, by /i })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator('a[href^="/api/video/download"]')).toHaveAttribute(
    "href",
    new RegExp(SECOND.id),
  );
  await expect(results.locator("iframe")).toHaveCount(1);

  // Closing it gets the thumbnail back.
  await results.getByRole("button", { name: "Close preview", exact: true }).click();
  await expect(results.locator("iframe")).toHaveCount(0);
  await expect(results.getByRole("button", { name: `Preview ${SECOND.title}` })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  // The thumbnail closes it too.
  await preview.click();
  await expect(player).toBeVisible();
  await results.getByRole("button", { name: `Close preview of ${FIRST.title}` }).click();
  await expect(results.locator("iframe")).toHaveCount(0);
});
