/**
 * Text folded for matching: lower case, accents gone, punctuation a space —
 * "Beyoncé — Halo!" → "beyonce halo". Every feature that compares names
 * (search ranking, finding songs in the folder, the catalogues, Sanitize
 * Filename, filters) folds through here.
 *
 * Which marks go is the caller's choice, and the callers differ today:
 * - "all": every combining mark, in any script (also Hindi's vowel signs);
 * - "latin": only the Latin accents (U+0300–U+036F);
 * - "keep": none (each mark becomes a space with the punctuation).
 */

export type Marks = "all" | "latin" | "keep";

// Built with `new RegExp`: TypeScript refuses the "u" flag in a regex literal
// at this project's default (ES5) target, though Node and browsers run it fine.
const ALL_MARKS = new RegExp("\\p{M}+", "gu");
const LATIN_ACCENTS = /[̀-ͯ]/g;
const NOT_LETTERS = new RegExp("[^\\p{L}\\p{N}]+", "gu");

/** Lower case (`lower` makes it), decomposed, without the `marks` asked for. */
export function foldCase(
  text: string,
  marks: Marks = "all",
  lower: (text: string) => string = (t) => t.toLowerCase(),
): string {
  const decomposed = lower(text).normalize("NFKD");
  if (marks === "all") return decomposed.replace(ALL_MARKS, "");
  if (marks === "latin") return decomposed.replace(LATIN_ACCENTS, "");
  return decomposed;
}

/** foldCase(), anything that isn't a letter or digit a single space, trimmed. */
export function foldWords(text: string, marks: Marks = "all"): string {
  return foldCase(text, marks).replace(NOT_LETTERS, " ").trim();
}

/** foldCase() with only its letters and digits: "Hip-Hop/Rap" → "hiphoprap". */
export function foldSquashed(
  text: string,
  marks: Marks = "all",
  lower?: (text: string) => string,
): string {
  return foldCase(text, marks, lower).replace(NOT_LETTERS, "");
}
