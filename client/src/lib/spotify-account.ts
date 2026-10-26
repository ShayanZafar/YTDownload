/**
 * Signing in with Spotify, as the page sees it: the app's server does the
 * sign-in and keeps it (see server/spotify-sign-in.ts); the page sets the
 * Client ID, sends the browser to Spotify's sign-in page, and lists your
 * playlists.
 */
import { z } from "zod";
import { api } from "@shared/routes";
import {
  ownPlaylistSchema,
  spotifyAccountSchema,
  type OwnPlaylist,
  type SpotifyAccount,
} from "@shared/schema";
import { requestJson } from "@/lib/save-to-folder";

export const fetchSpotifyAccount = (): Promise<SpotifyAccount> =>
  requestJson(spotifyAccountSchema, api.spotifyAccount.status.path);

export const saveClientId = (clientId: string | null): Promise<SpotifyAccount> =>
  requestJson(spotifyAccountSchema, api.spotifyAccount.clientId.path, {
    method: "PUT",
    json: { clientId },
  });

export const signOutOfSpotify = (): Promise<SpotifyAccount> =>
  requestJson(spotifyAccountSchema, api.spotifyAccount.signOut.path, { method: "POST", json: {} });

/** Where to send the browser to sign in (Spotify's own page). */
export const startSpotifySignIn = async (): Promise<string> =>
  (
    await requestJson(z.object({ url: z.string() }), api.spotifyAccount.signIn.path, {
      method: "POST",
      json: {},
    })
  ).url;

export const fetchOwnPlaylists = (): Promise<OwnPlaylist[]> =>
  requestJson(z.array(ownPlaylistSchema), api.spotifyAccount.playlists.path);

/** Spotify's page for making the app whose Client ID the app needs. */
export const SPOTIFY_DASHBOARD = "https://developer.spotify.com/dashboard";
