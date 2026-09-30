/**
 * Download file names: the video's title — or the name you typed when
 * renaming — made safe to save on Windows, macOS and Linux. Only what a file
 * system can't store is changed; accents, apostrophes, brackets and
 * non-Latin letters are kept. The server names files with this, and the page
 * uses it too, so the name shown is exactly the name saved.
 */

/** Long enough for any real title, short enough to stay well inside Windows' path limit. */
export const MAX_FILE_NAME_LENGTH = 150;

// Names Windows reserves for devices ("CON.mp3" can't be created either).
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// An audio extension typed as part of the name — the right one is added for you.
const TYPED_EXTENSION = /\.(mp3|opus|m4a|mka|ogg|webm|aac|wav|flac)$/i;

/**
 * "AC/DC: Back In Black" → "AC-DC - Back In Black"; "Song.mp3" → "Song";
 * nothing usable → `fallback`. The extension is not included.
 */
export function safeFileName(name: string, fallback = "audio"): string {
  let clean = Array.from(name.normalize("NFC"))
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code < 32 || code === 127) return " "; // control characters
      if (ch === "/" || ch === "\\") return "-"; // AC/DC → AC-DC
      if (ch === ":" || ch === "|") return " - "; // "Title: Subtitle" → "Title - Subtitle"
      if ('?*"<>'.includes(ch)) return "";
      return ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  // "Song.mp3" (or "Song.mp3.mp3") → "Song", then no dots or spaces at either end.
  let previous;
  do {
    previous = clean;
    clean = clean.replace(TYPED_EXTENSION, "").replace(/^[.\s]+|[.\s]+$/g, "");
  } while (clean !== previous);

  clean = Array.from(clean)
    .slice(0, MAX_FILE_NAME_LENGTH)
    .join("")
    .replace(/[.\s]+$/, "");
  if (!clean) return fallback;
  return RESERVED_WINDOWS_NAMES.test(clean) ? `${clean}_` : clean;
}
