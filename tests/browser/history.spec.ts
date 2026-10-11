import { test, expect, type APIRequestContext } from "@playwright/test";
import type { Download } from "../../shared/schema";

// Taking songs out of Recent Extractions, and clearing it, with Undo — against
// the test server's own (throwaway) history, filled for the test.

const day = 24 * 60 * 60 * 1000;
const songs = ["Queen - Bohemian Rhapsody", "Daft Punk - Get Lucky", "ABBA - Dancing Queen"];
const history: Download[] = songs.map((title, i) => ({
  id: 900 + i,
  url: `https://www.youtube.com/watch?v=hist${String(i).padStart(7, "0")}`,
  title,
  downloadedAt: new Date(Date.now() - (i + 1) * day).toISOString(),
}));

const replaceHistory = async (request: APIRequestContext, entries: Download[]) => {
  await request.delete("/api/downloads");
  if (entries.length > 0) await request.post("/api/downloads/restore", { data: { entries } });
};

test.describe("Recent Extractions: removing songs (browser)", () => {
  // What the history held before (other tests' downloads), put back afterwards.
  let before: Download[] = [];
  test.beforeEach(async ({ request }) => {
    before = (await (await request.get("/api/downloads")).json()) as Download[];
    await replaceHistory(request, history);
  });
  test.afterEach(async ({ request }) => {
    await replaceHistory(request, before);
  });

  test("a song can be taken out and put back, and the whole list cleared and put back", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const section = page.locator("section", {
      has: page.getByRole("heading", { name: /recent extractions/i }),
    });
    const rows = section.getByRole("listitem");
    await expect(rows).toHaveCount(3);

    // ×: it's gone from the list (and the app's history), with Undo in the note.
    await section
      .getByRole("button", { name: "Remove Daft Punk - Get Lucky from the history" })
      .click();
    await expect(rows).toHaveCount(2);
    await expect(section.getByText("Daft Punk - Get Lucky")).toBeHidden();
    const titles = async () =>
      ((await (await request.get("/api/downloads")).json()) as Download[]).map((e) => e.title);
    expect(await titles()).toEqual([songs[0], songs[2]]);
    await expect(
      page.getByText("Removed “Daft Punk - Get Lucky” from the history", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText("Daft Punk - Get Lucky");

    // Clear history asks first; Cancel keeps everything.
    await section.getByRole("button", { name: "Clear history" }).click();
    await section.getByRole("button", { name: "Cancel" }).click();
    await expect(rows).toHaveCount(3);
    await section.getByRole("button", { name: "Clear history" }).click();
    await section
      .getByRole("group", { name: "Clear the history?" })
      .getByRole("button", { name: "Clear history" })
      .click();
    await expect(section.getByText("No downloads yet")).toBeVisible();
    expect(await titles()).toEqual([]);
    await expect(
      page.getByText("Cleared 3 downloads from the history", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(rows).toHaveCount(3);
    expect(await titles()).toEqual(songs);
  });
});
