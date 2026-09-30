import { describe, it, expect } from "vitest";
import { MAX_FILE_NAME_LENGTH, safeFileName } from "../../shared/filename";

describe("safeFileName", () => {
  it("keeps ordinary titles as they are, accents and all", () => {
    expect(safeFileName("Me at the zoo")).toBe("Me at the zoo");
    expect(safeFileName("Beyoncé - Halo")).toBe("Beyoncé - Halo");
    expect(safeFileName("Guns N' Roses - Sweet Child O' Mine (Official)")).toBe(
      "Guns N' Roses - Sweet Child O' Mine (Official)",
    );
    expect(safeFileName("LiSA - 紅蓮華 [Lyrics]")).toBe("LiSA - 紅蓮華 [Lyrics]");
  });

  it("replaces what Windows can't store in a file name", () => {
    expect(safeFileName("AC/DC - Back In Black")).toBe("AC-DC - Back In Black");
    expect(safeFileName("Title: Subtitle")).toBe("Title - Subtitle");
    expect(safeFileName("Song | Artist")).toBe("Song - Artist");
    expect(safeFileName('He said "hi"? <3 *')).toBe("He said hi 3");
    expect(safeFileName("Tab\there\nand newline")).toBe("Tab here and newline");
  });

  it("drops a typed extension and dots or spaces at the ends", () => {
    expect(safeFileName("Get Lucky.mp3")).toBe("Get Lucky");
    expect(safeFileName("Get Lucky.MP3.mp3")).toBe("Get Lucky");
    expect(safeFileName("  ...Hidden...  ")).toBe("Hidden");
    expect(safeFileName("Version 2.0")).toBe("Version 2.0");
  });

  it("avoids Windows' reserved device names", () => {
    expect(safeFileName("CON")).toBe("CON_");
    expect(safeFileName("nul.mp3")).toBe("nul_");
    expect(safeFileName("Console")).toBe("Console");
  });

  it("shortens very long names without splitting characters", () => {
    const name = safeFileName("😀".repeat(200));
    expect(Array.from(name)).toHaveLength(MAX_FILE_NAME_LENGTH);
    expect(name).toBe("😀".repeat(MAX_FILE_NAME_LENGTH));
  });

  it("falls back when nothing usable is left", () => {
    expect(safeFileName("")).toBe("audio");
    expect(safeFileName("???")).toBe("audio");
    expect(safeFileName(" . ", "untitled")).toBe("untitled");
  });

  it("gives the same answer when run twice, so the page and the server agree", () => {
    for (const name of ["AC/DC: Live | 1991?", "Song.mp3.mp3", "CON", " a . ", "x".repeat(400)]) {
      expect(safeFileName(safeFileName(name))).toBe(safeFileName(name));
    }
  });
});
