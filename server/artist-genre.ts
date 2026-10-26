/**
 * A genre for a song no music catalogue has a genre for, from its artist (the
 * owner's ask, October 2026): the genre most of the artist's other songs in
 * the folder have — the folder's own word for it — else the one a catalogue
 * files the artist under (`genreOfArtistNamed()`: iTunes, then MusicBrainz).
 * Always offered as a guess, saying where it came from.
 */
import { artistKey } from "@shared/name-noise";
import { genreOfArtistNamed, sourceName } from "./catalogues";

/** A genre guessed from the artist, and why: "3 of Linkin Park's other songs here are Rock". */
export type GenreGuess = { genre: string; why: string };

/** A folder song as the guess weighs it: its artist tag and genres. */
export type ArtistSong = { artist?: string | null; genres?: readonly string[] };

// Where a credit's first artist ends: "Linkin Park & Jay-Z", "Daft Punk feat. Pharrell".
const MORE_ARTISTS_RE =
  /\s*(?:,|&|;|\+|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?)\s/i;
const firstArtistKey = (artist: string) => artistKey(artist.split(MORE_ARTISTS_RE)[0]);

/**
 * The genre most of the songs by `artist` in `songs` have (each song's first
 * genre), spelt as most of them spell it, and how many have it — the whole
 * credit first ("Simon & Garfunkel"), else the first artist it names. Ties go
 * to the genre met first.
 */
export function folderGenreOf(
  artist: string,
  songs: readonly ArtistSong[],
): { genre: string; count: number } | undefined {
  const tally = (same: (song: ArtistSong) => boolean) => {
    const counts = new Map<string, { count: number; spellings: Map<string, number> }>();
    for (const song of songs) {
      const genre = song.genres?.[0]?.trim();
      if (!genre || !song.artist?.trim() || !same(song)) continue;
      const entry = counts.get(genre.toLowerCase()) ?? { count: 0, spellings: new Map() };
      entry.count++;
      entry.spellings.set(genre, (entry.spellings.get(genre) ?? 0) + 1);
      counts.set(genre.toLowerCase(), entry);
    }
    let best: { genre: string; count: number } | undefined;
    for (const { count, spellings } of counts.values()) {
      if (best && count <= best.count) continue;
      const [genre] = [...spellings].reduce((a, b) => (b[1] > a[1] ? b : a));
      best = { genre, count };
    }
    return best;
  };
  const whole = artistKey(artist);
  const first = firstArtistKey(artist);
  if (!whole) return undefined;
  return (
    tally((song) => artistKey(song.artist!) === whole) ??
    tally((song) => firstArtistKey(song.artist!) === first)
  );
}

/**
 * A guess at the genre of a song by `artist`: the folder's songs by them
 * (`folderSongs`, read only if asked for), else the catalogues'. Undefined
 * when neither knows the artist; never rejects for a catalogue that couldn't
 * be asked.
 */
export async function guessGenre(
  artist: string,
  folderSongs?: () => Promise<readonly ArtistSong[]>,
  { byCatalogue = genreOfArtistNamed }: { byCatalogue?: typeof genreOfArtistNamed } = {},
): Promise<GenreGuess | undefined> {
  const name = artist.trim();
  if (!name) return undefined;
  const songs = folderSongs ? await folderSongs().catch(() => []) : [];
  const inFolder = folderGenreOf(name, songs);
  if (inFolder) {
    const { genre, count } = inFolder;
    return {
      genre,
      why:
        count === 1
          ? `another song of ${name}'s here is ${genre}`
          : `${count} of ${name}'s other songs here are ${genre}`,
    };
  }
  const found = await byCatalogue(name).catch(() => undefined);
  return found
    ? { genre: found.genre, why: `${sourceName(found.source)} files ${name} under ${found.genre}` }
    : undefined;
}
