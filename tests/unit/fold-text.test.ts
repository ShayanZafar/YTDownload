import { describe, expect, it } from "vitest";
import { words } from "../../server/library";
import { normalize } from "../../server/search";
import { plain } from "../../server/catalogues";
import { artistKey } from "../../shared/name-noise";
import { searchableText } from "../../client/src/lib/history-filter";
import { foldCase, foldSquashed, foldWords } from "../../shared/fold-text";

// What each feature's name folding gives today, recorded before they were moved onto
// shared/fold-text.ts: the move must not change one of them. Some of these are
// surprising (see the notes); changing them is a decision of its own.
const TODAY = {
  words: {
    "Beyoncé — Halo!": "beyonce halo",
    "Mötley Crüe": "motley crue",
    "AC/DC & Friends": "ac dc friends",
    "हिन्दी गाना": "हनद गन",
    "Sigur Rós – Hoppípolla": "sigur ros hoppipolla",
    "  The Beatles  ": "the beatles",
    İstanbul: "istanbul",
    "ＦＵＬＬ　ＷＩＤＴＨ ½": "full width 1 2",
    "Café del Mar (Remix)": "cafe del mar remix",
    "Ñandú 2005": "nandu 2005",
  },
  normalize: {
    "Beyoncé — Halo!": "beyonce halo",
    "Mötley Crüe": "motley crue",
    "AC/DC & Friends": "ac dc friends",
    "हिन्दी गाना": "",
    "Sigur Rós – Hoppípolla": "sigur ros hoppipolla",
    "  The Beatles  ": "the beatles",
    İstanbul: "istanbul",
    "ＦＵＬＬ　ＷＩＤＴＨ ½": "full width 1 2",
    "Café del Mar (Remix)": "cafe del mar remix",
    "Ñandú 2005": "nandu 2005",
  },
  plain: {
    "Beyoncé — Halo!": "beyonce halo",
    "Mötley Crüe": "motley crue",
    "AC/DC & Friends": "ac dc and friends",
    "हिन्दी गाना": "ह न द ग न",
    "Sigur Rós – Hoppípolla": "sigur ros hoppipolla",
    "  The Beatles  ": "the beatles",
    İstanbul: "istanbul",
    "ＦＵＬＬ　ＷＩＤＴＨ ½": "full width 1 2",
    "Café del Mar (Remix)": "cafe del mar remix",
    "Ñandú 2005": "nandu 2005",
  },
  artistKey: {
    "Beyoncé — Halo!": "beyonce halo",
    "Mötley Crüe": "mo tley cru e",
    "AC/DC & Friends": "ac dc friends",
    "हिन्दी गाना": "ह न द ग न",
    "Sigur Rós – Hoppípolla": "sigur ro s hoppi polla",
    "  The Beatles  ": "the beatles",
    İstanbul: "i stanbul",
    "ＦＵＬＬ　ＷＩＤＴＨ ½": "full width 1 2",
    "Café del Mar (Remix)": "cafe del mar remix",
    "Ñandú 2005": "n andu 2005",
  },
  searchableText: {
    "Beyoncé — Halo!": "beyonce halo",
    "Mötley Crüe": "motley crue",
    "AC/DC & Friends": "ac dc friends",
    "हिन्दी गाना": "ह न द ग न",
    "Sigur Rós – Hoppípolla": "sigur ros hoppipolla",
    "  The Beatles  ": "the beatles",
    İstanbul: "istanbul",
    "ＦＵＬＬ　ＷＩＤＴＨ ½": "full width 1 2",
    "Café del Mar (Remix)": "cafe del mar remix",
    "Ñandú 2005": "nandu 2005",
  },
} as const;

const FOLDS = { words, normalize, plain, artistKey, searchableText };

describe("each feature's folding, as it was", () => {
  for (const [name, fold] of Object.entries(FOLDS)) {
    it(name, () => {
      const today = TODAY[name as keyof typeof TODAY];
      for (const [input, folded] of Object.entries(today)) expect(fold(input), input).toBe(folded);
    });
  }
});

describe("fold-text", () => {
  it("takes every mark, only the Latin accents, or none", () => {
    expect(foldCase("Mötley हिन्दी", "all")).toBe("motley हनद");
    expect(foldCase("Mötley", "latin")).toBe("motley");
    expect(foldCase("Mötley", "keep")).toBe("mo\u0308tley");
  });

  it("makes words, or squashes them together", () => {
    expect(foldWords("  Beyoncé — Halo! ")).toBe("beyonce halo");
    expect(foldSquashed("Hip-Hop/Rap")).toBe("hiphoprap");
    expect(foldSquashed("I", "latin", (t) => t.toLocaleLowerCase("tr"))).toBe("ı");
  });
});
