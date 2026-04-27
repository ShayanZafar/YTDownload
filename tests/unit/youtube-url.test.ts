import { describe, it, expect } from "vitest";
import { extractVideoId, pickThumbnail } from "../../server/youtube-url";

describe("extractVideoId", () => {
  describe("valid URLs", () => {
    it.each([
      ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://m.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://music.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["http://www.youtube.com/watch?v=jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://youtu.be/jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://youtu.be/jNQXAC9IVRw?t=30", "jNQXAC9IVRw"],
      ["https://www.youtube.com/shorts/jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://www.youtube.com/embed/jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://www.youtube.com/v/jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://www.youtube.com/live/jNQXAC9IVRw", "jNQXAC9IVRw"],
      ["https://www.youtube.com/watch?v=jNQXAC9IVRw&feature=share", "jNQXAC9IVRw"],
      ["https://www.youtube.com/watch?feature=share&v=jNQXAC9IVRw", "jNQXAC9IVRw"],
    ])("parses %s", (url, expected) => {
      expect(extractVideoId(url)).toBe(expected);
    });
  });

  describe("invalid URLs", () => {
    it.each([
      ["empty string", ""],
      ["not a URL", "hello world"],
      ["non-YouTube host", "https://vimeo.com/12345"],
      ["YouTube but no ID", "https://www.youtube.com/"],
      ["YouTube watch with empty v", "https://www.youtube.com/watch?v="],
      ["YouTube watch with too-short ID", "https://www.youtube.com/watch?v=abc"],
      ["YouTube watch with too-long ID", "https://www.youtube.com/watch?v=jNQXAC9IVRwTOOLONG"],
      ["YouTube watch with bad chars", "https://www.youtube.com/watch?v=abc!@#$%^&*"],
      ["youtu.be with too-short ID", "https://youtu.be/abc"],
      ["javascript: protocol", "javascript:alert(1)"],
      ["ftp://", "ftp://www.youtube.com/watch?v=jNQXAC9IVRw"],
      ["look-alike domain", "https://youtube.com.evil.com/watch?v=jNQXAC9IVRw"],
    ])("rejects %s", (_label, url) => {
      expect(extractVideoId(url)).toBeNull();
    });

    it("rejects non-string input", () => {
      // @ts-expect-error — deliberately testing wrong-type input
      expect(extractVideoId(null)).toBeNull();
      // @ts-expect-error — deliberately testing wrong-type input
      expect(extractVideoId(undefined)).toBeNull();
      // @ts-expect-error — deliberately testing wrong-type input
      expect(extractVideoId(123)).toBeNull();
    });
  });
});

describe("pickThumbnail", () => {
  it("returns highest-width thumbnail when multiple are present", () => {
    const result = pickThumbnail({
      thumbnails: [
        { url: "low.jpg", width: 120 },
        { url: "high.jpg", width: 1280 },
        { url: "mid.jpg", width: 480 },
      ],
    });
    expect(result).toBe("high.jpg");
  });

  it("treats missing width as 0", () => {
    const result = pickThumbnail({
      thumbnails: [{ url: "no-width.jpg" }, { url: "with-width.jpg", width: 100 }],
    });
    expect(result).toBe("with-width.jpg");
  });

  it("falls back to single thumbnail field when thumbnails array is empty", () => {
    expect(pickThumbnail({ thumbnail: "fallback.jpg", thumbnails: [] })).toBe("fallback.jpg");
  });

  it("falls back to single thumbnail field when thumbnails array is missing", () => {
    expect(pickThumbnail({ thumbnail: "fallback.jpg" })).toBe("fallback.jpg");
  });

  it("returns empty string when nothing is provided", () => {
    expect(pickThumbnail({})).toBe("");
  });

  it("does not mutate the input array", () => {
    const thumbnails = [
      { url: "a.jpg", width: 100 },
      { url: "b.jpg", width: 500 },
    ];
    const snapshot = JSON.stringify(thumbnails);
    pickThumbnail({ thumbnails });
    expect(JSON.stringify(thumbnails)).toBe(snapshot);
  });
});
