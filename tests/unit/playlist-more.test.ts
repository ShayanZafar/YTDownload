import { describe, expect, it } from "vitest";
import {
  ASK_AGAIN_AFTER_MS,
  aboutWhen,
  askAgainAt,
  playlistMoreNote,
} from "../../client/src/lib/playlist-more";
import type { PlaylistMore, SpotifyPlaylist } from "../../shared/schema";

// 11 PM on this computer, whatever its time zone.
const NOW = new Date(2026, 9, 12, 23, 0, 0);
const at = (hoursOn: number) => new Date(NOW.getTime() + hoursOn * 60 * 60_000);
const time = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const playlist = (songs: number, more?: PlaylistMore, maybeMore = true): SpotifyPlaylist => ({
  source: "spotify",
  kind: "playlist",
  id: "1aBcDeFgHiJkLmNoPqRsTu",
  url: "https://open.spotify.com/playlist/1aBcDeFgHiJkLmNoPqRsTu",
  name: "Trance Legends",
  by: "Shayan",
  image: null,
  tracks: Array.from({ length: songs }, (_, n) => ({
    id: `${String(n).padStart(4, "0")}Foc5Q5nqNiosCNqttz`.slice(0, 22),
    url: "https://open.spotify.com/track/x",
    title: `Song ${n}`,
    artists: "Band",
    duration: 200,
    explicit: false,
  })),
  maybeMore,
  ...(more && { more }),
});

describe("aboutWhen", () => {
  it("says the time, with tomorrow or the date when it isn't today", () => {
    expect(aboutWhen(at(0.5), NOW)).toBe(`at about ${time(at(0.5))}`);
    expect(aboutWhen(at(6), NOW)).toBe(`tomorrow at about ${time(at(6))}`);
    const later = at(50);
    const date = later.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    expect(aboutWhen(later, NOW)).toBe(`on ${date} at about ${time(later)}`);
  });
});

describe("askAgainAt", () => {
  const now = NOW.getTime();

  it("asks at the time the answer gave, at once if it has passed", () => {
    expect(askAgainAt(at(6).toISOString(), undefined, now)).toBe(at(6).getTime());
    expect(askAgainAt(at(-1).toISOString(), undefined, now)).toBe(at(-1).getTime());
    // A new time after asking about another.
    expect(askAgainAt(at(6).toISOString(), at(-1).toISOString(), now)).toBe(at(6).getTime());
  });

  it("asks a minute later when the time it asked about comes back", () => {
    const passed = at(-0.01).toISOString();
    expect(askAgainAt(passed, passed, now)).toBe(now + ASK_AGAIN_AFTER_MS);
    // One still to come stays as it is.
    expect(askAgainAt(at(6).toISOString(), at(6).toISOString(), now)).toBe(at(6).getTime());
  });

  it("asks nothing without a time it can read", () => {
    expect(askAgainAt(undefined, undefined, now)).toBeUndefined();
    expect(askAgainAt("soon", undefined, now)).toBeUndefined();
  });
});

describe("playlistMoreNote", () => {
  it("says nothing under a whole playlist", () => {
    expect(playlistMoreNote(playlist(250, undefined, false), NOW)).toBeNull();
  });

  it("says Spotify refused, and when the app asks again by itself", () => {
    const retryAt = at(6).toISOString();
    expect(playlistMoreNote(playlist(100, { reason: "refused", retryAt }), NOW)).toBe(
      `Spotify isn't sharing more of this playlist right now (too many requests from this computer). The app asks again by itself tomorrow at about ${time(at(6))}, and the rest appear here then.`,
    );
    // Some pages came before the refusal: it says how many it has.
    expect(playlistMoreNote(playlist(300, { reason: "refused", retryAt }), NOW)).toMatch(
      /^Spotify isn't sharing more than these 300 songs right now/,
    );
    // Asked at that time and still refused with it (the app's clock a little
    // behind this one): no time that has passed, but when it asks again.
    const passed = at(-0.01).toISOString();
    expect(playlistMoreNote(playlist(100, { reason: "refused", retryAt: passed }), NOW)).toBe(
      "Spotify isn't sharing more of this playlist right now (too many requests from this computer). The app asks again by itself in a minute, and the rest appear here then.",
    );
  });

  it("says what failed, and that the app tries again in a minute", () => {
    const retryAt = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      playlistMoreNote(playlist(100, { reason: "failed", note: "HTTP 503", retryAt }), NOW),
    ).toBe(
      "Couldn't get the rest of this playlist from Spotify (HTTP 503). The app tries again in a minute.",
    );
  });

  it("blames Spotify's own playlists only when Spotify said so (404)", () => {
    expect(playlistMoreNote(playlist(100, { reason: "spotify-own" }), NOW)).toMatch(
      /^Spotify shared only the first 100 songs of this playlist \(it does that for its own playlists/,
    );
    // Without a reason, no guess.
    const unknown = playlistMoreNote(playlist(100), NOW);
    expect(unknown).toMatch(
      /^Spotify shared only the first 100 songs of this playlist\. For a later one/,
    );
    expect(unknown).not.toMatch(/its own playlists/);
  });

  it("says when the app's own limit cut the list", () => {
    expect(playlistMoreNote(playlist(1000, { reason: "limit" }), NOW)).toMatch(
      /^This is as far as the app got \(it lists at most 1,000 songs of a playlist\)\./,
    );
  });

  it("says how far the app lists a YouTube playlist", () => {
    expect(playlistMoreNote({ ...playlist(500), source: "youtube" }, NOW)).toMatch(
      /^The app lists the first 500 videos of a playlist\./,
    );
  });
});
