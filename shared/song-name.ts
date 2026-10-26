/**
 * A song's artist and title as a music player shows them — "Linkin Park",
 * "Numb" — worked out from what a video says (its title and its channel), or
 * from a folder song's own tags. Downloads are named and tagged with it
 * (songOfVideo(), fileNameOf()); Sanitize Filename tidies a folder's titles
 * and artists with it (tidiedSong()). Shared by the server and the page, so
 * the name the page shows is the name the server saves.
 */

import { safeFileName } from "./filename";
import { foldCase, foldSquashed, foldWords } from "./fold-text";
import {
  artistFirst,
  artistKey,
  decodeEntities,
  fromAllCaps,
  sanitizedFileName,
  withoutNameNoise,
  type KnownArtists,
} from "./name-noise";

/** A song's artist (null when nothing says who) and title. */
export type SongName = { artist: string | null; title: string };

// "Artist - Song", "Artist- Song", "Artist – Song": a dash with a space on at least one side.
const DASH_RE = /\s*[-–—]+\s+|\s+[-–—]+\s*/;
const TOPIC_RE = /\s+-\s+topic$/i;
const FEAT = String.raw`\b(?:featuring|feat|ft)\b\.?`;
// "Eminem ft. Rihanna", "2Pac (feat. Dr. Dre)": an artist with who's featured.
const ARTIST_FEAT_RE = new RegExp(
  String.raw`^(.*?\S)\s*[([]?\s*${FEAT}\s*([^)\]]+?)\s*[)\]]?$`,
  "i",
);
// Words that join two artists' names: "Eminem ft. Rihanna", "Ace Ventura & Astrix".
const JOINER_RE = new RegExp(String.raw`${FEAT}|&|\+|,|\b(?:x|and|with|vs)\b`, "i");
// `Eminem "Lose Yourself"`: the song in quotes after its artist.
const QUOTED_RE = /^(.+?)\s+["“'‘](.+?)["”'’](.*)$/;
// "05 - Miasma", "01. Numb": a track number in front.
const TRACK_NUMBER_RE = /^\d{1,2}\s*[-.]\s+(?=\D)/;
// What can follow a song's name when it isn't its artist: "Wish You Were Here
// - 2011 Remaster", "Levels - Original Version", "Song - Live at Wembley",
// "Runaway - (Hybrid Theory)".
const VERSION_WORDS =
  /^(?:(?:remaster(?:ed)?|original|version|mix|remix|edit|radio|extended|club|dub|live|acoustic|unplugged|instrumental|demo|studio|single|album|mono|stereo|explicit|clean|vocal|bonus|full|short|long|uncut|reprise|(?:19|20)\d{2})\s*)+$/i;
const VERSION_IN_BRACKETS_RE =
  /[([][^)\]]*\b(?:remix|mix|edit|version|live|dub|remaster(?:ed)?|acoustic|instrumental|demo)\b[^)\]]*[)\]]/i;
const isVersionNote = (text: string) =>
  VERSION_WORDS.test(text) || /^live (?:at|in|from)\b/i.test(text) || /^[([].*[)\]]$/.test(text);

/** A name to compare, loosely: no case, accents, "The" or anything but letters and digits. */
const loose = (name: string) => foldSquashed(foldCase(name, "all").replace(/^the\s+/, ""), "all");
/** Its words, to look for one name inside another: " ace ventura astrix ". */
const words = (name: string) => ` ${foldWords(name, "all")} `;
const sameArtist = (a: string, b: string) => !!loose(a) && loose(a) === loose(b);
/** Its spaces and punctuation: "Dr. Dre" has more than "Dr Dre", "Jay-Z" more than "JayZ". */
const separators = (name: string) => name.replace(/[\p{L}\p{N}]/gu, "").length;

/**
 * An artist's name as `named` spells it ("Dr Dre" → "Dr. Dre"), when the two
 * are the same artist and `named` is spelt as fully: not in capitals, nor run
 * together like a channel's handle ("Jay-Z" stays, not "JayZ").
 */
const speltAs = (part: string, named: string) =>
  sameArtist(part, named) && /\p{Ll}/u.test(named) && separators(named) >= separators(part)
    ? named
    : part;

// What carries an artist's name on, not a song's: "Queen of the Night", "Eminem ft. Rihanna".
const NAME_GOES_ON_RE = new RegExp(
  String.raw`^(?:${FEAT}|[&+,]|'s\b|(?:of|the|in|on|at|to|for|or|is|and|x|with|vs)\b)`,
  "i",
);

/**
 * A title that starts with its artist's name: the name as the title spells it,
 * and the song after it — "Michael Jackson Beat It" and "Static - X - Dead
 * Souls" by Static-X are "Beat It" and "Dead Souls". Null when the title
 * doesn't start with the artist ("Queen of the Night" isn't Queen's).
 */
function artistInFront(title: string, artist: string): { artist: string; title: string } | null {
  for (let at = 1; at < title.length; at++) {
    if (!/[\s\-–—]/.test(title[at]) || /[\s\-–—&+,]/.test(title[at - 1])) continue;
    const front = title.slice(0, at);
    if (!sameArtist(front, artist)) continue;
    const dashed = /^\s*[-–—]+\s*(.+)$/.exec(title.slice(at));
    const song = dashed?.[1].trim() ?? title.slice(at).trim();
    // ("Static - X" as one name: "Static-X".)
    const name = front.replace(/\s*([-–—])\s*/g, "$1");
    if (song && (dashed || !NAME_GOES_ON_RE.test(song))) return { artist: name, title: song };
  }
  return null;
}

/**
 * Does this part of a title name the artist? "Linkin Park" does, so do
 * "LinkinPark", "Eminem ft. Rihanna" (Eminem) and "Ace Ventura & Astrix"
 * (Astrix) — but "Alter Bridge III" doesn't name Alter Bridge (that's its
 * album), nor "Yesterday" Yes.
 */
export function namesArtist(part: string, artist: string): boolean {
  if (!loose(artist)) return false;
  return sameArtist(part, artist) || (words(part).includes(words(artist)) && JOINER_RE.test(part));
}

/**
 * The artist a channel is named after: "Linkin Park - Topic" (YouTube Music's
 * own uploads) is Linkin Park, "TaylorSwiftVEVO" Taylor Swift, "Queen
 * Official" Queen. Any other channel's name as it is (without what videos
 * add: "HD Pink Floyd" is Pink Floyd).
 */
export function artistOfChannel(channel: string): string {
  const name = withoutNameNoise(decodeEntities(channel).replace(/\s+/g, " ").trim());
  let artist = name
    .replace(TOPIC_RE, "")
    .replace(/\s*\(?official(?: (?:channel|youtube channel|artist channel|music))?\)?$/i, "");
  // "TaylorSwiftVEVO", "EminemMusic": a handle run together, split where its words begin.
  const handle = /^(\S*\p{Ll})(?:VEVO|Music|Official)$/u.exec(artist);
  if (handle) artist = handle[1].replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
  else artist = artist.replace(/\s*VEVO$/, "");
  return artist.trim() || name;
}

/** "Song ft. X", "Song (ft X)", "Song [Featuring X]" → "Song (feat. X)". */
export function featuredInTitle(title: string): string {
  return title
    .replace(
      new RegExp(String.raw`\(\s*${FEAT}\s*([^)]+?)\s*\)|\[\s*${FEAT}\s*([^\]]+?)\s*\]`, "gi"),
      (_, round?: string, square?: string) => `(feat. ${round ?? square})`,
    )
    .replace(
      new RegExp(String.raw`\s+${FEAT}\s+([^()[\]]+?)(?=\s*[([]|$)`, "i"),
      (_, who: string) => ` (feat. ${who})`,
    );
}

/** A title or artist in capitals in title case, part by part ("NUMB - LIVE" → "Numb - Live"). */
const fromCapitals = (text: string) => text.split(" - ").map(fromAllCaps).join(" - ");

/**
 * The song tidied: who's featured moved from the artist into the title
 * ("Eminem ft. Rihanna" / "Love The Way You Lie" → "Eminem" / "Love The Way
 * You Lie (feat. Rihanna)"), "ft." as "(feat. …)", quotes round the title
 * taken off, and names in capitals in title case.
 */
function tidy({ artist, title }: SongName): SongName {
  let who = artist?.replace(/\s+/g, " ").trim() || null;
  let featuring: string | undefined;
  const feat = who ? ARTIST_FEAT_RE.exec(who) : null;
  if (feat) {
    who = feat[1].trim();
    featuring = feat[2].trim();
  }
  let song = title.replace(/\s+/g, " ").trim();
  song = /^["“'‘](.+)["”'’]$/.exec(song)?.[1] ?? song;
  song = featuredInTitle(song);
  if (featuring && !words(song).includes(words(featuring))) song = `${song} (feat. ${featuring})`;
  return { artist: who ? fromCapitals(who) : null, title: fromCapitals(song) || title.trim() };
}

/** A title without what videos add, its track number, and split at its dashes. */
function partsOf(title: string): { clean: string; parts: string[] } {
  const clean = withoutNameNoise(title).replace(TRACK_NUMBER_RE, "");
  return { clean, parts: clean.split(DASH_RE).filter((part) => part.trim()) };
}

/**
 * A download's artist and title, from the video's title and its channel
 * (or a SoundCloud track's title and uploader):
 *
 * - "Artist - Song (Official Video)": the artist the title names, not the
 *   channel that uploaded it ("Trance Classics", "7clouds"); "Song - Artist"
 *   when the channel is that artist; `Artist "Song"` too.
 * - A title that doesn't say who — or only says which version it is ("Song -
 *   Live at Wembley") — is by the channel's artist ("Linkin Park - Topic" →
 *   Linkin Park, "TaylorSwiftVEVO" → Taylor Swift).
 * - Without what videos add ("(Official Video)", "HQ"…), who's featured as
 *   "(feat. …)" in the title, names in capitals in title case.
 */
export function songOfVideo(title: string, channel?: string | null): SongName {
  const who = channel?.trim() ? artistOfChannel(channel) : "";
  const { clean, parts } = partsOf(title);
  // YouTube Music's own upload: its title is the song alone, even with a dash in it.
  if (channel && TOPIC_RE.test(channel.trim())) return tidy({ artist: who, title: clean });
  // Spelt as the channel spells it ("Dr Dre - Darkside" by Dr. Dre), unless that's worse.
  const artist = (part: string) => speltAs(part, who);
  const inFront = who ? artistInFront(clean, who) : null;
  if (inFront) return tidy({ artist: artist(inFront.artist), title: inFront.title });
  if (parts.length >= 2) {
    const [first, ...rest] = parts;
    const last = parts[parts.length - 1];
    if (who && !namesArtist(first, who) && namesArtist(last, who)) {
      return tidy({ artist: artist(last), title: parts.slice(0, -1).join(" - ") });
    }
    // "Coeur D'alene - Alter Bridge III" by Alter Bridge: the album after the song.
    if (who && !namesArtist(first, who) && words(last).startsWith(words(who))) {
      return tidy({ artist: who, title: parts.slice(0, -1).join(" - ") });
    }
    if (!who || namesArtist(first, who) || !isVersionNote(rest.join(" - "))) {
      return tidy({ artist: artist(first), title: rest.join(" - ") });
    }
  }
  const quoted = QUOTED_RE.exec(clean);
  if (quoted && (!who || namesArtist(quoted[1], who))) {
    return tidy({ artist: quoted[1], title: `${quoted[2]}${quoted[3]}` });
  }
  return tidy({ artist: who || null, title: clean });
}

/**
 * What two copies of a song have in common: its artist and title, loosely
 * ("Linkin Park" / "Numb (Remastered)" and "LINKIN PARK" / "Numb" alike).
 */
export function songKeyOf({ artist, title }: SongName): string {
  const bare = title.replace(/\s*[([][^)\]]*[)\]]/g, "").trim() || title;
  return `${loose(artist ?? "")}|${loose(bare)}`;
}

/** The file name a song is saved as: "Artist - Title", or the title alone, made safe to save. */
export function fileNameOf({ artist, title }: SongName): string {
  return sanitizedFileName(artist ? `${artist} - ${title}` : title);
}

// --- A folder's songs ----------------------------------------------------------------

/** What a folder's songs say about the artists in it, for tidiedSong() (folderArtistsOf()). */
export type FolderArtists = {
  /** How many songs each artist has (by artistKey()), and how the folder spells it most. */
  artists: ReadonlyMap<string, { songs: number; spelt: string }>;
  /** The same spellings, for artistFirst(). */
  spellings: KnownArtists;
  /**
   * Artist tags that are really a channel which uploaded other people's
   * songs ("Trance Classics"), by artistKey(): most of its songs' titles
   * name someone else ("Paul van Dyk - For An Angel").
   */
  channels: ReadonlySet<string>;
};

/**
 * What a folder's songs say about its artists: their artist tags, and the
 * first half of "Artist - Song" file names two or more songs share — each
 * spelt as most of its songs spell it, not in capitals if any song has it
 * otherwise.
 */
export function folderArtistsOf(
  songs: readonly { name: string; title: string; artist?: string | null }[],
): FolderArtists {
  const spellings = new Map<string, Map<string, number>>();
  const add = (spelt: string, key = artistKey(spelt)) => {
    if (!key) return;
    const seen = spellings.get(key) ?? new Map<string, number>();
    seen.set(spelt, (seen.get(spelt) ?? 0) + 1);
    spellings.set(key, seen);
  };
  const byArtist = new Map<string, { songs: number; others: Set<string> }>();
  const firsts = new Map<string, string[]>();
  for (const { name, title, artist } of songs) {
    const halves = withoutNameNoise(name).split(DASH_RE);
    if (halves.length >= 2) {
      const key = artistKey(halves[0]);
      firsts.set(key, [...(firsts.get(key) ?? []), halves[0].trim()]);
    }
    if (!artist?.trim()) continue;
    const tagged = artistOfChannel(artist);
    const key = artistKey(tagged);
    add(tagged, key);
    const seen = byArtist.get(key) ?? { songs: 0, others: new Set<string>() };
    seen.songs++;
    const { parts } = partsOf(title);
    if (
      parts.length >= 2 &&
      !namesArtist(parts[0], tagged) &&
      !namesArtist(parts.at(-1)!, tagged)
    ) {
      seen.others.add(loose(parts[0]));
    }
    byArtist.set(key, seen);
  }
  for (const [key, spelt] of firsts) {
    if (spelt.length >= 2 && !spellings.has(key)) for (const each of spelt) add(each, key);
  }
  const artists = new Map<string, { songs: number; spelt: string }>();
  const spelt = new Map<string, string>();
  for (const [key, seen] of spellings) {
    const ranked = [...seen].sort(
      ([a, n], [b, m]) => Number(/\p{Ll}/u.test(b)) - Number(/\p{Ll}/u.test(a)) || m - n,
    );
    const songs = [...seen.values()].reduce((sum, n) => sum + n, 0);
    artists.set(key, { songs, spelt: ranked[0][0] });
    spelt.set(key, ranked[0][0]);
  }
  const channels = new Set<string>();
  for (const [key, { songs, others }] of byArtist) {
    // Three songs or more, most of them by two or more other artists.
    if (songs >= 3 && others.size >= 2 && others.size * 3 >= songs * 2) channels.add(key);
  }
  return { artists, spellings: spelt, channels };
}

/**
 * A folder song's artist and title, tidied — or as they are, when they're
 * tidy already:
 *
 * - Its title without what videos add and its track number, "ft." as
 *   "(feat. …)", capitals in title case; who's featured moved from the
 *   artist into the title.
 * - "Linkin Park - Numb" as its title: the artist taken out of it. A title
 *   that names another artist than its tag ("Paul van Dyk - For An Angel" by
 *   "Trance Classics") takes that artist, when the tag is a channel
 *   (FolderArtists) or the folder knows that artist from its other songs.
 * - Title and artist the wrong way round ("Linkin Park (Meteora)" by "Hit
 *   The Floor"): put round, when the folder has other songs by the title's
 *   artist and none by the tag's.
 * - A song without an artist tag (its title is then its file name): the
 *   artist "Artist - Song" names — "Song - Artist" put round when the folder
 *   knows that artist.
 * - The artist spelt as the folder spells it most ("LINKIN PARK" → "Linkin
 *   Park"), "Linkin Park - Topic" as Linkin Park.
 */
export function tidiedSong(
  { title, artist }: { title: string; artist: string | null },
  { artists, channels }: FolderArtists,
): SongName {
  const songsBy = (name: string) => artists.get(artistKey(name))?.songs ?? 0;
  const spelt = (name: string) => {
    const most = artists.get(artistKey(name))?.spelt;
    return most && /\p{Ll}/u.test(most) ? most : name;
  };
  const tagged = artist?.trim() ? artistOfChannel(artist) : "";
  const { clean, parts } = partsOf(title);
  let song: SongName = { artist: tagged || null, title: clean };
  // "Linkin Park (Meteora)" by "Hit The Floor": the song's name is in its artist tag (but
  // "Rush (Angelic Remix)" by Orion is a song called Rush).
  const bare = clean.replace(/\s*[([][^)\]]*[)\]]/g, "").trim();
  const swapped =
    tagged &&
    bare !== clean &&
    !VERSION_IN_BRACKETS_RE.test(clean) &&
    songsBy(bare) >= 2 &&
    songsBy(tagged) <= 1 &&
    !sameArtist(bare, tagged);
  // "Michael Jackson Beat It" by Michael Jackson: the artist's name in front, with or without a dash.
  const inFront = tagged && !swapped ? artistInFront(clean, tagged) : null;
  if (swapped) {
    const featuring = /[([]\s*((?:featuring|feat|ft)\b.*?)\s*[)\]]/i.exec(clean)?.[1];
    song = { artist: bare, title: featuring ? `${tagged} (${featuring})` : tagged };
  } else if (inFront) {
    song = { artist: speltAs(inFront.artist, tagged), title: inFront.title };
  } else if (parts.length >= 2) {
    const [first, ...rest] = parts;
    const last = parts[parts.length - 1];
    const known = (name: string) => songsBy(name) > 0;
    // Spelt as the tag spells it ("Dr Dre - Darkside" by Dr. Dre), unless that's worse.
    const byTag = (part: string) => speltAs(part, tagged);
    if (!tagged) {
      // "Numb - Linkin Park", untagged: put round when the folder knows Linkin Park.
      song =
        known(last) && !known(first)
          ? { artist: last, title: parts.slice(0, -1).join(" - ") }
          : { artist: first, title: rest.join(" - ") };
    } else if (namesArtist(first, tagged)) {
      song = { artist: byTag(first), title: rest.join(" - ") };
    } else if (namesArtist(last, tagged)) {
      song = { artist: byTag(last), title: parts.slice(0, -1).join(" - ") };
    } else if (words(last).startsWith(words(tagged))) {
      // "Coeur D'alene - Alter Bridge III" by Alter Bridge: the album after the song.
      song = { artist: tagged, title: parts.slice(0, -1).join(" - ") };
    } else if (channels.has(artistKey(tagged)) || (known(first) && !known(rest.join(" - ")))) {
      song = { artist: first, title: rest.join(" - ") };
    }
  }
  const tidied = tidy(song);
  return { artist: tidied.artist ? spelt(tidied.artist) : null, title: tidied.title };
}

/**
 * Does a file name say the song's artist and title? "Linkin Park - Numb
 * (Live at Milton Keynes)" says Linkin Park's Numb, "Bob Marley - War" Bob
 * Marley & The Wailers' War, and "Mike Shinoda - About You feat. blackbear"
 * Mike Shinoda's "About You (feat. blackbear)"; "Numb", "Track 03", "Ghost -
 * 05 - Miasma" and "Alter Bridge - Coeur D'alene - Alter Bridge III" don't.
 */
function nameSays(name: string, { artist, title }: SongName): boolean {
  const parts = name.split(DASH_RE);
  if (!artist || parts.length < 2) return false;
  const who = words(parts[0]);
  // The song's name ("ft." as "(feat. …)"), without who's featured, and without any brackets.
  const forms = (text: string) => {
    const full = featuredInTitle(text);
    const unfeatured = full.replace(new RegExp(String.raw`\s*\(${FEAT}[^)]*\)`, "gi"), "");
    const bare = full.replace(/\s*[([][^)\]]*[)\]]?/g, "");
    return [full, unfeatured, bare].map(loose).filter(Boolean);
  };
  const song = forms(title);
  return (
    (sameArtist(parts[0], artist) || words(artist).includes(who) || who.includes(words(artist))) &&
    forms(parts.slice(1).join(" - ")).some((said) => song.includes(said))
  );
}

/**
 * Sanitize Filename: a folder song tidied — its artist and title
 * (tidiedSong()) and its file name, without its folder or extension:
 * "Artist - Title" when its name doesn't say both, else its own name
 * sanitized (sanitizedFileName(), "Song - Artist" put round: artistFirst()).
 */
export function tidiedFile(
  song: { name: string; title: string; artist: string | null },
  folder: FolderArtists,
): SongName & { name: string } {
  let tidied = tidiedSong(song, folder);
  // (Made safe again: the folder may spell the artist "AC/DC".)
  const clean = safeFileName(
    artistFirst(sanitizedFileName(song.name), folder.spellings),
    song.name,
  );
  // A title in capitals left as it is ("FAINT" may be an acronym), spelt as its file name has it.
  const said = clean.split(DASH_RE).slice(1).join(" - ");
  if (
    !/\p{Ll}/u.test(tidied.title) &&
    /\p{Ll}/u.test(said) &&
    said.toLowerCase() === tidied.title.toLowerCase()
  ) {
    tidied = { ...tidied, title: said };
  }
  return {
    ...tidied,
    name: nameSays(clean, tidied) || !tidied.artist ? clean : fileNameOf(tidied),
  };
}
