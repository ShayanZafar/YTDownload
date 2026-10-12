import { SPOTIFY_PLAYLIST_MAX_SONGS, type SpotifyPlaylist } from "@shared/schema";

/** How long after an answer that brings back the time it asked about the page asks again. */
export const ASK_AGAIN_AFTER_MS = 60_000;

/**
 * When the page asks again for a playlist whose answer said `retryAt` (ms
 * since the epoch), or undefined for no time it can read. `askedAbout` is
 * the `retryAt` it last asked about: when the same one comes back (the app's
 * computer's clock a little behind this device's), it asks a minute later,
 * not at once.
 */
export function askAgainAt(
  retryAt: string | undefined,
  askedAbout: string | undefined,
  now: number,
): number | undefined {
  const at = retryAt ? Date.parse(retryAt) : NaN;
  if (Number.isNaN(at)) return undefined;
  return retryAt === askedAbout ? Math.max(at, now + ASK_AGAIN_AFTER_MS) : at;
}

const LATER_ONE =
  " For a later one, copy its link in Spotify (Share → Copy Song Link) and paste it in the search box.";

/** "at about 5:10 AM", "tomorrow at about 5:10 AM", "on Wed, Oct 14 at about 5:10 AM" — this device's time. */
export function aboutWhen(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounded: a day with a clock change is 23 or 25 hours long.
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days <= 0) return `at about ${time}`;
  if (days === 1) return `tomorrow at about ${time}`;
  const date = at.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `on ${date} at about ${time}`;
}

/**
 * What the playlist panel says under a playlist it couldn't list to the end —
 * why, and when the app asks again by itself — or null for a whole playlist.
 */
export function playlistMoreNote(playlist: SpotifyPlaylist, now = new Date()): string | null {
  if (!playlist.maybeMore) return null;
  if (playlist.source === "youtube") {
    return "The app lists the first 500 videos of a playlist. For a later one, copy its link on YouTube and paste it in the box.";
  }
  const { more } = playlist;
  const retryAt = more?.retryAt ? new Date(more.retryAt) : undefined;
  switch (more?.reason) {
    case "refused": {
      const count = playlist.tracks.length;
      const what =
        count > 100
          ? `more than these ${count.toLocaleString("en")} songs`
          : "more of this playlist";
      // Once the time has passed, the page is asking — or, refused again with
      // the same time (the app's clock a little behind), waits a minute more.
      const when = !retryAt
        ? ""
        : ` The app asks again by itself ${retryAt > now ? aboutWhen(retryAt, now) : "shortly"}, and the rest appear here then.`;
      return `Spotify isn't sharing ${what} right now (too many requests from this computer).${when}`;
    }
    case "failed": {
      const why = more.note ? ` (${more.note})` : "";
      const when = !retryAt
        ? ""
        : retryAt.getTime() - now.getTime() <= 90_000
          ? " The app tries again in a minute."
          : ` The app tries again ${aboutWhen(retryAt, now)}.`;
      return `Couldn't get the rest of this playlist from Spotify${why}.${when}`;
    }
    case "spotify-own":
      return `Spotify shared only the first 100 songs of this playlist (it does that for its own playlists, like its mixes and editorial lists).${LATER_ONE}`;
    case "limit":
      return `This is as far as the app got (it lists at most ${SPOTIFY_PLAYLIST_MAX_SONGS.toLocaleString("en")} songs of a playlist).${LATER_ONE}`;
    default:
      // The embed page listed 100 and gave no way to ask for the rest: no guessing why.
      return `Spotify shared only the first 100 songs of this playlist.${LATER_ONE}`;
  }
}
