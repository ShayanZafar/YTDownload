/** Spotify: where a link leads, playlists, and signing in. */
import type { Express, Request } from "express";
import { api } from "@shared/routes";
import type { SpotifyAccount } from "@shared/schema";
import {
  SpotifyError,
  fetchMyPlaylists,
  fetchSpotifyPlaylist,
  playlistLinkError,
  readSpotifyLink,
  unusableLinkError,
} from "../spotify";
import { isLocalRequest, localOnly } from "../local-only";
import {
  CALLBACK_PATH,
  SignInError,
  callbackUrl,
  clientIdSchema,
  spotifySignIn,
} from "../spotify-sign-in";
import { validationError } from "./helpers";

export function registerSpotifyRoutes(app: Express) {
  // Where a Spotify link leads: the page asks before handling a spotify.link
  // short link, to know whether it's a song (search) or a playlist (the panel).
  app.get(api.spotify.link.path, async (req, res) => {
    const query = api.spotify.link.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    try {
      const link = await readSpotifyLink(query.data.link);
      if (!link) {
        return res.status(400).json({ message: "That isn't a Spotify link.", field: "link" });
      }
      if (link.kind === "other") {
        return res.status(400).json({ message: unusableLinkError(link), field: "link" });
      }
      res.json({ kind: link.kind, url: `https://open.spotify.com/${link.kind}/${link.id}` });
    } catch (err) {
      if (err instanceof SpotifyError) {
        return res.status(err.status).json({ message: err.message });
      }
      console.error("Opening the Spotify link failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Couldn't open it" });
    }
  });

  // The songs in a public Spotify playlist or album, for the playlist panel.
  // Picking one searches for its song link like any other (above).
  app.get(api.spotify.playlist.path, async (req, res) => {
    const query = api.spotify.playlist.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    try {
      const link = await readSpotifyLink(query.data.link);
      if (link?.kind !== "playlist" && link?.kind !== "album") {
        return res.status(400).json({ message: playlistLinkError(link), field: "link" });
      }
      // Your sign-in is this computer's: a phone on your Wi-Fi gets public playlists only.
      res.json(
        await fetchSpotifyPlaylist(link.kind, link.id, {
          signedIn: isLocalRequest(req) ? () => spotifySignIn.accessToken() : undefined,
        }),
      );
    } catch (err) {
      if (err instanceof SpotifyError) {
        return res.status(err.status).json({ message: err.message });
      }
      console.error("Reading the Spotify playlist failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Couldn't read it" });
    }
  });

  // Signing in with Spotify (see spotify-sign-in.ts): only on this computer.
  const accountStatus = async (req: Request): Promise<SpotifyAccount> => {
    const { clientId, signedInAs } = await spotifySignIn.status();
    return {
      canSignIn: isLocalRequest(req),
      clientId,
      signedInAs,
      redirectUri: callbackUrl(req.socket.localPort ?? 5000),
      error: spotifySignIn.lastError,
    };
  };
  const NOT_LOCAL_SIGN_IN =
    "Signing in with Spotify works in a browser on the computer running the app.";

  app.get(api.spotifyAccount.status.path, async (req, res) => {
    const status = await accountStatus(req);
    // Another device learns only that it can't sign in here.
    if (!status.canSignIn) {
      return res.json({ ...status, clientId: null, signedInAs: null, error: null });
    }
    res.json(status);
  });

  app.put(api.spotifyAccount.clientId.path, localOnly(NOT_LOCAL_SIGN_IN), async (req, res) => {
    const input = api.spotifyAccount.clientId.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    const id = input.data.clientId?.trim() ? clientIdSchema.safeParse(input.data.clientId) : null;
    if (id && !id.success) {
      return res.status(400).json({ message: id.error.issues[0].message, field: "clientId" });
    }
    await spotifySignIn.setClientId(id ? id.data! : null);
    res.json(await accountStatus(req));
  });

  app.post(api.spotifyAccount.signIn.path, localOnly(NOT_LOCAL_SIGN_IN), async (req, res) => {
    try {
      // Back to the page the sign-in started on: this app's own (localOnly checked it).
      const returnTo = `http://${req.headers.host}/`;
      res.json({
        url: await spotifySignIn.start(callbackUrl(req.socket.localPort ?? 5000), returnTo),
      });
    } catch (err) {
      if (err instanceof SignInError) return res.status(err.status).json({ message: err.message });
      throw err;
    }
  });

  app.post(api.spotifyAccount.signOut.path, localOnly(NOT_LOCAL_SIGN_IN), async (req, res) => {
    await spotifySignIn.signOut();
    res.json(await accountStatus(req));
  });

  app.get(api.spotifyAccount.playlists.path, localOnly(NOT_LOCAL_SIGN_IN), async (req, res) => {
    const pass = await spotifySignIn.accessToken();
    if (!pass) return res.status(401).json({ message: "Sign in with Spotify first." });
    try {
      res.json(await fetchMyPlaylists(pass));
    } catch (err) {
      if (err instanceof SpotifyError) return res.status(err.status).json({ message: err.message });
      throw err;
    }
  });

  // Spotify sends the browser back here after you sign in. It comes from
  // Spotify's site, so it can't be same-origin: what proves it's the sign-in
  // this app started is its one-time `state`.
  app.get(CALLBACK_PATH, async (req, res) => {
    if (!isLocalRequest(req)) return res.status(403).type("text/plain").send(NOT_LOCAL_SIGN_IN);
    const text = (v: unknown) => (typeof v === "string" && v.length <= 2000 ? v : undefined);
    const back = await spotifySignIn.finish({
      state: text(req.query.state),
      code: text(req.query.code),
      error: text(req.query.error),
    });
    if (!back) {
      return res
        .status(400)
        .type("text/plain")
        .send("This sign-in link has expired or was already used. Start again from the app.");
    }
    res.redirect(303, back);
  });
}
