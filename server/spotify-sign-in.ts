import { createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { oneAtATime, writeJsonFile } from "./json-file";
import { sourceHealth } from "./source-health";

/**
 * Signing in with Spotify (the owner's choice of Oct 26, 2026), so the app can
 * list every song of the playlists you made or collaborate on — the one thing
 * Spotify's Web API still shares since its Feb 2026 changes, and only with
 * your sign-in. It's Spotify's "authorization code with PKCE" flow, which
 * needs no secret: you make a free app at developer.spotify.com (its owner
 * needs Spotify Premium), give this app its Client ID, and sign in once. The
 * sign-in is kept in data/spotify-sign-in.json (or SPOTIFY_SIGN_IN_FILE) and
 * renewed by itself; only this computer's server ever sees it.
 */

/** What the app asks to see: your playlists, private and collaborative ones too. Nothing else. */
export const SIGN_IN_SCOPES = "playlist-read-private playlist-read-collaborative";
/** Where Spotify sends the browser back. Spotify allows http only for 127.0.0.1, never "localhost". */
export const CALLBACK_PATH = "/api/spotify/callback";
/** How long a sign-in started on the page may take to come back. */
const PENDING_FOR_MS = 10 * 60_000;
/** Renew the pass this long before Spotify says it ends. */
const RENEW_EARLY_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

/** A Spotify app's Client ID: 32 hexadecimal digits. */
export const clientIdSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{32}$/i,
    "A Client ID is 32 letters and digits (0-9, a-f), from your Spotify app's page.",
  )
  .transform((id) => id.toLowerCase());

const savedSchema = z.object({
  clientId: z.string().nullable().default(null),
  account: z
    .object({
      name: z.string(),
      accessToken: z.string(),
      refreshToken: z.string(),
      /** When the access token ends (ms since the epoch). */
      expiresAt: z.number(),
    })
    .nullable()
    .default(null),
});

type Saved = z.infer<typeof savedSchema>;

export function signInFilePath(): string {
  return path.resolve(
    process.env.SPOTIFY_SIGN_IN_FILE || path.join(process.cwd(), "data", "spotify-sign-in.json"),
  );
}

/** Spotify said no, or couldn't be reached: the message is for the page. */
export class SignInError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The PKCE pair: a random verifier, and its SHA-256 (base64url) for Spotify. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Where Spotify sends the browser back to, on the port this server answered on. */
export function callbackUrl(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

type Pending = {
  verifier: string;
  redirectUri: string;
  returnTo: string;
  clientId: string;
  at: number;
};

type TokenAnswer = { access_token: string; refresh_token?: string; expires_in: number };

export class SpotifySignIn {
  // Each write waits for the previous one to finish.
  private readonly queue = oneAtATime();
  /** Sign-ins started on the page, by their `state`, until Spotify sends the browser back. */
  private pending = new Map<string, Pending>();
  /** One renewal at a time: everyone asking meanwhile waits for the same one. */
  private renewing?: Promise<string | undefined>;
  /** Why the last sign-in didn't work, for the page (cleared by the next one). */
  lastError: string | null = null;

  constructor(private readonly file: () => string = signInFilePath) {}

  async read(): Promise<Saved> {
    let text: string;
    try {
      text = await fs.readFile(this.file(), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      text = "{}";
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
    // A damaged file just means signed out — never a broken app.
    const parsed = savedSchema.safeParse(json);
    const saved = parsed.success ? parsed.data : savedSchema.parse({});
    const fromEnv = clientIdSchema.safeParse(process.env.SPOTIFY_CLIENT_ID ?? "");
    if (!saved.clientId && fromEnv.success) saved.clientId = fromEnv.data;
    return saved;
  }

  private write(change: (saved: Saved) => Saved): Promise<Saved> {
    return this.queue(async () => {
      const next = change(await this.read());
      await writeJsonFile(this.file(), next, { mode: 0o600 });
      return next;
    });
  }

  /** What the page shows: the Client ID, and who is signed in (never the passes). */
  async status(): Promise<{ clientId: string | null; signedInAs: string | null }> {
    const saved = await this.read();
    return { clientId: saved.clientId, signedInAs: saved.account?.name ?? null };
  }

  /** A new Client ID signs you out: the sign-in belonged to the old app. */
  async setClientId(clientId: string | null): Promise<void> {
    await this.write((saved) =>
      saved.clientId === clientId ? saved : { clientId, account: null },
    );
  }

  async signOut(): Promise<void> {
    this.lastError = null;
    await this.write((saved) => ({ ...saved, account: null }));
  }

  /**
   * Starts a sign-in: the address on Spotify to send the browser to. Spotify
   * sends it back to `redirectUri` with the `state` made here, and the
   * browser then goes back to `returnTo` (the app's own page).
   */
  async start(redirectUri: string, returnTo: string, now = Date.now()): Promise<string> {
    const { clientId } = await this.read();
    if (!clientId) throw new SignInError(400, "Add your Spotify app's Client ID first.");
    for (const [state, p] of this.pending)
      if (now - p.at > PENDING_FOR_MS) this.pending.delete(state);
    const state = randomBytes(24).toString("base64url");
    const { verifier, challenge } = pkcePair();
    this.pending.set(state, { verifier, redirectUri, returnTo, clientId, at: now });
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      scope: SIGN_IN_SCOPES,
      redirect_uri: redirectUri,
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    return `https://accounts.spotify.com/authorize?${params}`;
  }

  /**
   * Finishes a sign-in when Spotify sends the browser back: swaps the code
   * for passes, asks Spotify whose they are, and keeps them. Returns where to
   * send the browser; a sign-in that went wrong says why in `lastError`.
   */
  async finish(
    answer: { state?: string; code?: string; error?: string },
    now = Date.now(),
  ): Promise<string | undefined> {
    const pending = answer.state ? this.pending.get(answer.state) : undefined;
    if (!pending || now - pending.at > PENDING_FOR_MS) return undefined;
    this.pending.delete(answer.state!);
    try {
      if (answer.error || !answer.code) {
        throw new SignInError(
          400,
          answer.error === "access_denied"
            ? "Spotify sign-in was cancelled."
            : `Spotify didn't sign you in (${answer.error ?? "no code"}).`,
        );
      }
      const tokens = await this.askForTokens(
        {
          grant_type: "authorization_code",
          code: answer.code,
          redirect_uri: pending.redirectUri,
          client_id: pending.clientId,
          code_verifier: pending.verifier,
        },
        "sign you in",
      );
      if (!tokens.refresh_token)
        throw new SignInError(502, "Spotify's answer had no sign-in to keep.");
      const name = await whoIs(tokens.access_token);
      await this.write(() => ({
        clientId: pending.clientId,
        account: {
          name,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token!,
          expiresAt: now + tokens.expires_in * 1000,
        },
      }));
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : "Spotify sign-in went wrong.";
    }
    return pending.returnTo;
  }

  /**
   * A pass to ask Spotify's Web API with as the signed-in person, renewed if
   * it's about to end — or undefined when nobody is signed in or Spotify won't
   * renew it (then you're signed out, and the page says so).
   */
  async accessToken(now = Date.now()): Promise<string | undefined> {
    const { clientId, account } = await this.read();
    if (!clientId || !account) return undefined;
    if (account.expiresAt - RENEW_EARLY_MS > now) return account.accessToken;
    this.renewing ??= this.renew(clientId, account.refreshToken, now).finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renew(clientId: string, refreshToken: string, now: number) {
    let tokens: TokenAnswer;
    try {
      tokens = await this.askForTokens(
        { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId },
        "renew your sign-in",
      );
    } catch (err) {
      // Only a "no" from Spotify signs you out; no connection keeps the sign-in for next time.
      if (err instanceof SignInError && err.status === 400) {
        this.lastError = "Your Spotify sign-in ended. Sign in again.";
        await this.write((saved) => ({ ...saved, account: null }));
      }
      return undefined;
    }
    await this.write((saved) =>
      saved.account
        ? {
            ...saved,
            account: {
              ...saved.account,
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token ?? saved.account.refreshToken,
              expiresAt: now + tokens.expires_in * 1000,
            },
          }
        : saved,
    );
    return tokens.access_token;
  }

  private async askForTokens(form: Record<string, string>, what: string): Promise<TokenAnswer> {
    const res = await spotifyAccounts("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<TokenAnswer> & {
      error?: string;
      error_description?: string;
    };
    if (!res.ok || typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
      const why = json.error_description || json.error || `HTTP ${res.status}`;
      throw new SignInError(res.status === 400 ? 400 : 502, `Spotify couldn't ${what} (${why}).`);
    }
    return json as TokenAnswer;
  }
}

/** The signed-in person's name on Spotify. */
async function whoIs(accessToken: string): Promise<string> {
  const res = await spotifyAccounts("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const me = (await res.json().catch(() => ({}))) as { display_name?: unknown; id?: unknown };
  if (!res.ok)
    throw new SignInError(502, `Spotify wouldn't say who signed in (HTTP ${res.status}).`);
  const name =
    typeof me.display_name === "string" && me.display_name.trim() ? me.display_name : me.id;
  return typeof name === "string" && name.trim() ? name.trim() : "you";
}

/** How Spotify answered a signed-in request, for the source-health report: a 4xx but 429 is still an answer. */
export function recordAccountAnswer(res: Response): void {
  if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
    sourceHealth.record("spotify-account", true);
    return;
  }
  sourceHealth.record("spotify-account", false, {
    kind: res.status === 429 ? "throttled" : "error",
    note: `HTTP ${res.status}`,
  });
}

/** A request for the sign-in, recorded for the source-health report; never retried. */
async function spotifyAccounts(url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
    sourceHealth.record("spotify-account", false, { note: `Couldn't reach Spotify (${reason})` });
    throw new SignInError(502, `Couldn't reach Spotify (${reason}).`);
  }
  recordAccountAnswer(res);
  return res;
}

export const spotifySignIn = new SpotifySignIn();
