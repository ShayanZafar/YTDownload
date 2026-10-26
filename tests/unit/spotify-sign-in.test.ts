// Signing in with Spotify (server/spotify-sign-in.ts), with Spotify played by a
// stand-in fetch (no network) and the sign-in kept in a throwaway file.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  SIGN_IN_SCOPES,
  SpotifySignIn,
  callbackUrl,
  clientIdSchema,
  pkcePair,
} from "../../server/spotify-sign-in";
import { sourceHealth } from "../../server/source-health";

const CLIENT_ID = "0123456789abcdef0123456789abcdef";
const REDIRECT = callbackUrl(5000);
const BACK = "http://localhost:5000/";

let dir: string;
let file: string;
let signIn: SpotifySignIn;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-spotify-sign-in-"));
  process.env.SOURCE_HEALTH_FILE = path.join(dir, "source-health.json");
});
beforeEach(async () => {
  file = path.join(dir, `sign-in-${Math.random().toString(36).slice(2)}.json`);
  signIn = new SpotifySignIn(() => file);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SPOTIFY_CLIENT_ID;
});
afterAll(async () => {
  await sourceHealth.flush().catch(() => {});
  delete process.env.SOURCE_HEALTH_FILE;
  await fs.rm(dir, { recursive: true, force: true });
});

type Asked = { url: string; form: URLSearchParams | null; headers: Record<string, string> };

/** Spotify's accounts service and `/v1/me`, answering with `token` (by grant type). */
function standInSpotify(token: (form: URLSearchParams) => Response) {
  const asked: Asked[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : null;
      asked.push({ url, form, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url === "https://accounts.spotify.com/api/token") return token(form!);
      if (url === "https://api.spotify.com/v1/me") {
        return Response.json({ id: "moomoo123", display_name: "moomoo" });
      }
      throw new TypeError(`fetch failed: nothing stands in for ${url}`);
    }),
  );
  return asked;
}

const tokens = (access: string, refresh?: string, expiresIn = 3600) =>
  Response.json({
    access_token: access,
    token_type: "Bearer",
    expires_in: expiresIn,
    ...(refresh && { refresh_token: refresh }),
  });

/** Signs in through Spotify's page (played here by reading the address it gives). */
async function signInAs(now = Date.now()) {
  await signIn.setClientId(CLIENT_ID);
  const asked = standInSpotify(() => tokens("access-1", "refresh-1"));
  const url = new URL(await signIn.start(REDIRECT, BACK, now));
  const state = url.searchParams.get("state")!;
  const back = await signIn.finish({ state, code: "the-code" }, now);
  return { url, state, back, asked };
}

describe("pkcePair", () => {
  it("makes a random verifier and its SHA-256, as Spotify's PKCE flow asks", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[\w-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkcePair().verifier).not.toBe(verifier);
  });
});

describe("clientIdSchema", () => {
  it("takes a Client ID as Spotify shows it, and turns down anything else", () => {
    expect(clientIdSchema.parse(` ${CLIENT_ID.toUpperCase()} `)).toBe(CLIENT_ID);
    for (const bad of ["", "abc", `${CLIENT_ID}0`, "https://example.com/0123456789abcdef01"]) {
      expect(clientIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("callbackUrl", () => {
  it("is on 127.0.0.1, the only http address Spotify allows (never localhost)", () => {
    expect(callbackUrl(5000)).toBe("http://127.0.0.1:5000/api/spotify/callback");
  });
});

describe("SpotifySignIn", () => {
  it("needs a Client ID before it can start", async () => {
    await expect(signIn.start(REDIRECT, BACK)).rejects.toMatchObject({ status: 400 });
    process.env.SPOTIFY_CLIENT_ID = CLIENT_ID;
    expect((await signIn.status()).clientId).toBe(CLIENT_ID);
  });

  it("sends you to Spotify asking only to read your playlists, with a PKCE challenge", async () => {
    const { url } = await signInAs();
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: SIGN_IN_SCOPES,
      redirect_uri: REDIRECT,
      code_challenge_method: "S256",
    });
    expect(SIGN_IN_SCOPES).toBe("playlist-read-private playlist-read-collaborative");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  });

  it("swaps the code for passes with the verifier, keeps them, and says who signed in", async () => {
    const { url, back, asked } = await signInAs();
    expect(back).toBe(BACK);
    const swap = asked[0].form!;
    expect(Object.fromEntries(swap)).toMatchObject({
      grant_type: "authorization_code",
      code: "the-code",
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
    });
    // The verifier is the one whose SHA-256 went to Spotify.
    expect(createHash("sha256").update(swap.get("code_verifier")!).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    );
    expect(asked[1]).toMatchObject({
      url: "https://api.spotify.com/v1/me",
      headers: { Authorization: "Bearer access-1" },
    });
    expect(await signIn.status()).toEqual({ clientId: CLIENT_ID, signedInAs: "moomoo" });
    expect(await signIn.accessToken()).toBe("access-1");
    expect(signIn.lastError).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "keeps the passes in a file only this user can read",
    async () => {
      await signInAs();
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    },
  );

  it("takes each sign-in back once, and only one it started", async () => {
    const { state } = await signInAs();
    expect(await signIn.finish({ state, code: "again" })).toBeUndefined();
    expect(await signIn.finish({ state: "made-up", code: "x" })).toBeUndefined();
    expect(await signIn.finish({ code: "x" })).toBeUndefined();
  });

  it("forgets a sign-in that took more than 10 minutes to come back", async () => {
    await signIn.setClientId(CLIENT_ID);
    const now = Date.now();
    const state = new URL(await signIn.start(REDIRECT, BACK, now)).searchParams.get("state")!;
    expect(await signIn.finish({ state, code: "x" }, now + 11 * 60_000)).toBeUndefined();
  });

  it("says when you cancelled on Spotify's page, or Spotify refused the code", async () => {
    await signIn.setClientId(CLIENT_ID);
    let state = new URL(await signIn.start(REDIRECT, BACK)).searchParams.get("state")!;
    expect(await signIn.finish({ state, error: "access_denied" })).toBe(BACK);
    expect(signIn.lastError).toBe("Spotify sign-in was cancelled.");

    standInSpotify(() =>
      Response.json(
        { error: "invalid_grant", error_description: "Invalid authorization code" },
        { status: 400 },
      ),
    );
    state = new URL(await signIn.start(REDIRECT, BACK)).searchParams.get("state")!;
    expect(await signIn.finish({ state, code: "stale" })).toBe(BACK);
    expect(signIn.lastError).toBe("Spotify couldn't sign you in (Invalid authorization code).");
    expect((await signIn.status()).signedInAs).toBeNull();
  });

  it("renews the pass by itself before it ends, keeping a new refresh token", async () => {
    const now = Date.now();
    await signInAs(now);
    const asked = standInSpotify((form) =>
      form.get("grant_type") === "refresh_token" ? tokens("access-2", "refresh-2") : tokens("x"),
    );
    // Still good for most of an hour: no renewal.
    expect(await signIn.accessToken(now + 10 * 60_000)).toBe("access-1");
    expect(asked).toHaveLength(0);
    // Nearly over: renewed once, however many ask at the same time.
    const later = now + 3600_000 - 30_000;
    const passes = await Promise.all([signIn.accessToken(later), signIn.accessToken(later)]);
    expect(passes).toEqual(["access-2", "access-2"]);
    expect(asked).toHaveLength(1);
    expect(Object.fromEntries(asked[0].form!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: CLIENT_ID,
    });
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    expect(saved.account).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("signs you out when Spotify won't renew, but keeps the sign-in when it can't be reached", async () => {
    const now = Date.now();
    await signInAs(now);
    const later = now + 2 * 3600_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await signIn.accessToken(later)).toBeUndefined();
    expect((await signIn.status()).signedInAs).toBe("moomoo");

    standInSpotify(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect(await signIn.accessToken(later)).toBeUndefined();
    expect((await signIn.status()).signedInAs).toBeNull();
    expect(signIn.lastError).toBe("Your Spotify sign-in ended. Sign in again.");
  });

  it("signs you out, and out of the old app when the Client ID changes", async () => {
    await signInAs();
    await signIn.setClientId(CLIENT_ID);
    expect((await signIn.status()).signedInAs).toBe("moomoo");
    await signIn.setClientId("fedcba9876543210fedcba9876543210");
    expect(await signIn.status()).toEqual({
      clientId: "fedcba9876543210fedcba9876543210",
      signedInAs: null,
    });

    await signInAs();
    await signIn.signOut();
    expect(await signIn.status()).toEqual({ clientId: CLIENT_ID, signedInAs: null });
    expect(await signIn.accessToken()).toBeUndefined();
  });

  it("reads a damaged file as signed out", async () => {
    await fs.writeFile(file, "{ not json");
    expect(await signIn.status()).toEqual({ clientId: null, signedInAs: null });
  });
});
