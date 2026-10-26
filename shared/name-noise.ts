/**
 * What video titles and file names add that isn't part of a song's name:
 * "(Official Video)", "HQ", "Lyrics Video", "(1998)", a copy's "(1)", and
 * web-page leftovers like "&#39". Shared by the server (searching the music
 * catalogues and LRCLIB) and the page.
 */

import { safeFileName } from "./filename";
import { foldWords } from "./fold-text";

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

/** "Warrior&#39s Call" → "Warrior's Call": HTML entities, with or without their ";". */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,6});?/g, (whole, code: string) => {
      const n = Number(code);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    })
    .replace(/&(amp|quot|apos|lt|gt);/gi, (_, name: string) => ENTITIES[name.toLowerCase()]);
}

// In brackets: "(Official Video)", "[HD]", "(Lyric Video)", "(Remastered 2011)",
// "(Full Song)", "(con subtítulos)", "[HQExplicit]", "(High Quality)", "(prod. Saba & Phoelix)",
// "(LyricsHQ version)", "(Full Version)", "(Best Quality)", a year "(1998)" and a copy's "(1)".
const BRACKETED_NOISE_RE =
  /\s*[([](?:official\b[^)\]]*|(?:prod\.?|produced by)\s[^)\]]*|full(?: version)?|best quality|[^)\]]*\b(?:video|audio|visuali[sz]er|lyrics?(?:hd|hq)*|lyric video|hd|hq\w*|high quality|4k|explicit|full song|subt[ií]tulos|subtitulad[oa]|letra|remaster(?:ed)?(?: \d{4})?)\b[^)\]]*|(?:19|20)\d{2}|\d)[)\]]/gi;

// At the end, without brackets: "HQ", "Official HD Video", "Audio HQ", "Lyrics Video",
// "w Lyrics", "HQ 320 Kbps", "High Quality Audio" (even run on: "ChandaHigh Quality Audio")…
// (a bare "Video" or "Audio" can be the song's name: "Radio Video").
const RUN_ON_NOISE_RE = /\s*high quality audio$/i;

// "- Full Song Rab Ne Bana Di Jodi Shah Rukh Khan…", "-HD VIDEO SONG Shahrukh Khan & Kajol…":
// what follows is the film and its stars.
const FILM_NOISE_RE = /(?<=\S)\s*[-–—|]?\s*\b(?:full (?:video )?song|hd video song)\b.*$/i;

const TRAILING_NOISE_RE =
  /(?:\s+|\s*[-–—|]+\s*|\s+\.+\s*)(?:audio (?:hq|hd)|lyrics?(?:hd|hq)+(?: version)?|full version|(?:w\/?|with) lyrics|(?:hq )?\d{2,3} ?kbps|official(?: (?:hd|hq|4k))?(?: music| lyrics?)? (?:video|audio)|(?:hd|hq) (?:video|audio)|lyrics? video|lyrical(?: video)?|music video|full song|lyrics|high quality|hq|hd|4k|1080p|720p|(?:(?:19|20)\d{2} )?remaster(?:ed)?(?: version)?(?: \d{4})?)$/i;

// At the start: the site a download came from ("yt1s.com - ", "y2mate.com - "), or "HD ".
const SITE_NOISE_RE =
  /^\s*(?:www\.)?(?:yt1s|y2mate|ytmp3|savefrom|flvto|mp3juices|onlinevideoconverter|x2convert|notube|tomp3)\b[\w.-]*\.(?:com|net|org|cc|is|io|me|to|ch|biz|info|app)\s*[-–—_|]+\s*/i;

/** `text` without the words above, or `text` itself if nothing else would be left. */
export function withoutNameNoise(text: string): string {
  let clean = decodeEntities(text)
    .replace(SITE_NOISE_RE, "")
    .replace(/^(?:HD|HQ)\s+(?=\S)/, "")
    .replace(BRACKETED_NOISE_RE, "")
    .replace(FILM_NOISE_RE, "")
    .replace(RUN_ON_NOISE_RE, "");
  for (let before = ""; before !== clean;) {
    before = clean;
    // And a dash or a lone dot left at the end ("Song -", "Song ."), not "Inc.".
    clean = clean
      .replace(TRAILING_NOISE_RE, "")
      // Run on: "ExodusHD", "Out of TimeLyricsHDHQ", "LegsHQ+Lyrics".
      .replace(/(?<=[\p{Ll})\]])(?:Lyrics)?(?:HD|HQ)+$/u, "")
      .replace(/\s*\+\s*lyrics$/i, "")
      // "Kickstart My Heart - Official", not "Make It Official".
      .replace(/\s*[-–—|]+\s*official$/i, "")
      .replace(/\s*[-–—|]+$|\s+\.+$/, "");
  }
  // "(Extended Version) 1992": a year after the brackets.
  clean = clean.replace(/\)\s+(?:19|20)\d{2}$/, ")");
  clean = clean.replace(/\s+/g, " ").trim();
  return clean || text.trim();
}

const ROMAN_RE = /^[IVXLC]+$/;

/**
 * A word in capitals that stays so: a Roman numeral ("II"), one with digits
 * ("FRGT10"), initials ("M.U.T.E.", "T.O.S."), or two letters without a vowel ("ZZ", "DJ").
 */
const keepsCapitals = (word: string) =>
  ROMAN_RE.test(word) ||
  /\p{Ll}|\d/u.test(word) ||
  /\p{L}\.\p{L}/u.test(word) ||
  /^[^\p{L}]*[B-DF-HJ-NP-TV-XZ]{1,2}[^\p{L}]*$/u.test(word);

/**
 * A part of a name in capitals ("MICHAEL JACKSON", "SPEED DEMON") in title
 * case ("Michael Jackson"), its words with small letters as they are. A part
 * with small letters outside brackets stays as it is, and so does a single
 * short word ("DMX", "ABBA", "AC/DC") and any word keepsCapitals() keeps.
 */
export function fromAllCaps(part: string): string {
  // Judged without what's in brackets: "SPEED DEMON (Extended Version)" is in capitals.
  const outside = part.replace(/[([][^)\]]*[)\]]/g, "");
  if (/\p{Ll}/u.test(outside) || !/\p{Lu}.*\p{Lu}/u.test(outside)) return part;
  const words = part.trim().split(/\s+/);
  if (words.length === 1 && words[0].length <= 5) return part;
  return part.replace(/\S+/g, (word) =>
    keepsCapitals(word)
      ? word
      : word
          .toLowerCase()
          .replace(
            /(^|[([\-/"“])(\p{Ll})/gu,
            (_, before: string, letter: string) => before + letter.toUpperCase(),
          ),
  );
}

/**
 * Sanitize Filename: a song's file name (without its extension) as it should
 * read — without the noise above, parts in capitals in title case, "Artist- Song" and "Artist_-_Song" as
 * "Artist - Song", no stray dashes at either end — and safe to save
 * (safeFileName). The name itself if nothing's left of it.
 */
export function sanitizedFileName(name: string): string {
  let clean = /\s/.test(name) ? name : name.replace(/_+/g, " ");
  clean = withoutNameNoise(clean)
    .replace(/\s*[-–—]+\s+|\s+[-–—]+\s*/g, " - ")
    .replace(/^[\s\-–—_.]+|[\s\-–—_]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" - ")
    .map(fromAllCaps)
    .join(" - ");
  return clean ? safeFileName(clean, name) : name;
}

/** An artist's name to compare: lower case, letters and digits only (KnownArtists keys). */
export const artistKey = (name: string) => foldWords(name, "keep");

/** A folder's artists (knownArtists()): by artistKey(), each as the folder spells it. */
export type KnownArtists = ReadonlyMap<string, string>;

const hasSmallLetters = (text: string) => /\p{Ll}/u.test(text);

/**
 * The artists a folder's songs name: their artist tags, and the first half of
 * "Artist - Song" file names that two or more songs share — each spelt as
 * the folder spells it, not in capitals if any song has it otherwise. For artistFirst().
 */
export function knownArtists(
  songs: readonly { name: string; artist?: string | null }[],
): Map<string, string> {
  const artists = new Map<string, string>();
  const firsts = new Map<string, { count: number; spelt: string }>();
  const add = (spelt: string) => {
    const key = artistKey(spelt);
    const known = artists.get(key);
    if (key && (!known || (!hasSmallLetters(known) && hasSmallLetters(spelt)))) {
      artists.set(key, spelt.trim());
    }
  };
  for (const { name, artist } of songs) {
    if (artist?.trim()) add(artist);
    const halves = name.split(" - ");
    if (halves.length < 2) continue;
    const key = artistKey(halves[0]);
    const seen = firsts.get(key);
    firsts.set(key, {
      count: (seen?.count ?? 0) + 1,
      spelt: seen && hasSmallLetters(seen.spelt) ? seen.spelt : halves[0],
    });
  }
  for (const { count, spelt } of firsts.values()) if (count >= 2) add(spelt);
  return artists;
}

/**
 * "Song - Artist" put round to "Artist - Song", as the rest of a folder's
 * songs are named: when its last part is one of `artists` and its first
 * isn't. An artist in capitals ("QUEEN") is spelt as the folder spells it.
 * Any other name as it is.
 */
export function artistFirst(name: string, artists: KnownArtists): string {
  const parts = name.split(" - ");
  if (parts.length < 2) return name;
  const spelt = (part: string) =>
    hasSmallLetters(part) ? part : (artists.get(artistKey(part)) ?? part);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (artists.has(artistKey(first))) return [spelt(first), ...parts.slice(1)].join(" - ");
  if (!artists.has(artistKey(last))) return name;
  return [spelt(last), ...parts.slice(0, -1)].join(" - ");
}
