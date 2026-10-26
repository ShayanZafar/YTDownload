import { describe, expect, it } from "vitest";
import { decodeEntities, withoutNameNoise } from "../../shared/name-noise";
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
      ["Yanni - Dance With a Stranger remaster", "Yanni - Dance With a Stranger"],
      [
        "2 Unlimited - The Magic Friend (Extended Version) 1992",
        "2 Unlimited - The Magic Friend (Extended Version)",
      ],
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
