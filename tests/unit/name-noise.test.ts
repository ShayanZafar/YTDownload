import { describe, expect, it } from "vitest";
import {
  artistFirst,
  decodeEntities,
  fromAllCaps,
  knownArtists,
  sanitizedFileName,
  withoutNameNoise,
} from "../../shared/name-noise";
import { searchesFor } from "../../server/lyrics";

// What video titles and file names add to a song's name (shared/name-noise.ts),
// taken out before the music catalogues and LRCLIB are searched.

describe("withoutNameNoise", () => {
  it("takes out what videos and copies add, in brackets or at the end", () => {
    const cases: [string, string][] = [
      ["Junoon - Heer (Official Audio)", "Junoon - Heer"],
      ["T2 - 8-15 To Nowhere (DJ Taucher Remix) (HD)", "T2 - 8-15 To Nowhere (DJ Taucher Remix)"],
      [
        "Tekara - Breathe In You (Tekara's M&M Dub) (1998)",
        "Tekara - Breathe In You (Tekara's M&M Dub)",
      ],
      ["Jimi Hendrix Purple Haze (1)", "Jimi Hendrix Purple Haze"],
      [
        "Michael Jackson Don't Stop Til You Get Enough Audio HQ",
        "Michael Jackson Don't Stop Til You Get Enough",
      ],
      ["Genetic - Trancemission . HQ", "Genetic - Trancemission"],
      ["OSA Official HD Video", "OSA"],
      ["Lithium HQ", "Lithium"],
      ["Linkin Park - Numb Lyrics", "Linkin Park - Numb"],
      // A dot that's part of the name stays (a file name can't end in one, but a title can).
      ["Gorillaz - Feel Good Inc. Lyrics", "Gorillaz - Feel Good Inc."],
      ["Yanni - Dance With a Stranger remaster", "Yanni - Dance With a Stranger"],
      [
        "2 Unlimited - The Magic Friend (Extended Version) 1992",
        "2 Unlimited - The Magic Friend (Extended Version)",
      ],
      ["Dead Prez - Hip-Hop [HQExplicit]", "Dead Prez - Hip-Hop"],
      ["ZZ Top - Just Got Paid (HIGH QUALITY)", "ZZ Top - Just Got Paid"],
      ["Koyla Dekha Tujhe Tho High Quality Audio", "Koyla Dekha Tujhe Tho"],
      ["Koyla Ghungte Mein ChandaHigh Quality Audio", "Koyla Ghungte Mein Chanda"],
      // What follows "Full Song" is the film and its stars.
      [
        "Tujh Mein Rab Dikhta Hai - Full Song Rab Ne Bana Di Jodi Shah Rukh Khan",
        "Tujh Mein Rab Dikhta Hai",
      ],
      ["Baazigar O Baazigar-HD VIDEO SONG Shahrukh Khan & Kajol", "Baazigar O Baazigar"],
    ];
    for (const [name, clean] of cases) expect(withoutNameNoise(name)).toBe(clean);
  });

  it("leaves a song's own name alone", () => {
    for (const name of [
      "Radio Video",
      "Party Like It's 1999",
      "1999",
      "HQ",
      "Love Song (Part 2)",
      "Full Song",
      "Explicit Content",
    ]) {
      expect(withoutNameNoise(name)).toBe(name);
    }
  });

  it("turns web-page leftovers back into letters", () => {
    expect(decodeEntities("A Warrior&#39s Call")).toBe("A Warrior's Call");
    expect(decodeEntities("Rock &amp; Roll &#8211; Live")).toBe("Rock & Roll – Live");
    expect(decodeEntities("&#0; &bogus;")).toBe("&#0; &bogus;");
  });
});

describe("searchesFor a file's name", () => {
  it("splits “Artist- Song” too, and searches without the noise", () => {
    expect(searchesFor({ title: "Volbeat- A Warrior&#39s Call (Official Video)" })).toEqual([
      { artist: "Volbeat", track: "A Warrior's Call" },
    ]);
    expect(searchesFor({ title: "Jay-Z - Song HQ" })).toEqual([{ artist: "Jay-Z", track: "Song" }]);
  });
});

describe("sanitizedFileName", () => {
  it("tidies a file's name for Sanitize Filename", () => {
    const cases: [string, string][] = [
      ["Junoon - Heer (Official Audio)", "Junoon - Heer"],
      ["Volbeat- A Warrior&#39s Call", "Volbeat - A Warrior's Call"],
      ["- Stuntin Like My Daddy", "Stuntin Like My Daddy"],
      ["Artist_-_Song_HQ", "Artist - Song"],
      ["Genetic - Trancemission . HQ", "Genetic - Trancemission"],
      ["Jimi Hendrix Purple Haze (1)", "Jimi Hendrix Purple Haze"],
      ["Rock &quot;n&quot; Roll", "Rock n Roll"],
      [
        "Immortal Technique - Point of No Return w Lyrics",
        "Immortal Technique - Point of No Return",
      ],
      [
        "Immortal Technique- Caught In a Hustle(con subtitulos)",
        "Immortal Technique - Caught In a Hustle",
      ],
      [
        "Aliotta Haynes Jeremiah - Lake Shore Drive Album (1971) - HQ 320 Kbps",
        "Aliotta Haynes Jeremiah - Lake Shore Drive Album",
      ],
      ["Heart --Magic Man - HQ Audio -- LYRICS", "Heart - Magic Man"],
      ["Linkin Park - Pts.of.Athrty HD 720p", "Linkin Park - Pts.of.Athrty"],
    ];
    for (const [name, clean] of cases) expect(sanitizedFileName(name)).toBe(clean);
  });

  it("leaves a tidy name as it is", () => {
    for (const name of [
      "Queen - Bohemian Rhapsody",
      "T2 - 8-15 To Nowhere",
      "Jay-Z - 99 Problems",
      "HQ",
    ]) {
      expect(sanitizedFileName(name)).toBe(name);
    }
  });
});

describe("fromAllCaps", () => {
  it("puts names in capitals in title case, leaving short words and mixed case alone", () => {
    const cases: [string, string][] = [
      ["MICHAEL JACKSON", "Michael Jackson"],
      ["SPEED DEMON (EXTENDED VERSION)", "Speed Demon (Extended Version)"],
      ["DON'T STOP", "Don't Stop"],
      ["ROCKY II THEME", "Rocky II Theme"],
      ["DMX", "DMX"],
      ["AC/DC", "AC/DC"],
      ["SPEED DEMON (Extended MoonWalker Version)", "Speed Demon (Extended MoonWalker Version)"],
      ["Feel Good Inc (DJ Remix)", "Feel Good Inc (DJ Remix)"],
      ["X", "X"],
      ["ZZ TOP", "ZZ Top"],
      ["M.U.T.E.", "M.U.T.E."],
      ["K.U.S.H. FOREVER", "K.U.S.H. Forever"],
      ["FRGT10 REMIX", "FRGT10 Remix"],
      ["LOST IN THE ECHO", "Lost In The Echo"],
    ];
    for (const [part, cased] of cases) expect(fromAllCaps(part)).toBe(cased);
    expect(sanitizedFileName("SPEED DEMON (Extended Version) - MICHAEL JACKSON")).toBe(
      "Speed Demon (Extended Version) - Michael Jackson",
    );
    expect(sanitizedFileName("MOHD RAFI - PARDA HAI PARDA")).toBe("Mohd Rafi - Parda Hai Parda");
  });
});

describe("artistFirst", () => {
  const artists = knownArtists([
    { name: "Linkin Park - Numb", artist: null },
    { name: "Linkin Park - Faint", artist: null },
    { name: "Promises I Can't Keep - Mike Shinoda", artist: "Mike Shinoda" },
    { name: "Crush - Paul van Dyk", artist: null },
  ]);

  it("puts “Song - Artist” round when the folder names that artist, and nothing else", () => {
    expect(artistFirst("Papercut - Linkin Park", artists)).toBe("Linkin Park - Papercut");
    expect(artistFirst("Promises I Can't Keep - Mike Shinoda", artists)).toBe(
      "Mike Shinoda - Promises I Can't Keep",
    );
    expect(artistFirst("Coke Studio - Tajdar - Linkin Park", artists)).toBe(
      "Linkin Park - Coke Studio - Tajdar",
    );
    // Already artist first, an artist named once only by a file name, or one part.
    expect(artistFirst("Linkin Park - Numb", artists)).toBe("Linkin Park - Numb");
    expect(artistFirst("Crush - Paul van Dyk", artists)).toBe("Crush - Paul van Dyk");
    expect(artistFirst("Linkin Park", artists)).toBe("Linkin Park");
    // In capitals: spelt as the folder spells it.
    expect(artistFirst("NUMB - LINKIN PARK", artists)).toBe("Linkin Park - NUMB");
    expect(artistFirst("LINKIN PARK - Numb", artists)).toBe("Linkin Park - Numb");
  });
});
