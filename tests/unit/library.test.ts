import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  MAX_SONG_FILES,
  artistWords,
  findAudioFiles,
  findSongs,
  readSongFiles,
  songsInFolder,
  spotifyIdsInTags,
  tagsFrom,
  titleWords,
  words,
  type SongFile,
} from "../../server/library";
import { FFMPEG_PATH, audioOutput, type AudioMetadata } from "../../server/audio";

const ids = {
  bohemian: "4u7EnebtmKWzUH433cf5Qv",
  getLucky: "2Foc5Q5nqNiosCNqttzHof",
  billieJean: "5ChkMS8OtdzJeqyybCc9R5",
  africa: "2374M0fQpWi3dLnB54qaLX",
  maneater: "0W4Kpfp1w2xkY3PrV714B7",
  backInBlack: "08mG3Y1vljYA6bvDt4Wqkj",
  holiday: "1Xb9Ha5u5nDJbI4NQ5lWw3",
  thriller: "3S2R0EVwBSAVMd5UMgKTL0",
  heaven: "7gpjS3H9Ip0tPfeKrNG3Yf",
  foreverYoung: "1Nc5o7TQmQ0E0nkzYzGXlb",
  yoasobi: "3dPtXHP0oXQ4HCWHsOA9js",
  sweetDreams: "1TfqLAPs4K3s2rJMoCokcS",
};

describe("words", () => {
  it("keeps letters and digits in any alphabet, without accents or punctuation", () => {
    expect(words("Beyoncé — Halo!")).toBe("beyonce halo");
    expect(words("AC/DC: Back In Black")).toBe("ac dc back in black");
    expect(words("YOASOBI「夜に駆ける」")).toBe("yoasobi 夜に駆ける");
    expect(words("  ")).toBe("");
  });
});

describe("titleWords", () => {
  it("drops versions, features and other extras a file name may not have", () => {
    expect(titleWords("Bohemian Rhapsody - Remastered 2011")).toBe("bohemian rhapsody");
    expect(titleWords("Get Lucky (feat. Pharrell Williams and Nile Rodgers)")).toBe("get lucky");
    expect(titleWords("Sweet Dreams (Are Made of This) - 2005 Remaster")).toBe("sweet dreams");
    expect(titleWords('Holding Out for a Hero - From "Footloose" Soundtrack')).toBe(
      "holding out for a hero",
    );
    expect(titleWords("(Untitled)")).toBe("untitled");
  });
});

describe("artistWords", () => {
  it("lists every artist, and the members of a duo on their own", () => {
    expect(artistWords("Daft Punk, Pharrell Williams")).toEqual(["daft punk", "pharrell williams"]);
    expect(artistWords("Daryl Hall & John Oates")).toEqual([
      "daryl hall john oates",
      "daryl hall",
      "john oates",
    ]);
    expect(artistWords("AC/DC")).toEqual(["ac dc"]);
  });
});

describe("spotifyIdsInTags", () => {
  it("reads this app's own spotify_id tag in MP3, Ogg and Matroska files", () => {
    expect(
      spotifyIdsInTags({ "ID3v2.3": [{ id: "TXXX:spotify_id", value: ids.bohemian }] }),
    ).toEqual([ids.bohemian]);
    expect(spotifyIdsInTags({ vorbis: [{ id: "SPOTIFY_ID", value: ids.africa }] })).toEqual([
      ids.africa,
    ]);
    expect(
      spotifyIdsInTags({ matroska: [{ id: "track:SPOTIFY_ID", value: ids.holiday }] }),
    ).toEqual([ids.holiday]);
  });

  it("finds a song link anywhere, even split at its slashes as ID3v2.3 does", () => {
    const split = ["https:", "", "open.spotify.com", "track", ids.billieJean];
    expect(
      spotifyIdsInTags({
        "ID3v2.3": split.map((value) => ({ id: "TXXX:comment", value })),
      }),
    ).toEqual([ids.billieJean]);
    expect(
      spotifyIdsInTags({
        iTunes: [
          { id: "©cmt", value: `https://open.spotify.com/intl-de/track/${ids.maneater}?si=x` },
        ],
        "ID3v2.4": [
          { id: "COMM", value: { language: "eng", text: `spotify:track:${ids.getLucky}` } },
          { id: "WOAS", value: { url: `https://open.spotify.com/track/${ids.africa}` } },
        ],
      }).sort(),
    ).toEqual([ids.africa, ids.getLucky, ids.maneater].sort());
  });

  it("ignores other ids and tags that aren't songs", () => {
    expect(
      spotifyIdsInTags({
        vorbis: [
          { id: "SPOTIFY_ALBUM_ID", value: ids.thriller },
          { id: "COMMENT", value: `https://open.spotify.com/album/${ids.thriller}` },
          { id: "TITLE", value: ids.heaven },
          { id: "PICTURE", value: { data: new Uint8Array(4) } },
        ],
      }),
    ).toEqual([]);
  });
});

describe("tagsFrom", () => {
  const noNumbers = {
    track: { no: null, of: null },
    disk: { no: null, of: null },
    movementIndex: { no: null, of: null },
  };

  it("joins the artists and album artist, and reads the Spotify song", () => {
    expect(
      tagsFrom({
        common: {
          title: " Get Lucky ",
          artists: ["Daft Punk", "Pharrell Williams"],
          albumartist: "Daft Punk",
          album: "Random Access Memories ",
          ...noNumbers,
        },
        native: { "ID3v2.3": [{ id: "TXXX:spotify_id", value: ids.getLucky }] },
        format: { duration: 248.4 },
      }),
    ).toEqual({
      title: "Get Lucky",
      artist: "Daft Punk, Pharrell Williams / Daft Punk",
      spotifyIds: [ids.getLucky],
      // What the music player shows.
      trackArtist: "Daft Punk, Pharrell Williams",
      album: "Random Access Memories",
      duration: 248.4,
    });
  });

  it("shows the album artist when there's no artist, and no length it can't trust", () => {
    const tags = tagsFrom({
      common: { title: "Intro", albumartist: "Various Artists", ...noNumbers },
      native: {},
      format: { duration: Number.NaN },
    });
    expect(tags.trackArtist).toBe("Various Artists");
    expect(tags.duration).toBeUndefined();
    expect(tagsFrom({ common: noNumbers, native: {} })).toEqual({ spotifyIds: [] });
  });
});

describe("findSongs", () => {
  const song = (id: string, title: string, artists: string) => ({ id, title, artists });
  const songs = [
    song(ids.bohemian, "Bohemian Rhapsody - Remastered 2011", "Queen"),
    song(
      ids.getLucky,
      "Get Lucky (feat. Pharrell Williams and Nile Rodgers)",
      "Daft Punk, Pharrell Williams, Nile Rodgers",
    ),
    song(ids.billieJean, "Billie Jean", "Michael Jackson"),
    song(ids.africa, "Africa", "TOTO"),
    song(ids.maneater, "Maneater", "Daryl Hall & John Oates"),
    song(ids.backInBlack, "Back In Black", "AC/DC"),
    song(ids.holiday, "Holiday", "Madonna"),
    song(ids.thriller, "Thriller", "Michael Jackson"),
    song(ids.heaven, "Heaven", "Bryan Adams"),
    song(ids.foreverYoung, "Forever Young", "Alphaville"),
    song(ids.yoasobi, "夜に駆ける", "YOASOBI"),
    song(
      ids.sweetDreams,
      "Sweet Dreams (Are Made of This) - 2005 Remaster",
      "Eurythmics, Annie Lennox, Dave Stewart",
    ),
  ];
  const file = (p: string, tags: Partial<SongFile> = {}): SongFile => ({
    path: p,
    spotifyIds: [],
    ...tags,
  });
  const files = [
    // Renamed and re-tagged, but it carries the Spotify song (this app's files do).
    file("My favourite.mp3", { title: "Something", artist: "Someone", spotifyIds: [ids.bohemian] }),
    // A YouTube video's name, saved twice.
    file("Daft Punk - Get Lucky (Official Audio) (1).mp3"),
    // The artist only in the tags, as a VEVO channel's name.
    file("Billie Jean.mp3", { title: "Billie Jean", artist: "MichaelJacksonVEVO" }),
    file(path.join("Downloads", "Africa.opus"), { title: "Africa", artist: "TOTO - Topic" }),
    // No tags, the duo shortened in the folder's name: named just like the song.
    file(path.join("Hall & Oates", "Maneater.m4a")),
    file("ACDC - Back In Black.mp3"),
    // Same title, someone else's song.
    file("Green Day - Holiday.mp3", { title: "Holiday", artist: "Green Day" }),
    // Another song from the album "Thriller": the folder's name isn't the song.
    file(path.join("Michael Jackson", "Thriller", "01 Wanna Be Startin' Somethin'.mp3"), {
      title: "Wanna Be Startin' Somethin'",
      artist: "Michael Jackson",
    }),
    file("Heaven.mp3", { title: "Heaven", artist: "Talking Heads" }),
    file("07 Forever Young.flac"),
    file("YOASOBI - 夜に駆ける.opus"),
    file("Eurythmics - Sweet Dreams (Are Made of This) [2018 Remastered].mp3"),
  ];

  it("recognises songs by their Spotify id, title and artist, or exact name", () => {
    const found = findSongs(songs, files);
    expect(found).toEqual({
      [ids.bohemian]: { file: "My favourite.mp3", by: "spotify" },
      [ids.getLucky]: {
        file: "Daft Punk - Get Lucky (Official Audio) (1).mp3",
        by: "title-artist",
      },
      [ids.billieJean]: { file: "Billie Jean.mp3", by: "title-artist" },
      [ids.africa]: { file: path.join("Downloads", "Africa.opus"), by: "title-artist" },
      [ids.maneater]: { file: path.join("Hall & Oates", "Maneater.m4a"), by: "title" },
      [ids.backInBlack]: { file: "ACDC - Back In Black.mp3", by: "title-artist" },
      [ids.foreverYoung]: { file: "07 Forever Young.flac", by: "title" },
      [ids.yoasobi]: { file: "YOASOBI - 夜に駆ける.opus", by: "title-artist" },
      [ids.sweetDreams]: {
        file: "Eurythmics - Sweet Dreams (Are Made of This) [2018 Remastered].mp3",
        by: "title-artist",
      },
    });
    // Not there: Madonna's "Holiday", "Thriller" and Bryan Adams' "Heaven".
    expect(found[ids.holiday]).toBeUndefined();
    expect(found[ids.thriller]).toBeUndefined();
    expect(found[ids.heaven]).toBeUndefined();
  });

  it("prefers the file that carries the Spotify song", () => {
    const found = findSongs(
      [song(ids.africa, "Africa", "TOTO")],
      [file("TOTO - Africa.mp3"), file("a.mp3", { spotifyIds: [ids.africa] })],
    );
    expect(found[ids.africa]).toEqual({ file: "a.mp3", by: "spotify" });
  });

  it("finds nothing in an empty folder", () => {
    expect(findSongs(songs, [])).toEqual({});
  });
});

// --- Real files --------------------------------------------------------------------

/** Runs ffmpeg with `args`, feeding it `input`; resolves with what it wrote. */
function ffmpeg(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH!, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err}`)),
    );
    child.stdin.end(input);
  });
}

/** A second of tone in a format YouTube serves: Opus in WebM, or AAC in (fragmented) MP4. */
const source = (acodec: string) =>
  ffmpeg([
    ...["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1"],
    ...(acodec === "opus"
      ? ["-c:a", "libopus", "-f", "webm"]
      : ["-c:a", "aac", "-f", "mp4", "-movflags", "frag_keyframe+empty_moov"]),
    "pipe:1",
  ]);

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-library-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("files the app saves for a Spotify song", () => {
  // The way the app writes them: YouTube's audio through audioOutput()'s ffmpeg.
  const save = async (
    name: string,
    format: "mp3" | "original",
    acodec: string,
    meta: AudioMetadata,
  ) => {
    const input = await source(acodec);
    const output = audioOutput(format, meta, acodec);
    const file = path.join(root, "saved", `${name}.${output.ext}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // An MP3's tag is written by the app, in front of ffmpeg's audio.
    const audio = await ffmpeg(output.ffmpegArgs, input);
    await fs.writeFile(file, output.prefix ? Buffer.concat([output.prefix, audio]) : audio);
    return path.basename(file);
  };

  it("carry the song in their tags — MP3, .opus and .m4a alike — so a renamed one is still found", async () => {
    const meta = { title: "Bohemian Rhapsody", artist: "Queen" };
    const mp3 = await save("Renamed song", "mp3", "opus", { ...meta, spotifyId: ids.bohemian });
    const opus = await save("Another name", "original", "opus", { ...meta, spotifyId: ids.africa });
    const m4a = await save("Third", "original", "mp4a.40.2", { ...meta, spotifyId: ids.maneater });
    expect([mp3, opus, m4a]).toEqual(["Renamed song.mp3", "Another name.opus", "Third.m4a"]);

    const { files } = await readSongFiles(path.join(root, "saved"));
    const byName = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byName[mp3]).toMatchObject({
      title: "Bohemian Rhapsody",
      artist: "Queen",
      spotifyIds: [ids.bohemian],
    });
    expect(byName[opus].spotifyIds).toEqual([ids.africa]);
    expect(byName[m4a].spotifyIds).toEqual([ids.maneater]);

    const result = await songsInFolder(path.join(root, "saved"), [
      { id: ids.bohemian, title: "Bohemian Rhapsody", artists: "Queen" },
      { id: ids.holiday, title: "Holiday", artists: "Madonna" },
    ]);
    expect(result).toEqual({
      folder: path.join(root, "saved"),
      files: 3,
      complete: true,
      found: { [ids.bohemian]: { file: mp3, by: "spotify" } },
    });
  });
});

describe("findAudioFiles", () => {
  it("looks through subfolders for audio files, skipping hidden folders, unfinished downloads and other files", async () => {
    const dir = path.join(root, "library");
    const touch = async (...parts: string[]) => {
      await fs.mkdir(path.join(dir, ...parts.slice(0, -1)), { recursive: true });
      await fs.writeFile(path.join(dir, ...parts), "not really audio");
    };
    await touch("Queen", "Greatest Hits", "11 Bohemian Rhapsody.MP3");
    await touch("song.opus");
    await touch("song.flac");
    await touch("Saving.mp3.part");
    await touch("cover.jpg");
    await touch("notes.txt");
    await touch(".hidden", "secret.mp3");
    await touch("$RECYCLE.BIN", "deleted.mp3");
    await touch("1", "2", "3", "4", "5", "6", "six folders down.mp3");
    await touch("1", "2", "3", "4", "5", "6", "7", "seven folders down.mp3");

    const { files, complete } = await findAudioFiles(dir);
    expect(files.map((f) => f.relative)).toEqual([
      "song.flac",
      "song.opus",
      path.join("Queen", "Greatest Hits", "11 Bohemian Rhapsody.MP3"),
      path.join("1", "2", "3", "4", "5", "6", "six folders down.mp3"),
    ]);
    // Seven folders down is further than the app looks.
    expect(complete).toBe(false);

    // A file that isn't really audio still counts by its name.
    const { files: songs } = await readSongFiles(dir);
    expect(songs[2]).toEqual({
      path: path.join("Queen", "Greatest Hits", "11 Bohemian Rhapsody.MP3"),
      spotifyIds: [],
    });
    expect(
      findSongs([{ id: ids.bohemian, title: "Bohemian Rhapsody", artists: "Queen" }], songs),
    ).toEqual({
      [ids.bohemian]: {
        file: path.join("Queen", "Greatest Hits", "11 Bohemian Rhapsody.MP3"),
        by: "title-artist",
      },
    });
  });

  it("explains a folder that doesn't exist", async () => {
    await expect(findAudioFiles(path.join(root, "missing"))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("stops at a few thousand files, saying it didn't see them all", async () => {
    expect(MAX_SONG_FILES).toBe(5000);
    const dir = path.join(root, "big");
    await fs.mkdir(path.join(dir, "More"), { recursive: true });
    for (const name of ["a.mp3", "b.mp3", path.join("More", "c.mp3")]) {
      await fs.writeFile(path.join(dir, name), "");
    }
    const all = await findAudioFiles(dir, { maxFiles: 3 });
    expect([all.files.length, all.complete]).toEqual([3, true]);
    const some = await findAudioFiles(dir, { maxFiles: 2 });
    expect(some.files.map((f) => f.relative)).toEqual(["a.mp3", "b.mp3"]);
    expect(some.complete).toBe(false);
  });
});
