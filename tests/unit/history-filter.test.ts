import { describe, it, expect } from "vitest";
import {
  filterHistory,
  filterHistoryByTitle,
  highlightParts,
  historySuggestions,
  inHistoryRange,
  matchesSearch,
  searchableText,
} from "../../client/src/lib/history-filter";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const entry = (id: number, title: string, days: number, url = `https://youtu.be/vid${id}`) => ({
  id,
  title,
  url,
  downloadedAt: daysAgo(days),
});

const history = [
  entry(5, "Progression - Ocean Green (2004)", 0.5, "https://www.youtube.com/watch?v=ZW9IMtSVLek"),
  entry(4, "Beyoncé - Halo", 3),
  entry(3, "Daft Punk - Get Lucky (Official Audio)", 12),
  entry(2, "LiSA - 紅蓮華", 45),
  entry(1, "Me at the zoo", 400, "https://www.youtube.com/watch?v=jNQXAC9IVRw"),
];

describe("searchableText", () => {
  it("lowercases and drops accents and punctuation, in any script", () => {
    expect(searchableText("Beyoncé - Halo!")).toBe("beyonce halo");
    expect(searchableText("LiSA — 紅蓮華")).toBe("lisa 紅蓮華");
  });
});

describe("matchesSearch", () => {
  const ocean = history[0];

  it("needs every word, in any order, and partial words count", () => {
    expect(matchesSearch(ocean, "ocean green")).toBe(true);
    expect(matchesSearch(ocean, "green progression")).toBe(true);
    expect(matchesSearch(ocean, "prog ocea")).toBe(true);
    expect(matchesSearch(ocean, "ocean blue")).toBe(false);
  });

  it("ignores case, accents and punctuation", () => {
    expect(matchesSearch(history[1], "BEYONCE")).toBe(true);
    expect(matchesSearch(history[1], "beyoncé, halo")).toBe(true);
    expect(matchesSearch(history[2], "daft-punk")).toBe(true);
  });

  it("finds non-Latin titles", () => {
    expect(matchesSearch(history[3], "紅蓮")).toBe(true);
  });

  it("finds a video by its link or id", () => {
    expect(matchesSearch(history[4], "https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe(true);
    expect(matchesSearch(history[4], "jNQXAC9IVRw")).toBe(true);
    expect(matchesSearch(history[4], "ZW9IMtSVLek")).toBe(false);
  });

  it("matches everything when the search is empty", () => {
    expect(matchesSearch(ocean, "")).toBe(true);
    expect(matchesSearch(ocean, "  - ")).toBe(true);
  });
});

describe("inHistoryRange", () => {
  it("sorts downloads into the past week, the past month, and older", () => {
    expect(inHistoryRange(daysAgo(6.9), "week", NOW)).toBe(true);
    expect(inHistoryRange(daysAgo(7.1), "week", NOW)).toBe(false);
    expect(inHistoryRange(daysAgo(29), "month", NOW)).toBe(true);
    expect(inHistoryRange(daysAgo(31), "month", NOW)).toBe(false);
    expect(inHistoryRange(daysAgo(31), "older", NOW)).toBe(true);
    expect(inHistoryRange(daysAgo(29), "older", NOW)).toBe(false);
    expect(inHistoryRange(daysAgo(1000), "all", NOW)).toBe(true);
  });

  it("only shows unreadable dates under All", () => {
    expect(inHistoryRange("not a date", "all", NOW)).toBe(true);
    expect(inHistoryRange("not a date", "week", NOW)).toBe(false);
    expect(inHistoryRange("not a date", "older", NOW)).toBe(false);
  });
});

describe("filterHistory", () => {
  const ids = (query: string, range: Parameters<typeof filterHistory>[2]) =>
    filterHistory(history, query, range, NOW).map((e) => e.id);

  it("combines the search with the date range, keeping the order", () => {
    expect(ids("", "all")).toEqual([5, 4, 3, 2, 1]);
    expect(ids("", "week")).toEqual([5, 4]);
    expect(ids("", "month")).toEqual([5, 4, 3]);
    expect(ids("", "older")).toEqual([2, 1]);
    expect(ids("a", "older")).toEqual([2, 1]);
    expect(ids("zoo", "week")).toEqual([]);
    expect(ids("zoo", "older")).toEqual([1]);
  });
});

describe("filterHistoryByTitle", () => {
  it("shows exactly the picked song, every time it was downloaded", () => {
    const twice = [entry(7, "Song", 1), entry(6, "Song (Live)", 2), entry(5, "Song", 40)];
    expect(filterHistoryByTitle(twice, "Song", "all", NOW).map((e) => e.id)).toEqual([7, 5]);
    expect(filterHistoryByTitle(twice, "Song", "week", NOW).map((e) => e.id)).toEqual([7]);
  });
});

describe("historySuggestions", () => {
  const list = [
    entry(9, "Progression - Ocean Green (2004)", 0.1),
    entry(8, "Progression - Ocean Green (2004)", 0.2),
    entry(7, "Ocean Eyes - Billie Eilish", 2),
    entry(6, "Blue Ocean Floor", 3),
    entry(5, "Oceans (Where Feet May Fail)", 20),
    entry(4, "Me at the zoo", 400, "https://www.youtube.com/watch?v=jNQXAC9IVRw"),
  ];
  const titles = (query: string, limit?: number) =>
    historySuggestions(list, query, limit).map((s) => s.title);

  it("lists titles starting with the search first, then word starts, newest first", () => {
    expect(titles("ocean")).toEqual([
      "Ocean Eyes - Billie Eilish",
      "Oceans (Where Feet May Fail)",
      "Progression - Ocean Green (2004)",
      "Blue Ocean Floor",
    ]);
  });

  it("lists each song once, counting repeat downloads", () => {
    expect(historySuggestions(list, "green")).toEqual([
      {
        title: "Progression - Ocean Green (2004)",
        count: 2,
        lastDownloadedAt: list[0].downloadedAt,
      },
    ]);
  });

  it("finds a song from its YouTube link", () => {
    expect(titles("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toEqual(["Me at the zoo"]);
  });

  it("suggests nothing for an empty search, and respects the limit", () => {
    expect(titles("")).toEqual([]);
    expect(titles("  ")).toEqual([]);
    expect(titles("o", 2)).toHaveLength(2);
  });
});

describe("highlightParts", () => {
  const marked = (text: string, query: string) =>
    highlightParts(text, query)
      .map((p) => (p.match ? `[${p.text}]` : p.text))
      .join("");

  it("marks each typed word, ignoring case", () => {
    expect(marked("Progression - Ocean Green", "ocean gre")).toBe("Progression - [Ocean] [Gre]en");
    expect(marked("Ocean Eyes", "OCEAN")).toBe("[Ocean] Eyes");
  });

  it("prefers the longest word and leaves text alone when nothing matches", () => {
    expect(marked("Oceans", "o oceans")).toBe("[Oceans]");
    expect(marked("Halo", "zzz")).toBe("Halo");
    expect(marked("Halo", "")).toBe("Halo");
  });

  it("treats regex characters as plain text", () => {
    expect(marked("What? (Remix) [2019]", "(remix) [2019")).toBe("What? ([Remix]) [[2019]]");
  });

  it("marks every place a word appears, in any script", () => {
    expect(marked("Ocean to ocean", "ocean")).toBe("[Ocean] to [ocean]");
    expect(marked("LiSA - 紅蓮華", "紅蓮")).toBe("LiSA - [紅蓮]華");
    expect(marked("Progression", "gre")).toBe("Pro[gre]ssion"); // only inside a word: still marked
  });
});
