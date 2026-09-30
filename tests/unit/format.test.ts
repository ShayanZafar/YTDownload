import { describe, it, expect } from "vitest";
import { asLink, formatDuration } from "../../client/src/lib/format";

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
