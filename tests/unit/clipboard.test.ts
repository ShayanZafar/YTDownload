import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canReadClipboard,
  clipboardPermission,
  findCopiedLink,
  pasteKeys,
  textToPaste,
} from "../../client/src/lib/clipboard";

const ID = "jNQXAC9IVRw";
const SONG = "4uLU6hMCjMI75M1A2tKUQC";

describe("findCopiedLink", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}?si=AbCdEf123`,
    `https://m.youtube.com/watch?v=${ID}&t=42s`,
    `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/live/${ID}?feature=share`,
    `http://youtube.com/watch?feature=shared&v=${ID}`,
  ])("finds the YouTube video in %s", (text) => {
    expect(findCopiedLink(text)).toEqual({
      kind: "youtube",
      url: text,
      key: `youtube:${ID}`,
      label: `youtu.be/${ID}`,
    });
  });

  it("adds https:// to a link copied without it", () => {
    expect(findCopiedLink(`youtu.be/${ID}`)).toEqual({
      kind: "youtube",
      url: `https://youtu.be/${ID}`,
      key: `youtube:${ID}`,
      label: `youtu.be/${ID}`,
    });
    expect(findCopiedLink(`www.youtube.com/watch?v=${ID}`)?.url).toBe(
      `https://www.youtube.com/watch?v=${ID}`,
    );
  });

  it("finds the link in a message shared from an app, without the punctuation around it", () => {
    const link = `https://youtu.be/${ID}?si=x`;
    expect(findCopiedLink(`Check this out!\n${link}. So good`)?.url).toBe(link);
    expect(findCopiedLink(`(${link})`)?.url).toBe(link);
    expect(findCopiedLink(`<${link}>,`)?.url).toBe(link);
    expect(findCopiedLink(`“${link}”`)?.url).toBe(link);
    expect(findCopiedLink(`\t  ${link}  \r\n`)?.url).toBe(link);
  });

  it("gives every link to the same video the same key", () => {
    const keys = [
      `https://youtu.be/${ID}`,
      `https://www.youtube.com/watch?v=${ID}&t=5`,
      `music.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
    ].map((text) => findCopiedLink(text)?.key);
    expect(new Set(keys)).toEqual(new Set([`youtube:${ID}`]));
  });

  it("finds Spotify songs, playlists and albums — the links the box opens", () => {
    const song = `https://open.spotify.com/track/${SONG}?si=abc`;
    expect(findCopiedLink(`Listen to this on Spotify: ${song}`)).toEqual({
      kind: "spotify",
      url: song,
      key: `spotify:track:${SONG}`,
      label: `spotify.com/track/${SONG}`,
    });
    expect(
      findCopiedLink("https://open.spotify.com/intl-de/playlist/37i9dQZF1DXcBWIGoYBM5M")?.key,
    ).toBe("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M");
    expect(findCopiedLink("spotify:album:1DFixLWuPkv3KT3TnV35m3")?.key).toBe(
      "spotify:album:1DFixLWuPkv3KT3TnV35m3",
    );
    expect(findCopiedLink(`open.spotify.com/track/${SONG}`)?.key).toBe(`spotify:track:${SONG}`);
  });

  it("finds Spotify's short links, which lead to a song, playlist or album", () => {
    expect(findCopiedLink("Listen on Spotify: https://spotify.link/AbCdEfGhIj")).toEqual({
      kind: "spotify",
      url: "https://spotify.link/AbCdEfGhIj",
      key: "spotify:short:AbCdEfGhIj",
      label: "spotify.link/AbCdEfGhIj",
    });
    expect(findCopiedLink("spotify.app.link/x9Y_z-1?_p=c")?.url).toBe(
      "https://spotify.app.link/x9Y_z-1?_p=c",
    );
    expect(findCopiedLink("https://spotify.link/")).toBeUndefined();
    expect(findCopiedLink("https://other.app.link/AbCdEfGhIj")).toBeUndefined();
  });

  it("takes the first link when there are several", () => {
    const song = `https://open.spotify.com/track/${SONG}`;
    const video = `https://youtu.be/${ID}`;
    expect(findCopiedLink(`${video} or ${song}`)?.kind).toBe("youtube");
    expect(findCopiedLink(`${song} or ${video}`)?.kind).toBe("spotify");
  });

  it.each([
    "",
    "   \n ",
    "daft punk one more time",
    "https://vimeo.com/76979871",
    "https://www.youtube.com/@YouTube",
    "https://www.youtube.com/playlist?list=PLbpi6ZahtOH6Blw3RGYpWkSByi_T7Rygb",
    `https://www.youtube.com/watch?v=${ID.slice(0, 10)}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtube.com.example.com/watch?v=${ID}`,
    `https://example.com/?next=https://youtu.be/${ID}`,
    `javascript:alert('https://youtu.be/${ID}')`,
    "https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg",
    "https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ",
  ])("finds no link the box opens in %j", (text) => {
    expect(findCopiedLink(text)).toBeUndefined();
  });

  it("looks only at the start of a very long text", () => {
    expect(findCopiedLink(`${"word ".repeat(2_000)}https://youtu.be/${ID}`)).toBeUndefined();
  });
});

describe("textToPaste", () => {
  it("puts copied text on one line, trimmed", () => {
    expect(textToPaste("  daft punk\r\n one   more time\t")).toBe("daft punk one more time");
  });

  it("is empty when nothing but spaces was copied", () => {
    expect(textToPaste(" \n\t ")).toBe("");
  });

  it("cuts long text short", () => {
    expect(textToPaste("a".repeat(1_000))).toHaveLength(300);
  });
});

describe("a copied link's label", () => {
  it("is short, and the same for every link to that video or song", () => {
    expect(findCopiedLink(`https://www.youtube.com/watch?v=${ID}&si=share&t=10`)?.label).toBe(
      `youtu.be/${ID}`,
    );
    expect(findCopiedLink(`https://open.spotify.com/intl-fr/album/${SONG}?si=1`)?.label).toBe(
      `spotify.com/album/${SONG}`,
    );
    expect(findCopiedLink(`spotify:track:${SONG}`)?.label).toBe(`spotify.com/track/${SONG}`);
  });
});

describe("pasteKeys", () => {
  it.each([
    ["MacIntel", "⌘V"],
    ["iPad", "⌘V"],
    ["iPhone", "⌘V"],
    ["Win32", "Ctrl+V"],
    ["Linux x86_64", "Ctrl+V"],
    ["", "Ctrl+V"],
  ])("on %j is %s", (platform, keys) => {
    expect(pasteKeys(platform)).toBe(keys);
  });
});

// The browser's side, stood in for: the page in a secure context or not, with
// or without the Clipboard API and the clipboard-read permission.
describe("reading the clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const browser = ({ secure = true, readText = true, query = undefined as unknown }) => {
    vi.stubGlobal("window", { isSecureContext: secure });
    vi.stubGlobal("navigator", {
      clipboard: readText ? { readText: () => Promise.resolve("") } : undefined,
      permissions: query === undefined ? undefined : { query },
    });
  };

  it("is possible in a secure context with the Clipboard API", () => {
    browser({});
    expect(canReadClipboard()).toBe(true);
  });

  it("isn't over plain http from another device, or without the Clipboard API", () => {
    browser({ secure: false });
    expect(canReadClipboard()).toBe(false);
    browser({ readText: false });
    expect(canReadClipboard()).toBe(false);
  });

  it("asks for the clipboard-read permission, as Chrome and Edge know it", async () => {
    const query = vi.fn(() => Promise.resolve({ name: "clipboard-read", state: "granted" }));
    browser({ query });
    expect(await clipboardPermission()).toMatchObject({ state: "granted" });
    expect(query).toHaveBeenCalledWith({ name: "clipboard-read" });
  });

  it("has no permission to go by where every read is confirmed (Firefox, Safari)", async () => {
    browser({ query: () => Promise.reject(new TypeError("Not a permission this browser knows")) });
    expect(await clipboardPermission()).toBeNull();
    browser({});
    expect(await clipboardPermission()).toBeNull();
  });
});
