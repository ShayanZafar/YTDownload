import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FFMPEG_PATH,
  audioOutput,
  prepareAudioOutput,
  withPrefix,
  youtubeAlbumTags,
} from "../../server/audio";
import {
  COVER_SIZE,
  coverArgs,
  isSpotifyCoverUrl,
  squareJpeg,
  youtubeThumbnailUrls,
} from "../../server/cover";
import { decodeHtml, parseTrackPage } from "../../server/spotify";
import { ffmetadataValue, flacPictureBlock, id3v2Tag, jpegSize } from "../../server/tags";

// music-metadata is ESM-only and types parseFile under the "node" condition only (see library.ts).
type Picture = { format: string; data: Uint8Array; type?: string };
type Parsed = {
  common: {
    title?: string;
    artist?: string;
    album?: string;
    year?: number;
    date?: string;
    track: { no: number | null };
    picture?: Picture[];
  };
  native: Record<string, { id: string; value: unknown }[]>;
};
const parseFile = async (file: string): Promise<Parsed> => {
  const mm = (await import("music-metadata")) as unknown as {
    parseFile: (file: string) => Promise<Parsed>;
  };
  return mm.parseFile(file);
};

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

const quiet = ["-hide_banner", "-loglevel", "error"];
/** A test picture of this size, as a JPEG (a YouTube thumbnail or a Spotify cover). */
const picture = (size: string) =>
  ffmpeg([
    ...quiet,
    "-f",
    "lavfi",
    "-i",
    `testsrc=s=${size}:d=1`,
    "-frames:v",
    "1",
    "-f",
    "mjpeg",
    "pipe:1",
  ]);
/** A second of Opus in WebM, as YouTube serves it. */
const opusSource = () =>
  ffmpeg([
    ...quiet,
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "libopus", "-f", "webm"],
    "pipe:1",
  ]);

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-cover-"));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("the MP3 tag (id3v2Tag)", () => {
  it("holds the title, artist, album, year, track, Spotify song and cover, as players read them", async () => {
    const cover = await squareJpeg(await picture("640x640"), "spotify");
    const tag = id3v2Tag(
      {
        title: "Café – Ünïcödé ♪",
        artist: "Beyoncé, 坂本龍一",
        album: "Whenever You Need Somebody",
        date: "1987-11-12",
        track: 1,
        spotifyId: "4uLU6hMCjMI75M1A2tKUQC",
      },
      cover,
    );
    const mp3 = await ffmpeg(audioOutput("mp3", { title: "x" }).ffmpegArgs, await opusSource());
    const file = path.join(root, "tagged.mp3");
    await fs.writeFile(file, Buffer.concat([tag, mp3]));

    const { common, native } = await parseFile(file);
    expect(common).toMatchObject({
      title: "Café – Ünïcödé ♪",
      artist: "Beyoncé, 坂本龍一",
      album: "Whenever You Need Somebody",
      year: 1987,
      track: { no: 1 },
    });
    expect(native["ID3v2.3"]).toContainEqual({
      id: "TXXX:spotify_id",
      value: "4uLU6hMCjMI75M1A2tKUQC",
    });
    expect(common.picture).toHaveLength(1);
    expect(common.picture![0]).toMatchObject({ format: "image/jpeg", type: "Cover (front)" });
    expect(Buffer.from(common.picture![0].data).equals(cover)).toBe(true);
  });

  it("leaves out what isn't known", () => {
    const tag = id3v2Tag({ title: "Song" }).toString("latin1");
    expect(tag.startsWith("ID3\x03\x00")).toBe(true);
    expect(tag).toContain("TIT2");
    for (const id of ["TPE1", "TALB", "TYER", "TRCK", "TXXX", "APIC"])
      expect(tag).not.toContain(id);
  });
});

describe("MP3 downloads", () => {
  it("leave the tag to the app: ffmpeg writes none", () => {
    const out = audioOutput("mp3", { title: "Song", artist: "Someone" });
    expect(out.ffmpegArgs[out.ffmpegArgs.indexOf("-write_id3v2") + 1]).toBe("0");
    expect(out.ffmpegArgs.join(" ")).not.toContain("title=");
    expect(out.prefix?.subarray(0, 3).toString()).toBe("ID3");
  });

  it("send the tag together with the first audio, and nothing when there's no audio", async () => {
    const read = async (stream: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      return chunks;
    };
    const prefix = Buffer.from("TAG");
    const chunks = await read(
      withPrefix(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), prefix),
    );
    expect(String(chunks[0]).startsWith("TAGab")).toBe(true);
    expect(Buffer.concat(chunks).toString()).toBe("TAGabcd");
    expect(await read(withPrefix(Readable.from([]), prefix))).toEqual([]);
  });
});

describe("covers", () => {
  it("are the middle square of a YouTube thumbnail, inside a 4:3 thumbnail's black bars", async () => {
    const big = await squareJpeg(await picture("1280x720"), "youtube");
    expect(jpegSize(big)).toEqual({ width: COVER_SIZE, height: COVER_SIZE });
    const letterboxed = await squareJpeg(await picture("640x480"), "youtube");
    expect(jpegSize(letterboxed)).toEqual({ width: 360, height: 360 });
  });

  it("are a Spotify cover as it is, no bigger than COVER_SIZE", async () => {
    expect(jpegSize(await squareJpeg(await picture("640x640"), "spotify"))).toEqual({
      width: COVER_SIZE,
      height: COVER_SIZE,
    });
    expect(jpegSize(await squareJpeg(await picture("300x300"), "spotify"))).toEqual({
      width: 300,
      height: 300,
    });
  });

  it("are made by ffmpeg from stdin to stdout, as one JPEG", () => {
    const args = coverArgs("youtube");
    expect(args[args.indexOf("-i") + 1]).toBe("pipe:0");
    expect(args.at(-1)).toBe("pipe:1");
    expect(args[args.indexOf("-frames:v") + 1]).toBe("1");
  });

  it("aren't made from something that isn't a picture", async () => {
    await expect(squareJpeg(Buffer.from("not a picture"), "youtube")).rejects.toThrow();
  });

  it("come only from YouTube's thumbnails of a valid video id, or Spotify's image hosts", () => {
    expect(youtubeThumbnailUrls("dQw4w9WgXcQ")).toEqual([
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/sddefault.jpg",
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
    ]);
    expect(youtubeThumbnailUrls("../../evil")).toEqual([]);
    expect(
      isSpotifyCoverUrl("https://i.scdn.co/image/ab67616d0000b273255e131abc1410833be95673"),
    ).toBe(true);
    expect(
      isSpotifyCoverUrl(
        "https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02255e131abc1410833be95673",
      ),
    ).toBe(true);
    for (const url of [
      "http://i.scdn.co/image/ab67616d0000b273255e131abc1410833be95673",
      "https://i.scdn.co.evil.com/image/ab67616d0000b273255e131abc1410833be95673",
      "https://example.com/image/ab67616d0000b273255e131abc1410833be95673",
      "https://i.scdn.co/image/ab67616d0000b273?x=1",
    ]) {
      expect(isSpotifyCoverUrl(url), url).toBe(false);
    }
  });

  it("have their size read from the JPEG, and go into Ogg as a FLAC picture block", async () => {
    const jpeg = await picture("320x200");
    expect(jpegSize(jpeg)).toEqual({ width: 320, height: 200 });
    expect(jpegSize(Buffer.from("nope"))).toBeUndefined();
    const block = Buffer.from(flacPictureBlock(jpeg), "base64");
    expect(block.readUInt32BE(0)).toBe(3); // front cover
    expect(block.subarray(8, 18).toString()).toBe("image/jpeg");
    expect(block.readUInt32BE(22)).toBe(320);
    expect(block.readUInt32BE(26)).toBe(200);
    expect(block.subarray(-jpeg.length).equals(jpeg)).toBe(true);
    expect(ffmetadataValue("a=b;c#d\\e\nf")).toBe("a\\=b\\;c\\#d\\\\e\\\nf");
  });
});

describe("original audio with a cover", () => {
  const meta = {
    title: "Song",
    artist: "Someone",
    album: "An Album",
    date: "2001-02-03",
    track: 7,
    spotifyId: "4uLU6hMCjMI75M1A2tKUQC",
  };

  for (const [acodec, ext] of [
    ["opus", "opus"],
    ["vorbis", "mka"],
  ] as const) {
    it(`goes into the .${ext} file, with the tags, and its temp files are deleted afterwards`, async () => {
      const cover = await squareJpeg(await picture("640x640"), "spotify");
      const output = await prepareAudioOutput("original", meta, acodec, cover);
      expect(output.ext).toBe(ext);
      const tempFile = output.ffmpegArgs.find((arg) => arg.includes("ytdownload-cover-"));
      expect(tempFile).toBeDefined();
      const audio = await ffmpeg(output.ffmpegArgs, await opusSource());
      await output.cleanup();
      await expect(fs.stat(path.dirname(tempFile!))).rejects.toThrow();

      const file = path.join(root, `original.${ext}`);
      await fs.writeFile(file, audio);
      const { common } = await parseFile(file);
      // (music-metadata doesn't read Matroska's song tags into `common`; VLC does.)
      if (ext === "opus") {
        expect(common).toMatchObject({
          title: "Song",
          artist: "Someone",
          album: "An Album",
          track: { no: 7 },
        });
      }
      expect(common.picture?.[0]?.format).toBe("image/jpeg");
      expect(Buffer.from(common.picture![0].data).equals(cover)).toBe(true);
    });
  }

  it("is left out of a streamed .m4a, which can't hold one, and needs no temp files", async () => {
    const cover = await squareJpeg(await picture("640x640"), "spotify");
    const output = await prepareAudioOutput("original", meta, "mp4a.40.2", cover);
    expect(output.ext).toBe("m4a");
    expect(output.ffmpegArgs.join(" ")).not.toContain("ytdownload-cover-");
    expect(output.ffmpegArgs).toContain("album=An Album");
  });

  it("isn't needed: without one, nothing is written", async () => {
    const output = await prepareAudioOutput("original", meta, "opus");
    expect(output.ffmpegArgs[output.ffmpegArgs.indexOf("-map_metadata") + 1]).toBe("-1");
    expect(output.ffmpegArgs).toContain("track=7");
  });
});

describe("album details", () => {
  it("come from a Spotify song page's link-preview tags", () => {
    const html = `<html><head>
      <meta property="og:title" content="Never Gonna Give You Up"/>
      <meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987"/>
      <meta property="og:image" content="https://i.scdn.co/image/ab67616d0000b273255e131abc1410833be95673"/>
      <meta name="music:album" content="https://open.spotify.com/album/6N9PS4QXF1D0OWPk0Sxtb4"/>
      <meta name="music:album:track" content="1"/>
      <meta name="music:release_date" content="1987-11-12"/>
    </head></html>`;
    expect(parseTrackPage(html)).toEqual({
      album: "Whenever You Need Somebody",
      track: 1,
      date: "1987-11-12",
      coverUrl: "https://i.scdn.co/image/ab67616d0000b273255e131abc1410833be95673",
    });
  });

  it("keep an album name with special characters, and skip what doesn't look right", () => {
    const html = `<meta property="og:description" content="A, B · Rock &amp; Roll &#x27;n&#39; Soul · Live · Song · 2020"/>
      <meta name="music:album:track" content="zero"/>
      <meta name="music:release_date" content="soon"/>
      <meta property="og:image" content="https://evil.example/image/abc"/>`;
    expect(parseTrackPage(html)).toEqual({ album: "Rock & Roll 'n' Soul · Live" });
    expect(parseTrackPage("<html></html>")).toEqual({});
    expect(decodeHtml("&lt;&gt;&quot;&amp;&unknown;&#128512;")).toBe('<>"&&unknown;😀');
  });

  it("come from YouTube Music's details of a video", () => {
    expect(youtubeAlbumTags({ album: " Album ", release_date: "19871112" })).toEqual({
      album: "Album",
      date: "1987-11-12",
    });
    expect(youtubeAlbumTags({ release_year: 2001 })).toEqual({ date: "2001" });
    expect(youtubeAlbumTags({ album: "", release_date: "bad" })).toEqual({});
  });
});
