/**
 * Spotify song links. Spotify doesn't let anyone download its audio, but its
 * public embed player (the one other websites show — no account or API key
 * needed) tells us the song's name, artists and exact length. That's enough to
 * find the same recording on YouTube: search for "artist title", then prefer
 * uploads with the same length (see `targetDuration` in search.ts).
 */
import type { SpotifyTrack } from "@shared/schema";

const TRACK_ID_RE = /^[A-Za-z0-9]{22}$/;
const FETCH_TIMEOUT_MS = 10_000;
// Spotify serves the same page to any browser; a browser-like User-Agent just
// avoids being treated as an unknown bot.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

/** A failure with the HTTP status and message to send back to the browser. */
export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type SpotifyLink =
  | { kind: "track"; id: string }
  /** An album, playlist, artist, podcast… — or a link we can't read. */
  | { kind: "other"; type: string };

/**
 * Recognises Spotify links: open.spotify.com/track/…, the same with
 * /intl-xx/ or /embed/ in front, "spotify:track:…" URIs, and spotify.link
 * short links (which we can't open — see `spotifyLinkError`). Anything else,
 * including plain search text that mentions Spotify, gives undefined.
 */
export function parseSpotifyLink(input: string): SpotifyLink | undefined {
  const text = input.trim();

  const uri = /^spotify:([a-z]+):([A-Za-z0-9]+)$/i.exec(text);
  if (uri) return toLink(uri[1].toLowerCase(), uri[2]);

  if (/\s/.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host === "spotify.link" || host.endsWith(".app.link")) {
    return { kind: "other", type: "short link" };
  }
  if (host !== "open.spotify.com" && host !== "play.spotify.com") return undefined;

  const parts = url.pathname
    .split("/")
    .filter((part) => part && part !== "embed" && !/^intl-[a-z-]+$/i.test(part));
  return toLink((parts[0] ?? "page").toLowerCase(), parts[1] ?? "");
}

function toLink(type: string, id: string): SpotifyLink {
  return type === "track" && TRACK_ID_RE.test(id) ? { kind: "track", id } : { kind: "other", type };
}

/** What to tell the user when a Spotify link isn't a song we can look up. */
export function spotifyLinkError(link: Extract<SpotifyLink, { kind: "other" }>): string {
  if (link.type === "short link") {
    return "Spotify short links (spotify.link) can't be read. Open it, then copy the song's open.spotify.com link instead.";
  }
  const what = ["album", "playlist", "artist", "episode", "show"].includes(link.type)
    ? `a Spotify ${link.type === "show" ? "podcast" : link.type}`
    : "a Spotify page";
  return `That's ${what} — only song links work. In Spotify, use Share → Copy Song Link on a song.`;
}

type EmbedEntity = {
  type?: unknown;
  name?: unknown;
  artists?: unknown;
  duration?: unknown;
  visualIdentity?: { image?: unknown };
};

/** Reads the song details out of Spotify's embed page (Next.js `__NEXT_DATA__`). */
export function parseEmbedPage(html: string, id: string): SpotifyTrack {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  let data: {
    props?: { pageProps?: { status?: unknown; state?: { data?: { entity?: unknown } } } };
  };
  try {
    data = JSON.parse(match?.[1] ?? "");
  } catch {
    throw new SpotifyError(502, "Couldn't read the song from Spotify (its page has changed).");
  }

  const pageProps = data.props?.pageProps;
  if (pageProps?.status === 404) {
    throw new SpotifyError(404, "Spotify doesn't have that song — check the link.");
  }
  const entity = pageProps?.state?.data?.entity as EmbedEntity | undefined;
  if (entity?.type !== "track" || typeof entity.name !== "string" || !entity.name.trim()) {
    throw new SpotifyError(502, "Couldn't read the song from Spotify (its page has changed).");
  }

  const artists = (Array.isArray(entity.artists) ? entity.artists : [])
    .map((artist: { name?: unknown }) =>
      typeof artist?.name === "string" ? artist.name.trim() : "",
    )
    .filter(Boolean);

  // Cover art in a few sizes; take the biggest one up to 640px.
  const images = (Array.isArray(entity.visualIdentity?.image) ? entity.visualIdentity.image : [])
    .filter((img: { url?: unknown }) => typeof img?.url === "string")
    .sort(
      (a: { maxWidth?: number }, b: { maxWidth?: number }) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0),
    );
  const cover =
    images.find((img: { maxWidth?: number }) => (img.maxWidth ?? 0) <= 640) ?? images[0];

  return {
    id,
    url: `https://open.spotify.com/track/${id}`,
    title: entity.name.trim(),
    artists,
    duration:
      typeof entity.duration === "number" && entity.duration > 0
        ? Math.round(entity.duration / 1000)
        : null,
    thumbnail: (cover?.url as string | undefined) ?? null,
  };
}

/** Looks a song up on Spotify's public embed page. */
export async function fetchSpotifyTrack(id: string): Promise<SpotifyTrack> {
  if (!TRACK_ID_RE.test(id)) throw new SpotifyError(400, "That isn't a valid Spotify song link.");
  let res: Response;
  try {
    res = await fetch(`https://open.spotify.com/embed/track/${id}`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
    throw new SpotifyError(502, `Couldn't reach Spotify (${reason}).`);
  }
  if (res.status === 404)
    throw new SpotifyError(404, "Spotify doesn't have that song — check the link.");
  if (!res.ok) throw new SpotifyError(502, `Spotify answered with an error (HTTP ${res.status}).`);
  return parseEmbedPage(await res.text(), id);
}

// Suffixes Spotify adds that name a release, not a different recording.
// "Song - Live" or "Song - Acoustic" are different recordings, so they stay.
const RELEASE_SUFFIX_RE =
  /^((\d{4} )?(digital(ly)? )?remaster(ed)?( \d{4})?( version)?|radio edit|single version|album version|mono( version)?|stereo( version)?|explicit|clean|bonus track)$/i;

/**
 * The song title as people write it on YouTube: "Bohemian Rhapsody -
 * Remastered 2011" → "Bohemian Rhapsody", "Get Lucky (feat. Pharrell
 * Williams…)" → "Get Lucky".
 */
export function cleanTrackTitle(title: string): string {
  let clean = title.replace(/\s*[([](feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, "");
  const dash = clean.lastIndexOf(" - ");
  if (dash > 0 && RELEASE_SUFFIX_RE.test(clean.slice(dash + 3).trim()))
    clean = clean.slice(0, dash);
  return clean.replace(/\s+/g, " ").trim() || title.trim();
}

/**
 * What to search YouTube for: the main artist, the cleaned-up title, and
 * "audio" — which brings the artist's "Official Audio" uploads (the plain
 * studio recording, no video intro) up in YouTube's results.
 */
export function spotifySearchQuery(track: Pick<SpotifyTrack, "title" | "artists">): string {
  return [track.artists[0], cleanTrackTitle(track.title), "audio"].filter(Boolean).join(" ");
}
