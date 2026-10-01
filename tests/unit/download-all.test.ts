import { describe, expect, it } from "vitest";
import { confidentMatch } from "../../client/src/hooks/use-download-all";
import { spotifyFileName } from "../../shared/spotify-names";
import type { SearchResult } from "../../shared/schema";

const result = (id: string, duration: number | null): SearchResult => ({
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  title: id,
  channel: "Someone",
  duration,
  thumbnail: "",
  official: true,
});

describe("confidentMatch", () => {
  it("takes the best match when it's the same length as the song on Spotify", () => {
    const best = result("aaaaaaaaaaa", 356);
    expect(confidentMatch([best, result("bbbbbbbbbbb", 354)], 354)).toBe(best);
    expect(confidentMatch([result("aaaaaaaaaaa", 349)], 354)?.id).toBe("aaaaaaaaaaa");
  });

  it("takes nothing when the best match isn't — even if a worse one is", () => {
    expect(confidentMatch([result("aaaaaaaaaaa", 400), result("bbbbbbbbbbb", 354)], 354)).toBe(
      undefined,
    );
  });

  it("takes nothing without lengths to compare, or without results", () => {
    expect(confidentMatch([result("aaaaaaaaaaa", 354)], null)).toBeUndefined();
    expect(confidentMatch([result("aaaaaaaaaaa", null)], 354)).toBeUndefined();
    expect(confidentMatch([], 354)).toBeUndefined();
  });
});

describe("spotifyFileName", () => {
  it("names a song “Artists - Title”, without release notes or featured artists in the title", () => {
    expect(
      spotifyFileName({ title: "Bohemian Rhapsody - Remastered 2011", artists: "Queen" }),
    ).toBe("Queen - Bohemian Rhapsody");
    expect(
      spotifyFileName({
        title: "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
        artists: ["Daft Punk", "Pharrell Williams", "Nile Rodgers"],
      }),
    ).toBe("Daft Punk, Pharrell Williams, Nile Rodgers - Get Lucky");
    expect(spotifyFileName({ title: "Hotel California - Live", artists: "Eagles" })).toBe(
      "Eagles - Hotel California - Live",
    );
  });

  it("is just the title when there are no artists", () => {
    expect(spotifyFileName({ title: "Song", artists: [] })).toBe("Song");
    expect(spotifyFileName({ title: "Song", artists: " " })).toBe("Song");
  });
});
