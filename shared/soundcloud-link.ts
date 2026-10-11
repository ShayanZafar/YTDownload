/**
 * Which addresses are SoundCloud tracks, made canonical — and the link a
 * download asks for, from YouTube or SoundCloud. Pure (no network, no Node
 * APIs), like youtube-link.ts.
 *
 * A SoundCloud track has one canonical link here, built from its number:
 *
 *   https://api.soundcloud.com/tracks/<digits>
 *
 * yt-dlp's SoundCloud search lists each track by its URN, URL-encoded —
 * https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A254112129 — and
 * yt-dlp opens that and the canonical link the same way (it asks SoundCloud's
 * API for track 254112129 either way). A search result's link goes to the
 * page and comes back to be downloaded, so the server checks it again here
 * instead of trusting it, and only the canonical link this returns ever
 * reaches yt-dlp.
 *
 * The checks run on the text exactly as it is — no URL parser, which would
 * quietly drop a user:password@, a :443 or a trailing dot, or decode %2F — so
 * anything but those two shapes is turned down: another host, http:,
 * credentials, a port, a query or a fragment (a private track's
 * secret_token), a trailing slash, a playlist, a user's page, a track's web
 * page, and any other encoding.
 */
import { extractVideoId } from "./youtube-link";

/** A track's number: digits, no leading zero (so each track has exactly one link). */
const TRACK_NUMBER = "([1-9][0-9]{0,19})";
// The canonical link, and the URN form yt-dlp lists ("%3A" is ":"; either case of its hex).
const TRACK_LINK_RE = new RegExp(
  `^https://api\\.soundcloud\\.com/tracks/(?:soundcloud%3[Aa]tracks%3[Aa])?${TRACK_NUMBER}$`,
);

/** The canonical link of SoundCloud track `number` (digits). */
export const soundCloudTrackLink = (number: string) =>
  `https://api.soundcloud.com/tracks/${number}`;

/** A SoundCloud track's canonical link, or null for anything else. */
export function parseSoundCloudLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = TRACK_LINK_RE.exec(raw);
  return match ? soundCloudTrackLink(match[1]) : null;
}

/** A SoundCloud track's number from its canonical (or URN-form) link, or null. */
export function soundCloudTrackNumber(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return TRACK_LINK_RE.exec(raw)?.[1] ?? null;
}

/** What a download or a save fetches: a YouTube video or a SoundCloud track, by its canonical link. */
export type AudioLink =
  { source: "youtube"; url: string; videoId: string } | { source: "soundcloud"; url: string };

/** The audio a link is for, or null if it's neither a YouTube video nor a SoundCloud track. */
export function audioLinkOf(raw: unknown): AudioLink | null {
  if (typeof raw !== "string") return null;
  const videoId = extractVideoId(raw);
  if (videoId) {
    return { source: "youtube", url: `https://www.youtube.com/watch?v=${videoId}`, videoId };
  }
  const track = parseSoundCloudLink(raw);
  return track ? { source: "soundcloud", url: track } : null;
}

// A track's artwork (or, without one, its uploader's picture) on SoundCloud's
// image host, 500×500: "https://i1.sndcdn.com/artworks-<key>-t500x500.jpg".
const ARTWORK_500_RE =
  /^https:\/\/i[0-9]{1,2}\.sndcdn\.com\/(?:artworks|avatars)-[A-Za-z0-9_-]{1,200}-t500x500\.jpg$/;

/** Is this a SoundCloud track's 500×500 artwork, so the app may fetch it for a cover? */
export const isSoundCloudArtworkUrl = (url: unknown): url is string =>
  typeof url === "string" && ARTWORK_500_RE.test(url);

/**
 * A SoundCloud track's artwork, 500×500, from any size of it yt-dlp names
 * ("…-original.png", "…-large.jpg"): SoundCloud serves each size under its
 * own suffix. Undefined for anything that isn't SoundCloud artwork.
 */
export function soundCloudArtworkUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const sized = url.replace(/-[0-9a-z]{1,20}\.(?:jpg|png)$/, "-t500x500.jpg");
  return isSoundCloudArtworkUrl(sized) ? sized : undefined;
}
