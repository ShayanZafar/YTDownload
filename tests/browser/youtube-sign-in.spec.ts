import { test, expect } from "@playwright/test";
import { stayOffline } from "./stand-ins";

// "Use my Firefox YouTube sign-in": off until it's turned on under the search
// box, kept by the app, and named by the message YouTube's bot check gets.
// YouTube is played by a stand-in: the app's answer when YouTube refused
// (REFUSED_MESSAGE in server/youtube-limits.ts, which the unit tests check).
const REFUSED_MESSAGE =
  "YouTube is refusing this computer right now. If YouTube keeps asking to confirm you're not a bot, turn on “Use my Firefox YouTube sign-in” under the search box.";

test.afterEach(async ({ request }) => {
  await request.put("/api/settings", { data: { youtubeSignIn: "off" } });
});

test("a bot check points to the Firefox sign-in setting, which the app keeps when it's turned on", async ({
  page,
  request,
}) => {
  await stayOffline(page);
  await request.put("/api/settings", { data: { youtubeSignIn: "off" } });
  await page.route("**/api/video/info", (route) =>
    route.fulfill({
      status: 502,
      json: { message: REFUSED_MESSAGE, source: "youtube", limited: true },
    }),
  );
  await page.goto("/");

  const signIn = page.getByRole("switch", { name: "Use my Firefox YouTube sign-in" });
  await expect(signIn).not.toBeChecked();

  await page.locator('input[type="url"]').fill("https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await page.getByRole("button", { name: "Extract" }).click();
  await expect(page.getByText(/turn on “Use my Firefox YouTube sign-in”/).first()).toBeVisible();

  await signIn.click();
  await expect(signIn).toBeChecked();
  await expect
    .poll(async () => (await (await request.get("/api/settings")).json()).youtubeSignIn)
    .toBe("firefox");
  await page.reload();
  await expect(signIn).toBeChecked();

  await signIn.click();
  await expect
    .poll(async () => (await (await request.get("/api/settings")).json()).youtubeSignIn)
    .toBe("off");
});
