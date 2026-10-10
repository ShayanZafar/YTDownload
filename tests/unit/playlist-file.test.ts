import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  PLAYLIST_FILE_MARK,
  isAppPlaylistFile,
  playlistEntries,
  playlistFileName,
  playlistFileText,
  writePlaylistFile,
} from "../../server/playlist-file";
import { FolderError } from "../../server/folders";

describe("playlistFileName", () => {
  it("is the playlist's name, safe on every system, as .m3u8", () => {
    expect(playlistFileName("Road Trip")).toBe("Road Trip.m3u8");
    expect(playlistFileName("AC/DC: Best Of?")).toBe("AC-DC - Best Of.m3u8");
    expect(playlistFileName("   ")).toBe("Playlist.m3u8");
  });
});

describe("playlistEntries", () => {
  it("lists the found songs in the playlist's order, each file once", () => {
    const songs = [
      { id: "a", title: "One", artists: "X", duration: 60 },
      { id: "b", title: "Two", artists: "Y" },
      { id: "c", title: "Three", artists: "Z" },
      { id: "a", title: "One", artists: "X", duration: 60 },
      { id: "d", title: "Three (again)", artists: "Z" },
    ];
    const found = {
      a: { file: "x/One.mp3" },
      c: { file: "Three.opus" },
      d: { file: "Three.opus" },
    };
    expect(playlistEntries(songs, found)).toEqual([
      { file: "x/One.mp3", title: "One", artists: "X", duration: 60 },
      { file: "Three.opus", title: "Three", artists: "Z", duration: undefined },
    ]);
  });
});

describe("playlistFileText", () => {
  it("names the playlist, then each song's length, name and place", () => {
    const text = playlistFileText(
      "Mix",
      [
        {
          file: path.join("Queen", "Bohemian Rhapsody.mp3"),
          title: "Bohemian Rhapsody",
          artists: "Queen",
          duration: 354.4,
        },
        { file: "Untitled.opus", title: "Untitled", artists: "", duration: null },
      ],
      "\n",
    );
    expect(text).toBe(
      [
        "#EXTM3U",
        "#PLAYLIST:Mix",
        PLAYLIST_FILE_MARK,
        "#EXTINF:354,Queen - Bohemian Rhapsody",
        path.join("Queen", "Bohemian Rhapsody.mp3"),
        "#EXTINF:-1,Untitled",
        "Untitled.opus",
        "",
      ].join("\n"),
    );
  });

  it("keeps everything a song says on its own line, and a file named #… from being a comment", () => {
    const text = playlistFileText(
      "Two\nLines",
      [{ file: "#1 Hit.mp3", title: "Bad\r\nC:\\evil.mp3", artists: "A", duration: 1 }],
      "\n",
    );
    const lines = text.split("\n");
    expect(lines).toContain("#PLAYLIST:Two Lines");
    expect(lines).toContain("#EXTINF:1,A - Bad C:\\evil.mp3");
    expect(lines).toContain(`.${path.sep}#1 Hit.mp3`);
    expect(lines).not.toContain("C:\\evil.mp3");
  });
});

describe("writePlaylistFile", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-playlist-file-"));
    // Not real audio: files that aren't readable still count by their names.
    await fs.mkdir(path.join(dir, "Queen"));
    await fs.writeFile(path.join(dir, "Queen", "Queen - Bohemian Rhapsody.mp3"), "x");
    await fs.writeFile(path.join(dir, "Daft Punk - One More Time.opus"), "x");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const songs = [
    { id: "4u7EnebtmKWzUH433cf5Qv", title: "Bohemian Rhapsody", artists: "Queen", duration: 354 },
    { id: "0DiWol3AO6WpXZgp0goxAV", title: "One More Time", artists: "Daft Punk", duration: 320 },
    { id: "3n3Ppam7vgaVa1iaRUc9Lp", title: "Not Downloaded", artists: "Someone", duration: 200 },
  ];

  it("writes the found songs into the folder, and updates its own file when saved again", async () => {
    const saved = await writePlaylistFile(dir, "Road Trip", songs);
    expect(saved).toEqual({ file: "Road Trip.m3u8", songs: 2, missing: 1, replaced: false });
    const file = path.join(dir, "Road Trip.m3u8");
    const lines = (await fs.readFile(file, "utf8")).split(os.EOL);
    expect(lines.filter((line) => !line.startsWith("#") && line)).toEqual([
      path.join("Queen", "Queen - Bohemian Rhapsody.mp3"),
      "Daft Punk - One More Time.opus",
    ]);
    expect(await isAppPlaylistFile(file)).toBe(true);

    const again = await writePlaylistFile(dir, "Road Trip", songs.slice(1));
    expect(again).toEqual({ file: "Road Trip.m3u8", songs: 1, missing: 1, replaced: true });
    expect(await fs.readFile(file, "utf8")).not.toMatch(/Bohemian/);
    // Nothing left over from writing it.
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("never replaces a playlist file it didn't write", async () => {
    const theirs = path.join(dir, "Favourites.m3u8");
    await fs.writeFile(theirs, "#EXTM3U\nsomething.mp3\n");
    expect(await isAppPlaylistFile(theirs)).toBe(false);

    const saved = await writePlaylistFile(dir, "Favourites", songs);
    expect(saved.file).toBe("Favourites (1).m3u8");
    expect(await fs.readFile(theirs, "utf8")).toBe("#EXTM3U\nsomething.mp3\n");

    // Saved again: the app's own "Favourites (1).m3u8" is brought up to date.
    const again = await writePlaylistFile(dir, "Favourites", songs.slice(0, 1));
    expect(again).toMatchObject({ file: "Favourites (1).m3u8", songs: 1, replaced: true });
    expect(await fs.readFile(theirs, "utf8")).toBe("#EXTM3U\nsomething.mp3\n");
    expect(await fs.readFile(path.join(dir, "Favourites (1).m3u8"), "utf8")).not.toMatch(/Daft/);
  });

  it("refuses when none of the songs are in the folder", async () => {
    await expect(writePlaylistFile(dir, "Nothing", songs.slice(2))).rejects.toBeInstanceOf(
      FolderError,
    );
    await expect(fs.stat(path.join(dir, "Nothing.m3u8"))).rejects.toThrow();
  });
});
