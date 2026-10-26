import { describe, expect, it, vi } from "vitest";
import { folderGenreOf, guessGenre, type ArtistSong } from "../../server/artist-genre";

// A genre for a song no catalogue has one for, guessed from its artist
// (server/artist-genre.ts): their other songs in the folder first, else the
// catalogues' (played by a stand-in here).

const FOLDER: ArtistSong[] = [
  { artist: "Linkin Park", genres: ["Nu Metal"] },
  { artist: "Linkin Park", genres: ["Nu Metal", "Rock"] },
  { artist: "LINKIN PARK", genres: ["nu metal"] },
  { artist: "Linkin Park", genres: ["Rock"] },
  { artist: "Linkin Park", genres: [] },
  { artist: "Linkin Park & Jay-Z", genres: ["Rap"] },
  { artist: "Jay-Z", genres: ["Hip-Hop"] },
  { artist: "Simon & Garfunkel", genres: ["Folk"] },
  { artist: "Simon", genres: ["Pop"] },
  { artist: null, genres: ["Jazz"] },
];

describe("folderGenreOf", () => {
  it("takes the genre most of the artist's songs have, spelt as most of them spell it", () => {
    expect(folderGenreOf("Linkin Park", FOLDER)).toEqual({ genre: "Nu Metal", count: 3 });
    expect(folderGenreOf("linkin park", FOLDER)).toEqual({ genre: "Nu Metal", count: 3 });
    expect(folderGenreOf("Jay-Z", FOLDER)).toEqual({ genre: "Hip-Hop", count: 1 });
  });

  it("matches the whole credit first, else the first artist it names", () => {
    expect(folderGenreOf("Simon & Garfunkel", FOLDER)).toEqual({ genre: "Folk", count: 1 });
    expect(folderGenreOf("Linkin Park feat. Kiiara", FOLDER)).toEqual({
      genre: "Nu Metal",
      count: 3,
    });
    expect(folderGenreOf("Jay-Z & Kanye West", FOLDER)).toEqual({ genre: "Hip-Hop", count: 1 });
    expect(folderGenreOf("Daft Punk", FOLDER)).toBe(undefined);
    expect(folderGenreOf("  ", FOLDER)).toBe(undefined);
  });
});

describe("guessGenre", () => {
  it("guesses from the folder first, saying how many of the artist's songs have it", async () => {
    const byCatalogue = vi.fn(async () => ({ genre: "Rock", source: "itunes" as const }));
    expect(await guessGenre("Linkin Park", async () => FOLDER, { byCatalogue })).toEqual({
      genre: "Nu Metal",
      why: "3 of Linkin Park's other songs here are Nu Metal",
    });
    expect(await guessGenre("Jay-Z", async () => FOLDER, { byCatalogue })).toEqual({
      genre: "Hip-Hop",
      why: "another song of Jay-Z's here is Hip-Hop",
    });
    expect(byCatalogue).not.toHaveBeenCalled();
  });

  it("else takes the genre a catalogue files the artist under, or none", async () => {
    const itunes = async () => ({ genre: "Electronic", source: "itunes" as const });
    expect(await guessGenre("Daft Punk", async () => FOLDER, { byCatalogue: itunes })).toEqual({
      genre: "Electronic",
      why: "iTunes files Daft Punk under Electronic",
    });
    // Without the folder's songs (a download to the browser), or when they can't be read.
    expect(await guessGenre("Daft Punk", undefined, { byCatalogue: itunes })).toMatchObject({
      genre: "Electronic",
    });
    const unreadable = async () => {
      throw new Error("EACCES");
    };
    expect(await guessGenre("Daft Punk", unreadable, { byCatalogue: itunes })).toMatchObject({
      genre: "Electronic",
    });
    expect(
      await guessGenre("Nobody", async () => FOLDER, { byCatalogue: async () => undefined }),
    ).toBe(undefined);
    const failing = async () => {
      throw new Error("no connection");
    };
    expect(await guessGenre("Nobody", undefined, { byCatalogue: failing })).toBe(undefined);
  });
});
