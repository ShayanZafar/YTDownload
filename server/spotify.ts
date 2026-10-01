/**
 * Spotify links. Spotify doesn't let anyone download its audio, but its
 * public embed player (the one other websites show — no account or API key
 * needed) tells us a song's name, artists and exact length. That's enough to
 * find the same recording on YouTube: search for "artist title", then prefer
 * uploads with the same length (see `targetDuration` in search.ts).
 *
 * The embed player for a playlist or album lists its songs the same way (the
 * first 100 of a playlist), which is what the playlist panel shows.
 */
import type { SpotifyPlaylist, SpotifyPlaylistTrack, SpotifyTrack } from "@shared/schema";
import { cleanTrackTitle } from "@shared/spotify-names";

export { cleanTrackTitle };

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
/** The most songs Spotify's embed page lists for a playlist. */
export const PLAYLIST_EMBED_LIMIT = 100;
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
  /** Things with a list of songs. */
  | { kind: "playlist"; id: string }
  | { kind: "album"; id: string }
  /** An artist, podcast… — or a link we can't read. */
  | { kind: "other"; type: string };

/**
 * Recognises Spotify links: open.spotify.com/track/… (or /playlist/…,
 * /album/…), the same with /intl-xx/ or /embed/ in front, "spotify:track:…"
 * URIs, and spotify.link short links (which we can't open — see
 * `spotifyLinkError`). Anything else, including plain search text that
 * mentions Spotify, gives undefined.
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
  if (SPOTIFY_ID_RE.test(id)) {
    if (type === "track") return { kind: "track", id };
    if (type === "playlist") return { kind: "playlist", id };
    if (type === "album") return { kind: "album", id };
  }
  return { kind: "other", type };
}

const SHORT_LINK_ERROR =
  "Spotify short links (spotify.link) can't be read. Open it, then copy its open.spotify.com link instead.";

/** "a Spotify artist", "a Spotify podcast"… for a link of this type. */
const aSpotify = (type: string) =>
  ["album", "playlist", "artist", "episode", "show"].includes(type)
    ? `a Spotify ${type === "show" ? "podcast" : type}`
    : "a Spotify page";

/** What to tell the user when a Spotify link searched for isn't a song we can look up. */
export function spotifyLinkError(link: Exclude<SpotifyLink, { kind: "track" }>): string {
  if (link.kind === "playlist" || link.kind === "album") {
    return `That's a Spotify ${link.kind}, not a song — choose “Spotify playlist” above the search box to pick one of its songs.`;
  }
  if (link.type === "short link") return SHORT_LINK_ERROR;
  return `That's ${aSpotify(link.type)} — only song links work. In Spotify, use Share → Copy Song Link on a song.`;
}

/** What to tell the user when what they gave the playlist panel isn't a playlist or album link. */
export function playlistLinkError(link: SpotifyLink | undefined): string {
  if (link?.kind === "track") {
    return "That's a Spotify song, not a playlist — paste it in the search box to find it on YouTube.";
  }
  if (link?.kind === "other" && link.type === "short link") return SHORT_LINK_ERROR;
  const what = link?.kind === "other" ? `That's ${aSpotify(link.type)}. ` : "";
  return `${what}Paste a Spotify playlist or album link — in Spotify, use Share → Copy link to playlist.`;
}

type EmbedEntity = {
  type?: unknown;
  name?: unknown;
  subtitle?: unknown;
  artists?: unknown;
  duration?: unknown;
  trackList?: unknown;
  visualIdentity?: { image?: unknown };
};

type EmbedTrackItem = {
  uri?: unknown;
  title?: unknown;
  subtitle?: unknown;
  duration?: unknown;
  isExplicit?: unknown;
};

/**
 * The page's data (Next.js `__NEXT_DATA__`): what's embedded, or undefined if
 * Spotify says it doesn't exist.
 */
function readEmbedEntity(html: string, what: string): EmbedEntity | undefined {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  let data: {
    props?: { pageProps?: { status?: unknown; state?: { data?: { entity?: unknown } } } };
  };
  try {
    data = JSON.parse(match?.[1] ?? "");
  } catch {
    throw new SpotifyError(502, `Couldn't read the ${what} from Spotify (its page has changed).`);
  }
  const pageProps = data.props?.pageProps;
  if (pageProps?.status === 404) return undefined;
  return (pageProps?.state?.data?.entity as EmbedEntity | undefined) ?? {};
}

/** Reads the song details out of Spotify's embed page. */
export function parseEmbedPage(html: string, id: string): SpotifyTrack {
  const entity = readEmbedEntity(html, "song");
  if (!entity) {
    throw new SpotifyError(404, "Spotify doesn't have that song — check the link.");
  }
  if (entity.type !== "track" || typeof entity.name !== "string" || !entity.name.trim()) {
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

/**
 * Fetches one of Spotify's embed pages. `path` is built only from a validated
 * kind and id, so this can't be made to fetch anything else.
 */
async function fetchEmbedPage(path: string, notFound: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`https://open.spotify.com/embed/${path}`, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
    throw new SpotifyError(502, `Couldn't reach Spotify (${reason}).`);
  }
  if (res.status === 404) throw new SpotifyError(404, notFound);
  if (!res.ok) throw new SpotifyError(502, `Spotify answered with an error (HTTP ${res.status}).`);
  return res.text();
}

/** Looks a song up on Spotify's public embed page. */
export async function fetchSpotifyTrack(id: string): Promise<SpotifyTrack> {
  if (!SPOTIFY_ID_RE.test(id)) throw new SpotifyError(400, "That isn't a valid Spotify song link.");
  const html = await fetchEmbedPage(
    `track/${id}`,
    "Spotify doesn't have that song — check the link.",
  );
  return parseEmbedPage(html, id);
}

const notFoundMessage = (kind: "playlist" | "album") =>
  kind === "playlist"
    ? "Spotify doesn't share that playlist — it may be private (make it public in Spotify), or the link may be wrong."
    : "Spotify doesn't have that album — check the link.";

/** The cover image closest to `width` pixels wide (Spotify offers 64, 300 and 640). */
function coverOfWidth(images: unknown, width: number): string | null {
  const urls = (Array.isArray(images) ? images : [])
    .filter((img: { url?: unknown }) => typeof img?.url === "string")
    .sort(
      (a: { maxWidth?: number }, b: { maxWidth?: number }) => (a.maxWidth ?? 0) - (b.maxWidth ?? 0),
    );
  const best =
    urls.find((img: { maxWidth?: number }) => (img.maxWidth ?? 0) >= width) ?? urls.at(-1);
  return (best?.url as string | undefined) ?? null;
}

/** Reads a playlist's or album's songs out of Spotify's embed page. */
export function parsePlaylistPage(
  html: string,
  kind: "playlist" | "album",
  id: string,
): SpotifyPlaylist {
  const entity = readEmbedEntity(html, kind);
  if (!entity) throw new SpotifyError(404, notFoundMessage(kind));
  if (entity.type !== kind || typeof entity.name !== "string" || !entity.name.trim()) {
    throw new SpotifyError(502, `Couldn't read the ${kind} from Spotify (its page has changed).`);
  }

  const items = (Array.isArray(entity.trackList) ? entity.trackList : []) as EmbedTrackItem[];
  // Songs only: playlists can also hold podcast episodes and local files,
  // which have no song to find on YouTube.
  const tracks = items.flatMap((item): SpotifyPlaylistTrack[] => {
    const trackId =
      typeof item?.uri === "string" ? /^spotify:track:([A-Za-z0-9]{22})$/.exec(item.uri)?.[1] : "";
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    if (!trackId || !title) return [];
    return [
      {
        id: trackId,
        url: `https://open.spotify.com/track/${trackId}`,
        title,
        artists: typeof item.subtitle === "string" ? item.subtitle.trim() : "",
        duration:
          typeof item.duration === "number" && item.duration > 0
            ? Math.round(item.duration / 1000)
            : null,
        explicit: item.isExplicit === true,
      },
    ];
  });

  const by = typeof entity.subtitle === "string" ? entity.subtitle.trim() : "";
  return {
    kind,
    id,
    url: `https://open.spotify.com/${kind}/${id}`,
    name: entity.name.trim(),
    by: by || null,
    image: coverOfWidth(entity.visualIdentity?.image, 300),
    tracks,
    maybeMore: kind === "playlist" && items.length >= PLAYLIST_EMBED_LIMIT,
  };
}

/** The songs in a public playlist or album, from Spotify's public embed page. */
export async function fetchSpotifyPlaylist(
  kind: "playlist" | "album",
  id: string,
): Promise<SpotifyPlaylist> {
  if ((kind !== "playlist" && kind !== "album") || !SPOTIFY_ID_RE.test(id)) {
    throw new SpotifyError(400, "That isn't a valid Spotify playlist link.");
  }
  const html = await fetchEmbedPage(`${kind}/${id}`, notFoundMessage(kind));
  return parsePlaylistPage(html, kind, id);
}

/**
 * What to search YouTube for: the main artist, the cleaned-up title, and
 * "audio" — which brings the artist's "Official Audio" uploads (the plain
 * studio recording, no video intro) up in YouTube's results.
 */
export function spotifySearchQuery(track: Pick<SpotifyTrack, "title" | "artists">): string {
  return [track.artists[0], cleanTrackTitle(track.title), "audio"].filter(Boolean).join(" ");
}

/** How long a download waits for Spotify's song details before tagging the file without them. */
const SONG_TAGS_TIMEOUT_MS = 5_000;

/**
 * Tags for a download of a Spotify song: Spotify's title and artists (cleaner
 * than a YouTube video's "Artist - Song (Official Video)"), or undefined if
 * Spotify doesn't answer in time — the file is then tagged from YouTube, as
 * any other download.
 */
export async function spotifySongTags(
  id: string,
): Promise<{ title: string; artist: string } | undefined> {
  const tags = fetchSpotifyTrack(id).then(
    (track) => ({ title: cleanTrackTitle(track.title), artist: track.artists.join(", ") }),
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), SONG_TAGS_TIMEOUT_MS);
  });
  return Promise.race([tags, timeout]).finally(() => clearTimeout(timer));
}
