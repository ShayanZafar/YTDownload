import { describe, it, expect } from "vitest";
import {
  asLink,
  formatBytes,
  formatDuration,
  isSpotifyLink,
  isSpotifyShortLink,
  isSpotifyPlaylistLink,
} from "../../client/src/lib/format";

describe("formatDuration", () => {
  it("formats like a clock", () => {
    expect(formatDuration(19)).toBe("0:19");
    expect(formatDuration(369)).toBe("6:09");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("rounds fractions and never goes negative", () => {
    expect(formatDuration(247.6)).toBe("4:08");
    expect(formatDuration(-5)).toBe("0:00");
  });
});

describe("asLink", () => {
  it("keeps full links", () => {
    expect(asLink(" https://www.youtube.com/watch?v=jNQXAC9IVRw ")).toBe(
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    );
    expect(asLink("http://example.com/x")).toBe("http://example.com/x");
  });

  it("adds https:// to YouTube links typed without it", () => {
    expect(asLink("youtu.be/jNQXAC9IVRw")).toBe("https://youtu.be/jNQXAC9IVRw");
    expect(asLink("www.youtube.com/watch?v=jNQXAC9IVRw")).toBe(
      "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    );
    expect(asLink("music.youtube.com/watch?v=jNQXAC9IVRw")).toBe(
      "https://music.youtube.com/watch?v=jNQXAC9IVRw",
    );
  });

  it("treats everything else as search text", () => {
    expect(asLink("daft punk get lucky")).toBeUndefined();
    expect(asLink("youtube")).toBeUndefined();
    expect(asLink("Blink-182")).toBeUndefined();
    expect(asLink("https://example.com with spaces")).toBeUndefined();
    expect(asLink("   ")).toBeUndefined();
  });
});

describe("isSpotifyShortLink", () => {
  it("spots the Spotify app's short links", () => {
    expect(isSpotifyShortLink("https://spotify.link/AbCdEf")).toBe(true);
    expect(isSpotifyShortLink(" spotify.link/AbCdEf/ ")).toBe(true);
    expect(isSpotifyShortLink("https://spotify.app.link/x9Y_z-1?_p=c")).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(isSpotifyShortLink("https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv")).toBe(false);
    expect(isSpotifyShortLink("https://spotify.link/")).toBe(false);
    expect(isSpotifyShortLink("https://spotify.link.evil.example/AbCdEf")).toBe(false);
    expect(isSpotifyShortLink("spotify link")).toBe(false);
  });
});

describe("isSpotifyLink", () => {
  it("spots Spotify links and URIs", () => {
    expect(isSpotifyLink("https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv?si=x")).toBe(true);
    expect(isSpotifyLink("open.spotify.com/intl-de/track/4u7EnebtmKWzUH433cf5Qv")).toBe(true);
    expect(isSpotifyLink("spotify:track:4u7EnebtmKWzUH433cf5Qv")).toBe(true);
    expect(isSpotifyLink("https://spotify.link/AbCdEf")).toBe(true);
  });

  it("leaves YouTube links and search text alone", () => {
    expect(isSpotifyLink("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toBe(false);
    expect(isSpotifyLink("spotify top songs")).toBe(false);
    expect(isSpotifyLink("https://open.spotify.com.evil.example/track/x")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("shows sizes the way people read them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(150 * 1024)).toBe("150 KB");
    expect(formatBytes(2_457_600)).toBe("2.3 MB");
  });
});

describe("isSpotifyPlaylistLink", () => {
  it("spots playlist and album links, which open in the playlist panel", () => {
    for (const link of [
      "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1234",
      "open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M",
      "https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa",
      "https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M",
      " spotify:playlist:37i9dQZF1DXcBWIGoYBM5M ",
    ]) {
      expect(isSpotifyPlaylistLink(link), link).toBe(true);
    }
  });

  it("leaves songs, other Spotify pages and everything else to the search", () => {
    for (const text of [
      "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
      "https://open.spotify.com/artist/1dfeR4HaWDbWqFHLkxsg1d",
      "https://open.spotify.com/playlist/short",
      "https://open.spotify.com.evil.example/playlist/37i9dQZF1DXcBWIGoYBM5M",
      "road trip playlist",
    ]) {
      expect(isSpotifyPlaylistLink(text), text).toBe(false);
    }
  });
});
