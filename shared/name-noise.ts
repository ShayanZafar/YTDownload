/**
 * What video titles and file names add that isn't part of a song's name:
 * "(Official Video)", "HQ", "Lyrics Video", "(1998)", a copy's "(1)", and
 * web-page leftovers like "&#39". Shared by the server (searching the music
 * catalogues and LRCLIB) and the page.
 */

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
// "(Full Song)", a year "(1998)" and a copy's "(1)".
const BRACKETED_NOISE_RE =
  /\s*[([](?:official\b[^)\]]*|[^)\]]*\b(?:video|audio|visuali[sz]er|lyrics?|lyric video|hd|hq|4k|full song|remaster(?:ed)?(?: \d{4})?)\b[^)\]]*|(?:19|20)\d{2}|\d)[)\]]/gi;

// At the end, without brackets: "HQ", "Official HD Video", "Audio HQ", "Lyrics Video"…
// (a bare "Video" or "Audio" can be the song's name: "Radio Video").
const TRAILING_NOISE_RE =
  /(?:\s+|\s*[-–—|.]\s*)(?:audio (?:hq|hd)|official(?: (?:hd|hq|4k))?(?: music| lyrics?)? (?:video|audio)|(?:hd|hq) (?:video|audio)|lyrics? video|music video|full song|lyrics|hq|hd|4k|1080p|720p|remaster(?:ed)?(?: \d{4})?)$/i;

/** `text` without the words above, or `text` itself if nothing else would be left. */
export function withoutNameNoise(text: string): string {
  let clean = decodeEntities(text).replace(BRACKETED_NOISE_RE, "");
  for (let before = ""; before !== clean;) {
    before = clean;
    clean = clean.replace(TRAILING_NOISE_RE, "").replace(/\s*[-–—|.]+$/, "");
  }
  // "(Extended Version) 1992": a year after the brackets.
  clean = clean.replace(/\)\s+(?:19|20)\d{2}$/, ")");
  clean = clean.replace(/\s+/g, " ").trim();
  return clean || text.trim();
}
