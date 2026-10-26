/**
 * Text folded for matching: lower case, Latin accents gone, anything that
 * isn't part of a word a space — "Beyoncé — Halo!" → "beyonce halo",
 * "Mötley Crüe" → "motley crue". Other scripts keep their words whole: a
 * Hindi word's vowel signs are part of it ("हिन्दी गाना" stays two words).
 * Every feature that compares names (search ranking, finding songs in the
 * folder, the catalogues, Sanitize Filename, filters) folds through here, so
 * they all agree on what is the same name.
 */

// Built with `new RegExp`: TypeScript refuses the "u" flag in a regex literal
// at this project's default (ES5) target, though Node and browsers run it fine.
/** The combining accents Latin letters take apart into (é → e + ´). */
const LATIN_ACCENTS = /[̀-ͯ]/g;
/** Anything but letters, the marks that belong to them (other scripts) and digits. */
const NOT_WORD = new RegExp("[^\\p{L}\\p{M}\\p{N}]+", "gu");

/** Lower case (`lower` makes it), taken apart, without Latin accents. */
export function foldCase(
  text: string,
  lower: (text: string) => string = (t) => t.toLowerCase(),
): string {
  return lower(text).normalize("NFKD").replace(LATIN_ACCENTS, "");
}

/** foldCase(), anything that isn't part of a word a single space, trimmed. */
export function foldWords(text: string): string {
  return foldCase(text).replace(NOT_WORD, " ").trim();
}

/** foldCase() with only its words' letters and digits: "Hip-Hop/Rap" → "hiphoprap". */
export function foldSquashed(text: string, lower?: (text: string) => string): string {
  return foldCase(text, lower).replace(NOT_WORD, "");
}
