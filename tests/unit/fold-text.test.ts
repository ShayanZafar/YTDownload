import { describe, expect, it } from "vitest";
import { words } from "../../server/library";
import { normalize } from "../../server/search";
import { plain } from "../../server/catalogues";
import { artistKey } from "../../shared/name-noise";
import { searchableText } from "../../client/src/lib/history-filter";
import { foldCase, foldSquashed, foldWords } from "../../shared/fold-text";

// Every feature folds a name the same way, so a name one feature finds the
// others find too. Before they shared shared/fold-text.ts, they didn't: Fill
// in details' artist check made "Mötley Crüe" "mo tley cru e" (so it never
// matched "Motley Crue"), search dropped a Hindi title to nothing, and the
// others broke Hindi words apart ("हनद गन", "ह न द ग न").
const FOLDED = {
  "Beyoncé — Halo!": "beyonce halo",
  "Mötley Crüe": "motley crue",
  "AC/DC & Friends": "ac dc friends",
  "हिन्दी गाना": "हिन्दी गाना",
  "Sigur Rós – Hoppípolla": "sigur ros hoppipolla",
  "  The Beatles  ": "the beatles",
  İstanbul: "istanbul",
  "ＦＵＬＬ　ＷＩＤＴＨ ½": "full width 1 2",
  "Café del Mar (Remix)": "cafe del mar remix",
  "Ñandú 2005": "nandu 2005",
};

const FOLDS = { words, normalize, plain, artistKey, searchableText };

describe("each feature's folding", () => {
  for (const [name, fold] of Object.entries(FOLDS)) {
    it(`${name} folds like the others`, () => {
      for (const [input, folded] of Object.entries(FOLDED)) {
        // Catalogue look-ups also read "&" as "and" ("Simon & Garfunkel" is "Simon and Garfunkel").
        const expected = name === "plain" ? folded.replace("ac dc", "ac dc and") : folded;
        expect(fold(input), input).toBe(expected);
      }
    });
  }

  it("matches a name typed with or without its accents", () => {
    for (const fold of Object.values(FOLDS)) {
      expect(fold("Mötley Crüe")).toBe(fold("Motley Crue"));
      expect(fold("Sigur Rós")).toBe(fold("Sigur Ros"));
    }
    expect(artistKey("Beyoncé")).toBe(artistKey("BEYONCE"));
  });
});

describe("fold-text", () => {
  it("drops Latin accents and keeps other scripts' marks", () => {
    expect(foldCase("Mötley")).toBe("motley");
    expect(foldCase("हिन्दी")).toBe("हिन्दी");
    expect(foldCase("İstanbul")).toBe("istanbul");
  });

  it("makes words, or squashes them together", () => {
    expect(foldWords("  Beyoncé — Halo! ")).toBe("beyonce halo");
    expect(foldWords("हिन्दी — गाना!")).toBe("हिन्दी गाना");
    expect(foldSquashed("Hip-Hop/Rap")).toBe("hiphoprap");
    expect(foldSquashed("I", (t) => t.toLocaleLowerCase("tr"))).toBe("ı");
  });
});
