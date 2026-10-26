import { test, expect, type Page } from "@playwright/test";
import { stayOffline } from "./stand-ins";

// Signing in with Spotify in Playlist mode, then opening one of your
// playlists whole. Spotify isn't asked: the sign-in routes and the playlist
// are the test's own answers, and leaving for Spotify's sign-in page comes
// straight back to the app.

const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const ID = "1aBcDeFgHiJkLmNoPqRsTu";
const LINK = `https://open.spotify.com/playlist/${ID}`;
const REDIRECT = "http://127.0.0.1:5099/api/spotify/callback";

const song = (n: number) => {
  const id = `${String(n).padStart(4, "0")}Foc5Q5nqNiosCNqttz`.slice(0, 22);
  return {
    id,
    url: `https://open.spotify.com/track/${id}`,
    title: `Song ${n}`,
    artists: "Band",
    duration: 200,
    explicit: false,
  };
};

/** The app's sign-in routes, as a little Spotify account the test controls. */
async function standInAccount(page: Page) {
  const state = { clientId: null as string | null, signedInAs: null as string | null };
  const status = () => ({ canSignIn: true, redirectUri: REDIRECT, error: null, ...state });
  await page.route("**/api/spotify/account", (route) => route.fulfill({ json: status() }));
  await page.route("**/api/spotify/account/client-id", async (route) => {
    const { clientId } = route.request().postDataJSON() as { clientId: string | null };
    if (clientId && !/^[0-9a-f]{32}$/i.test(clientId)) {
      return route.fulfill({
        status: 400,
        json: {
          message: "A Client ID is 32 letters and digits (0-9, a-f), from your Spotify app's page.",
        },
      });
    }
    state.clientId = clientId;
    await route.fulfill({ json: status() });
  });
  // Spotify's sign-in page, played by going straight back to the app signed in.
  await page.route("**/api/spotify/account/sign-in", async (route) => {
    state.signedInAs = "moomoo";
    await route.fulfill({ json: { url: "/" } });
  });
  await page.route("**/api/spotify/account/sign-out", async (route) => {
    state.signedInAs = null;
    await route.fulfill({ json: status() });
  });
  await page.route("**/api/spotify/account/playlists", (route) =>
    route.fulfill({
      json: [{ id: ID, url: LINK, name: "Trance Legends", by: "moomoo", image: null, songs: 230 }],
    }),
  );
  await page.route("**/api/spotify/playlist?*", (route) =>
    route.fulfill({
      json: {
        source: "spotify",
        kind: "playlist",
        id: ID,
        url: LINK,
        name: "Trance Legends",
        by: "moomoo",
        image: null,
        tracks: Array.from({ length: 230 }, (_, n) => song(n)),
        maybeMore: false,
      },
    }),
  );
  return state;
}

test("signs in with Spotify and opens one of your playlists whole", async ({ page }) => {
  await stayOffline(page);
  const account = await standInAccount(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Playlist", exact: true }).click();

  // Set up once: the steps, the Redirect URI to add, and the Client ID.
  await page.getByRole("button", { name: "Set up Spotify sign-in" }).click();
  const setup = page.getByRole("form", { name: "Set up Spotify sign-in" });
  await expect(setup).toContainText(REDIRECT);
  await expect(setup.getByRole("link", { name: "Spotify developer dashboard" })).toHaveAttribute(
    "href",
    "https://developer.spotify.com/dashboard",
  );
  await setup.getByRole("textbox", { name: "Spotify Client ID" }).fill("not an id");
  await setup.getByRole("button", { name: "Save" }).click();
  await expect(setup.getByRole("alert")).toContainText("32 letters and digits");
  await setup.getByRole("textbox", { name: "Spotify Client ID" }).fill(CLIENT_ID);
  await setup.getByRole("button", { name: "Save" }).click();
  await expect(setup).toBeHidden();
  expect(account.clientId).toBe(CLIENT_ID);

  // Sign in: off to Spotify, and back to the app signed in, in Playlist mode still.
  await page.getByRole("button", { name: "Sign in with Spotify" }).click();
  await expect(page.getByTestId("spotify-signed-in-as")).toHaveText("moomoo");

  // Your playlists, one click to open, all 230 songs.
  const yours = page.getByRole("list", { name: "Your Spotify playlists" });
  await yours.getByRole("button", { name: "Trance Legends, 230 songs" }).click();
  const panel = page.getByRole("region", { name: /spotify playlist/i });
  await expect(panel.getByText("Song 229", { exact: true })).toBeVisible();
  await expect(panel).not.toContainText("first 100");
  await expect(yours.getByRole("button", { name: "Trance Legends, 230 songs" })).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in with Spotify" })).toBeVisible();
  await expect(yours).toBeHidden();
});

test("isn't offered on another device, which can't sign in here", async ({ page }) => {
  await stayOffline(page);
  await page.route("**/api/spotify/account", (route) =>
    route.fulfill({
      json: {
        canSignIn: false,
        clientId: null,
        signedInAs: null,
        redirectUri: REDIRECT,
        error: null,
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Playlist", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /playlist link/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up Spotify sign-in" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in with Spotify" })).toHaveCount(0);
});
