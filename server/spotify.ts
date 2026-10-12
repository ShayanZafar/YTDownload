/**
 * Spotify links. Spotify doesn't let anyone download its audio, but its
 * public embed player (the one other websites show — no account or API key
 * needed) tells us a song's name, artists and exact length. That's enough to
 * find the same recording on YouTube: search for "artist title", then prefer
 * uploads with the same length (see `targetDuration` in search.ts).
 *
 * The embed player for a playlist or album lists its songs the same way, which
 * is what the playlist panel shows. It lists only the first 100 of a playlist;
 * for the rest, `fetchMorePlaylistSongs()` asks Spotify's Web API for its pages
 * with the anonymous pass the embed page itself carries (the owner agreed to
 * this unofficial route). Spotify answers that only for playlists people made — its
 * own (editorial, mixes) stay at 100 — and anything that fails keeps the 100.
 * A refusal (HTTP 429) is Spotify's quota for this computer, so it's
 * remembered until its Retry-After (`webApiRefusal`): playlists then open with
 * their first 100 songs, and the answer says when to ask again (`more`).
 */
import {
  SPOTIFY_PLAYLIST_MAX_SONGS,
  type AudioSource,
  type PlaylistMore,
  type SpotifyPlaylist,
  type SpotifyPlaylistTrack,
  type SpotifyTrack,
} from "@shared/schema";
import { cleanTrackTitle } from "@shared/spotify-names";
import { mapAtOnce } from "./cpu-cores";
import { sourceHealth } from "./source-health";
import { TtlCache } from "./youtube-limits";

export { cleanTrackTitle };

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
/** The most songs Spotify's embed page lists for a playlist. */
export const PLAYLIST_EMBED_LIMIT = 100;
/** The most songs the app lists of a playlist (paging past the embed page's 100). */
export const PLAYLIST_MAX_SONGS = SPOTIFY_PLAYLIST_MAX_SONGS;
/** Songs per Web API page (Spotify's maximum). */
const PLAYLIST_PAGE_SIZE = 100;
/** When the rest of a playlist failed with no Retry-After to go by, the page asks again this much later. */
export const RETRY_FAILED_AFTER_MS = 60_000;
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
    /** For no answer at all, why: "no connection", "it took too long". */
    readonly unreachable?: string,
  ) {
    super(message);
  }
}

/** The latest time a Date can hold (ms since the epoch). */
const LATEST_DATE_MS = 8.64e15;

/**
 * When to ask again, from a 429's Retry-After — a number of seconds or an
 * HTTP date — or undefined when it gives nothing to wait for, can't be read,
 * or is later than any date can be.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  const text = value?.trim() ?? "";
  const at = /^\d+$/.test(text)
    ? now + Number(text) * 1000
    : /[a-z]/i.test(text)
      ? Date.parse(text)
      : NaN;
  return at > now && at <= LATEST_DATE_MS ? at : undefined;
}

/**
 * Until when Spotify's Web API refuses this computer (ms since the epoch, 0
 * when it doesn't): one for every playlist and pass, as Spotify's quota is.
 * While it holds, playlists open with their first 100 songs without asking.
 */
export const webApiRefusal = {
  until: 0,
  clear() {
    this.until = 0;
  },
};

export type SpotifyLink =
  | { kind: "track"; id: string }
  /** Things with a list of songs. */
  | { kind: "playlist"; id: string }
  | { kind: "album"; id: string }
  /** A spotify.link short link: `resolveShortLink()` finds where it leads. */
  | { kind: "short"; host: ShortLinkHost; code: string }
  /** An artist, podcast… — or a link we can't read. */
  | { kind: "other"; type: string };

/**
 * Recognises Spotify links: open.spotify.com/track/… (or /playlist/…,
 * /album/…), the same with /intl-xx/ or /embed/ in front, "spotify:track:…"
 * URIs, and spotify.link short links (the Spotify app's Share button on a
 * phone; `resolveShortLink()` opens them). Anything else, including plain
 * search text that mentions Spotify, gives undefined.
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
  if (isShortLinkHost(host)) {
    const code = url.pathname.slice(1).replace(/\/$/, "");
    return SHORT_CODE_RE.test(code)
      ? { kind: "short", host, code }
      : { kind: "other", type: "short link" };
  }
  // Other apps' short links use the same service (Branch): not Spotify's.
  if (host.endsWith(".app.link")) return { kind: "other", type: "short link" };
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
  "That short link can't be read. Open it, then copy its open.spotify.com link instead.";

/** "a Spotify artist", "a Spotify podcast"… for a link of this type. */
const aSpotify = (type: string) =>
  ["album", "playlist", "artist", "episode", "show"].includes(type)
    ? `a Spotify ${type === "show" ? "podcast" : type}`
    : "a Spotify page";

/** What to tell the user when a Spotify link searched for isn't a song we can look up. */
export function spotifyLinkError(
  link: Exclude<SpotifyLink, { kind: "track" } | { kind: "short" }>,
): string {
  if (link.kind === "playlist" || link.kind === "album") {
    return `That's a Spotify ${link.kind}, not a song — choose “Spotify playlist” above the search box to pick one of its songs.`;
  }
  if (link.type === "short link") return SHORT_LINK_ERROR;
  return `That's ${aSpotify(link.type)} — only song links work. In Spotify, use Share → Copy Song Link on a song.`;
}

/** What to tell the user when a Spotify link leads to something the app can't use. */
export function unusableLinkError(link: Extract<SpotifyLink, { kind: "other" }>): string {
  if (link.type === "short link") return SHORT_LINK_ERROR;
  return `That's ${aSpotify(link.type)} — paste a song, playlist or album link instead.`;
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

/** The hosts of Spotify's short links: spotify.link, and the Branch host it redirects through. */
export type ShortLinkHost = "spotify.link" | "spotify.app.link";
const isShortLinkHost = (host: string): host is ShortLinkHost =>
  host === "spotify.link" || host === "spotify.app.link";
// A short link's code ("spotify.link/AbCd1234XyZ"): letters, digits, - and _.
const SHORT_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** How many short-link hops to follow before giving up (one is usual). */
const MAX_SHORT_LINK_HOPS = 3;
// Branch (the service behind spotify.link) redirects tools straight to the
// open.spotify.com address; browsers get a page that does it with a script.
const SHORT_LINK_USER_AGENT = "curl/8.5.0";
const OPEN_SPOTIFY_LINK_RE =
  /https:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:track|album|playlist)\/[A-Za-z0-9]{22}/i;

/**
 * Where a spotify.link short link leads: a song, playlist or album link (or
 * some other Spotify page). Only Spotify's own short-link hosts are fetched,
 * at an address rebuilt from the validated code, and a redirect is followed
 * only to another of those hosts — so a link can't make the app fetch any
 * other address.
 */
export async function resolveShortLink(
  link: Extract<SpotifyLink, { kind: "short" }>,
): Promise<Exclude<SpotifyLink, { kind: "short" }>> {
  let next: Extract<SpotifyLink, { kind: "short" }> = link;
  for (let hop = 0; hop < MAX_SHORT_LINK_HOPS; hop++) {
    let res: Response;
    try {
      res = await fetch(`https://${next.host}/${next.code}`, {
        redirect: "manual",
        headers: { "User-Agent": SHORT_LINK_USER_AGENT, "Accept-Language": "en" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
      throw new SpotifyError(502, `Couldn't reach Spotify (${reason}).`);
    }
    if (res.status === 404) {
      throw new SpotifyError(
        404,
        "That Spotify short link doesn't lead anywhere — check the link.",
      );
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    const target = location
      ? parseSpotifyLink(location)
      : res.ok
        ? parseSpotifyLink(OPEN_SPOTIFY_LINK_RE.exec(await res.text())?.[0] ?? "")
        : undefined;
    if (target?.kind === "short") {
      next = target;
      continue;
    }
    if (target) return target;
    throw new SpotifyError(
      502,
      res.ok || location
        ? "Couldn't tell where that Spotify short link leads. Open it, then copy its open.spotify.com link instead."
        : `Spotify answered with an error (HTTP ${res.status}).`,
    );
  }
  throw new SpotifyError(502, "That Spotify short link redirects too many times.");
}

/** A Spotify link, with a short link replaced by where it leads. */
export async function readSpotifyLink(
  input: string,
): Promise<Exclude<SpotifyLink, { kind: "short" }> | undefined> {
  const link = parseSpotifyLink(input);
  return link?.kind === "short" ? resolveShortLink(link) : link;
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
  const pageProps = readPageProps(html);
  if (!pageProps) {
    throw new SpotifyError(502, `Couldn't read the ${what} from Spotify (its page has changed).`);
  }
  if (pageProps.status === 404) return undefined;
  return (pageProps.state?.data?.entity as EmbedEntity | undefined) ?? {};
}

type EmbedPageProps = {
  status?: unknown;
  state?: {
    data?: { entity?: unknown };
    settings?: { session?: { accessToken?: unknown; isAnonymous?: unknown } };
  };
};

function readPageProps(html: string): EmbedPageProps | undefined {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  try {
    const data = JSON.parse(match?.[1] ?? "") as { props?: { pageProps?: EmbedPageProps } };
    return data.props?.pageProps;
  } catch {
    return undefined;
  }
}

/**
 * The anonymous pass Spotify's embed player carries (no account behind it), or
 * undefined. It's only ever sent to api.spotify.com, never to the browser.
 */
export function readEmbedAccessToken(html: string): string | undefined {
  const session = readPageProps(html)?.state?.settings?.session;
  const token = session?.accessToken;
  return typeof token === "string" && /^[\w-]{20,1000}$/.test(token) ? token : undefined;
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
 * A request to Spotify, recorded for the source-health report. Never retried
 * and never delayed: a 429 (or any other refusal) is returned at once, and the
 * caller moves on to its fallback. Throws for no answer at all (no
 * connection, or too slow); an answer of any status is returned.
 */
async function fetchSpotify(
  source: "spotify" | "spotify-oembed" | "spotify-web-api",
  url: string,
  init: RequestInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "TimeoutError" ? "it took too long" : "no connection";
    sourceHealth.record(source, false, { note: `Couldn't reach Spotify (${reason})` });
    throw new SpotifyError(502, `Couldn't reach Spotify (${reason}).`, reason);
  }
  // A 404 is Spotify answering (there's no such song): the source is fine.
  if (res.ok || res.status === 404) {
    sourceHealth.record(source, true);
    return res;
  }
  sourceHealth.record(source, false, {
    kind: res.status === 429 ? "throttled" : res.status === 403 ? "blocked" : "error",
    note: `HTTP ${res.status}`,
    until:
      res.status === 429 ? parseRetryAfter(res.headers.get("retry-after"), Date.now()) : undefined,
  });
  return res;
}

/**
 * Fetches one of Spotify's embed pages. `path` is built only from a validated
 * kind and id, so this can't be made to fetch anything else.
 */
async function fetchEmbedPage(path: string, notFound: string): Promise<string> {
  const res = await fetchSpotify("spotify", `https://open.spotify.com/embed/${path}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
  });
  if (res.status === 404) throw new SpotifyError(404, notFound);
  if (!res.ok) throw new SpotifyError(502, `Spotify answered with an error (HTTP ${res.status}).`);
  return res.text();
}

/** What Spotify's oEmbed endpoint says about a song: just its title and cover. */
export function parseOembed(json: unknown, id: string): SpotifyTrack {
  const data = (json ?? {}) as { title?: unknown; thumbnail_url?: unknown };
  const title = typeof data.title === "string" ? data.title.trim() : "";
  if (!title)
    throw new SpotifyError(502, "Couldn't read the song from Spotify (its page has changed).");
  return {
    id,
    url: `https://open.spotify.com/track/${id}`,
    title,
    artists: [],
    duration: null,
    thumbnail: typeof data.thumbnail_url === "string" ? data.thumbnail_url : null,
    source: "spotify-oembed",
  };
}

/**
 * The fallback for a song when its embed page can't be read: Spotify's
 * oEmbed endpoint (public, no key) knows the song's title and cover — not its
 * artists or length, so the YouTube search goes by the title alone and
 * "Download all" marks the song to check rather than guessing.
 */
export async function fetchOembedTrack(id: string): Promise<SpotifyTrack> {
  if (!SPOTIFY_ID_RE.test(id)) throw new SpotifyError(400, "That isn't a valid Spotify song link.");
  const params = new URLSearchParams({ url: `https://open.spotify.com/track/${id}` });
  const res = await fetchSpotify("spotify-oembed", `https://open.spotify.com/oembed?${params}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (res.status === 404) {
    throw new SpotifyError(404, "Spotify doesn't have that song — check the link.");
  }
  if (!res.ok) throw new SpotifyError(502, `Spotify answered with an error (HTTP ${res.status}).`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SpotifyError(502, "Couldn't read the song from Spotify (its page has changed).");
  }
  return parseOembed(json, id);
}

/**
 * Songs' details from the embed page, kept for a while: they don't change, and
 * "Download all" asks about each song more than once (its search, then its
 * file's tags). The oEmbed fallback's partial answers aren't kept.
 */
export const spotifyTrackCache = new TtlCache<SpotifyTrack>();

/**
 * Looks a song up on Spotify's public embed page — and if that can't be read
 * for any reason but "no such song" (a 429, a 5xx, a timeout, a page it can't
 * parse), on its oEmbed endpoint instead, at once (`fetchOembedTrack()`; the
 * song then carries `source: "spotify-oembed"`).
 */
export async function fetchSpotifyTrack(id: string): Promise<SpotifyTrack> {
  if (!SPOTIFY_ID_RE.test(id)) throw new SpotifyError(400, "That isn't a valid Spotify song link.");
  const cached = spotifyTrackCache.get(id, Date.now());
  if (cached) return cached;
  try {
    const html = await fetchEmbedPage(
      `track/${id}`,
      "Spotify doesn't have that song — check the link.",
    );
    const track = parseEmbedPage(html, id);
    spotifyTrackCache.set(id, track, Date.now());
    return track;
  } catch (err) {
    if (err instanceof SpotifyError && err.status === 404) throw err;
    try {
      return await fetchOembedTrack(id);
    } catch {
      throw err; // the embed page's problem is the one worth reporting
    }
  }
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
    source: "spotify",
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

type ApiPlaylistPage = { total?: unknown; items?: unknown };
type ApiPlaylistItem = {
  is_local?: unknown;
  track?: {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    duration_ms?: unknown;
    explicit?: unknown;
    artists?: unknown;
  } | null;
};

/**
 * Reads one page of a playlist from Spotify's Web API: its songs (in the
 * playlist panel's shape), how many entries the page had (songs or not, for
 * the next page's offset), and how many the playlist has in all.
 */
export function parsePlaylistItemsPage(json: unknown): {
  tracks: SpotifyPlaylistTrack[];
  count: number;
  total: number;
} {
  const page = (json ?? {}) as ApiPlaylistPage;
  const items = (Array.isArray(page.items) ? page.items : []) as ApiPlaylistItem[];
  const tracks = items.flatMap((entry): SpotifyPlaylistTrack[] => {
    const track = entry?.track;
    // Songs only, as on the embed page: no episodes, local files or removed songs.
    if (!track || entry.is_local === true || track.type !== "track") return [];
    const id = typeof track.id === "string" && SPOTIFY_ID_RE.test(track.id) ? track.id : "";
    const title = typeof track.name === "string" ? track.name.trim() : "";
    if (!id || !title) return [];
    const artists = (Array.isArray(track.artists) ? track.artists : [])
      .map((artist: { name?: unknown }) =>
        typeof artist?.name === "string" ? artist.name.trim() : "",
      )
      .filter(Boolean)
      .join(", ");
    return [
      {
        id,
        url: `https://open.spotify.com/track/${id}`,
        title,
        artists,
        duration:
          typeof track.duration_ms === "number" && track.duration_ms > 0
            ? Math.round(track.duration_ms / 1000)
            : null,
        explicit: track.explicit === true,
      },
    ];
  });
  return {
    tracks,
    count: items.length,
    total: typeof page.total === "number" && page.total >= 0 ? page.total : 0,
  };
}

/** Why the app stopped short of a playlist's end: the answer's `more`, with `retryAt` in ms. */
type MoreStop = { reason: PlaylistMore["reason"]; retryAt?: number; note?: string };

const failedStop = (note: string): MoreStop => ({
  reason: "failed",
  note,
  retryAt: Date.now() + RETRY_FAILED_AFTER_MS,
});

/**
 * One page of a playlist's songs from the Web API, from `offset` on — or why
 * Spotify didn't give it. A refusal is remembered (`webApiRefusal`).
 */
async function fetchPlaylistItemsPage(
  id: string,
  token: string,
  offset: number,
): Promise<{ page: ReturnType<typeof parsePlaylistItemsPage> } | { stop: MoreStop }> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(Math.min(PLAYLIST_PAGE_SIZE, PLAYLIST_MAX_SONGS - offset)),
    fields: "total,items(is_local,track(type,id,name,duration_ms,explicit,artists(name)))",
  });
  let res: Response;
  try {
    res = await fetchSpotify(
      "spotify-web-api",
      `https://api.spotify.com/v1/playlists/${id}/tracks?${params}`,
      { headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT } },
    );
  } catch (err) {
    return {
      stop: failedStop((err instanceof SpotifyError && err.unreachable) || "no connection"),
    };
  }
  if (res.status === 404) return { stop: { reason: "spotify-own" } };
  if (res.status === 429) {
    const retryAt = parseRetryAfter(res.headers.get("retry-after"), Date.now());
    if (retryAt) {
      webApiRefusal.until = Math.max(webApiRefusal.until, retryAt);
      return { stop: { reason: "refused", retryAt } };
    }
  }
  if (!res.ok) return { stop: failedStop(`HTTP ${res.status}`) };
  try {
    return { page: parsePlaylistItemsPage(await res.json()) };
  } catch {
    return { stop: failedStop("an answer it couldn't read") };
  }
}

/**
 * The songs of a playlist after the embed page's first 100, from Spotify's Web
 * API with the embed page's anonymous pass — up to `PLAYLIST_MAX_SONGS` in
 * all. The first page says how many there are; the rest are then asked for
 * together, a page per CPU core at a time (Spotify publishes no limit to keep
 * to). `stop` says why it didn't get them all: Spotify refused (and when to
 * ask again), a page failed, Spotify won't share its own playlists (404), or
 * the list was cut at the limit; a failed page keeps what came before it.
 * While a refusal holds, it asks nothing.
 */
export async function fetchMorePlaylistSongs(
  id: string,
  token: string,
): Promise<{ tracks: SpotifyPlaylistTrack[]; stop?: MoreStop }> {
  if (webApiRefusal.until > Date.now()) {
    return { tracks: [], stop: { reason: "refused", retryAt: webApiRefusal.until } };
  }
  const first = await fetchPlaylistItemsPage(id, token, PLAYLIST_EMBED_LIMIT);
  if ("stop" in first) return { tracks: [], stop: first.stop };
  const tracks = [...first.page.tracks];
  let offset = PLAYLIST_EMBED_LIMIT + first.page.count;
  if (first.page.count === 0 || offset >= first.page.total) return { tracks };

  const offsets: number[] = [];
  const end = Math.min(first.page.total, PLAYLIST_MAX_SONGS);
  for (let at = offset; at < end; at += PLAYLIST_PAGE_SIZE) offsets.push(at);
  const answers = await mapAtOnce(offsets, (at) => fetchPlaylistItemsPage(id, token, at));
  // A refusal on any page outweighs a failure before it: it says when to ask again.
  const refusal = answers
    .map((answer) => ("stop" in answer ? answer.stop : undefined))
    .find((stop) => stop?.reason === "refused");
  for (const answer of answers) {
    if ("stop" in answer) return { tracks, stop: refusal ?? answer.stop };
    const { page } = answer;
    tracks.push(...page.tracks);
    offset += page.count;
    if (page.count === 0 || offset >= page.total) return { tracks };
    // A short page before the end would leave a gap before the next: stop there.
    if (page.count < PLAYLIST_PAGE_SIZE) {
      return { tracks, stop: refusal ?? failedStop("a page came back short") };
    }
  }
  return { tracks, stop: { reason: "limit" } }; // cut at PLAYLIST_MAX_SONGS
}

/**
 * The songs in a public playlist or album: Spotify's public embed page, and
 * for a playlist of more than 100 songs, the rest from its Web API — or, if
 * the app didn't get them all, why (`more`).
 */
export async function fetchSpotifyPlaylist(
  kind: "playlist" | "album",
  id: string,
): Promise<SpotifyPlaylist> {
  if ((kind !== "playlist" && kind !== "album") || !SPOTIFY_ID_RE.test(id)) {
    throw new SpotifyError(400, "That isn't a valid Spotify playlist link.");
  }
  const html = await fetchEmbedPage(`${kind}/${id}`, notFoundMessage(kind));
  const playlist = parsePlaylistPage(html, kind, id);
  const token = playlist.maybeMore ? readEmbedAccessToken(html) : undefined;
  if (!token) return playlist;
  const { tracks, stop } = await fetchMorePlaylistSongs(id, token);
  return {
    ...playlist,
    tracks: [...playlist.tracks, ...tracks],
    maybeMore: stop !== undefined,
    ...(stop && {
      more: {
        reason: stop.reason,
        ...(stop.note && { note: stop.note }),
        ...(stop.retryAt && { retryAt: new Date(stop.retryAt).toISOString() }),
      },
    }),
  };
}

/**
 * What to search for: the main artist, the cleaned-up title, and — on YouTube
 * — "audio", which brings the artist's "Official Audio" uploads (the plain
 * studio recording, no video intro) up in its results. SoundCloud's tracks are
 * audio anyway, and the extra word would only narrow its search.
 */
export function spotifySearchQuery(
  track: Pick<SpotifyTrack, "title" | "artists">,
  source: AudioSource = "youtube",
): string {
  return [track.artists[0], cleanTrackTitle(track.title), source === "youtube" && "audio"]
    .filter(Boolean)
    .join(" ");
}

/** How long a download waits for Spotify's song details before tagging the file without them. */
const SONG_TAGS_TIMEOUT_MS = 5_000;

/** What a song's own Spotify page says about its album (all of it optional). */
export type SpotifyAlbumDetails = {
  album?: string;
  /** The song's number on the album. */
  track?: number;
  /** "1987-11-12" (or just a year). */
  date?: string;
  /** The album cover, 640×640. */
  coverUrl?: string;
};

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

/** Text from an HTML attribute, with its character references turned back into characters. */
export function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] !== "#") return HTML_ENTITIES[ref.toLowerCase()] ?? whole;
    const code =
      ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * Reads the album details out of a song's Spotify page (open.spotify.com/track/…),
 * from the tags it carries for link previews: "music:album:track",
 * "music:release_date", the cover ("og:image") and the description, which
 * reads "Artist · Album · Song · 1987".
 */
export function parseTrackPage(html: string): SpotifyAlbumDetails {
  const meta = new Map<string, string>();
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const key = /\b(?:property|name)="([^"]+)"/i.exec(tag)?.[1];
    const content = /\bcontent="([^"]*)"/i.exec(tag)?.[1];
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decodeHtml(content).trim());
  }
  const details: SpotifyAlbumDetails = {};

  const parts = (meta.get("og:description") ?? "").split(" · ");
  // The album is what's between the artists and "Song · year".
  if (parts.length >= 4 && parts.at(-2) === "Song") {
    const album = parts.slice(1, -2).join(" · ").trim();
    if (album) details.album = album;
  }
  const track = Number(meta.get("music:album:track"));
  if (Number.isInteger(track) && track > 0 && track < 1000) details.track = track;
  const date = meta.get("music:release_date") ?? "";
  if (/^\d{4}(?:-\d{2}-\d{2})?$/.test(date)) details.date = date;
  const cover = meta.get("og:image") ?? "";
  if (/^https:\/\/i\.scdn\.co\/image\/[a-f0-9]+$/.test(cover)) details.coverUrl = cover;
  return details;
}

/**
 * A song's album details from its Spotify page. Spotify sends that page's
 * details only to tools that fetch it like a link preview does (a browser
 * gets a page that fills itself in with scripts), hence the curl User-Agent,
 * as for short links. The id is validated, so nothing else can be fetched.
 */
export async function fetchSpotifyAlbumDetails(id: string): Promise<SpotifyAlbumDetails> {
  if (!SPOTIFY_ID_RE.test(id)) return {};
  try {
    const res = await fetch(`https://open.spotify.com/track/${id}`, {
      headers: { "User-Agent": SHORT_LINK_USER_AGENT, "Accept-Language": "en" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return res.ok ? parseTrackPage(await res.text()) : {};
  } catch {
    return {};
  }
}

/** What a download of a Spotify song is tagged with. */
export type SpotifySongTags = { title: string; artist?: string } & SpotifyAlbumDetails;

/**
 * Tags for a download of a Spotify song: Spotify's title and artists (cleaner
 * than a YouTube video's "Artist - Song (Official Video)"), and, from the
 * song's own page, its album, track number, release date and cover. Undefined
 * if Spotify doesn't answer in time — the file is then tagged from YouTube,
 * as any other download.
 */
export async function spotifySongTags(id: string): Promise<SpotifySongTags | undefined> {
  const tags = Promise.all([fetchSpotifyTrack(id), fetchSpotifyAlbumDetails(id)]).then(
    ([track, album]): SpotifySongTags => ({
      title: cleanTrackTitle(track.title),
      // The oEmbed fallback knows no artists: the file keeps YouTube's then.
      ...(track.artists.length > 0 ? { artist: track.artists.join(", ") } : {}),
      ...album,
      coverUrl: album.coverUrl ?? track.thumbnail ?? undefined,
    }),
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), SONG_TAGS_TIMEOUT_MS);
  });
  return Promise.race([tags, timeout]).finally(() => clearTimeout(timer));
}
