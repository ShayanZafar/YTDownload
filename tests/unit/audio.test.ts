import { describe, it, expect } from "vitest";
import {
  AUDIO_FORMAT,
  LAME_QUALITY,
  MP3_BITRATE,
  audioOutput,
  ffmpegMp3Args,
  ytDlpAudioArgs,
  ytDlpErrorLine,
  ytDlpFailure,
} from "../../server/audio";
import { buildDownloadUrl } from "../../shared/routes";

describe("ytDlpAudioArgs", () => {
  const args = ytDlpAudioArgs("https://www.youtube.com/watch?v=jNQXAC9IVRw");

  it("puts the URL first and streams the best available audio to stdout", () => {
    expect(args[0]).toBe("https://www.youtube.com/watch?v=jNQXAC9IVRw");
    expect(args).toContain("--format");
    expect(args[args.indexOf("--format") + 1]).toBe(AUDIO_FORMAT);
    expect(args[args.indexOf("--output") + 1]).toBe("-");
  });

  it("lets yt-dlp use Node as its JavaScript runtime", () => {
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe("node");
  });

  it("can be pinned to a specific stream", () => {
    const pinned = ytDlpAudioArgs("https://www.youtube.com/watch?v=jNQXAC9IVRw", "251");
    expect(pinned[pinned.indexOf("--format") + 1]).toBe("251");
  });
});

describe("audioOutput", () => {
  const meta = { title: "Song", artist: "Someone" };
  const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it("mp3 → a converted .mp3", () => {
    const out = audioOutput("mp3", meta, "opus");
    expect(out).toMatchObject({ ext: "mp3", contentType: "audio/mpeg" });
    expect(out.ffmpegArgs).toEqual(ffmpegMp3Args());
    // The tags go in the ID3v2.3 tag the app writes in front (tests/unit/cover-art.test.ts).
    expect(out.prefix?.toString("latin1")).toContain("Someone");
  });

  it("original + Opus → Ogg Opus (.opus), audio copied without re-encoding", () => {
    const out = audioOutput("original", meta, "opus");
    expect(out).toMatchObject({ ext: "opus", contentType: "audio/ogg" });
    expect(valueAfter(out.ffmpegArgs, "-c:a")).toBe("copy");
    expect(valueAfter(out.ffmpegArgs, "-f")).toBe("opus");
    expect(out.ffmpegArgs).not.toContain("libmp3lame");
    expect(out.ffmpegArgs).toContain("title=Song");
    expect(out.ffmpegArgs).toContain("artist=Someone");
    expect(out.ffmpegArgs.at(-1)).toBe("pipe:1");
  });

  it("original + AAC → streamable .m4a, audio copied", () => {
    const out = audioOutput("original", meta, "mp4a.40.2");
    expect(out).toMatchObject({ ext: "m4a", contentType: "audio/mp4" });
    expect(valueAfter(out.ffmpegArgs, "-c:a")).toBe("copy");
    expect(valueAfter(out.ffmpegArgs, "-movflags")).toContain("empty_moov");
  });

  it("original + anything else → Matroska audio (.mka)", () => {
    expect(audioOutput("original", meta, "vorbis").ext).toBe("mka");
    expect(audioOutput("original", meta, undefined).ext).toBe("mka");
  });

  it("tags a Spotify song's file with its id — in an .m4a's comment, which can't hold a tag of its own", () => {
    const song = { ...meta, spotifyId: "4u7EnebtmKWzUH433cf5Qv" };
    expect(audioOutput("mp3", song, "opus").prefix?.toString("latin1")).toContain(
      "spotify_id\u00004u7EnebtmKWzUH433cf5Qv",
    );
    for (const [format, acodec] of [
      ["original", "opus"],
      ["original", "vorbis"],
    ] as const) {
      expect(audioOutput(format, song, acodec).ffmpegArgs).toContain(
        "spotify_id=4u7EnebtmKWzUH433cf5Qv",
      );
    }
    expect(audioOutput("original", song, "mp4a.40.2").ffmpegArgs).toContain(
      "comment=https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv",
    );
    for (const acodec of ["opus", "mp4a.40.2"]) {
      const args = audioOutput("original", meta, acodec).ffmpegArgs;
      expect(args.some((a) => a.startsWith("spotify_id=") || a.startsWith("comment="))).toBe(false);
    }
  });
});

describe("buildDownloadUrl", () => {
  const video = "https://www.youtube.com/watch?v=jNQXAC9IVRw&t=30";

  it("defaults to MP3 without a format parameter", () => {
    const url = new URL(buildDownloadUrl(video), "http://x");
    expect(url.pathname).toBe("/api/video/download");
    expect(url.searchParams.get("url")).toBe(video);
    expect(url.searchParams.has("format")).toBe(false);
  });

  it("asks for the original audio when chosen", () => {
    const url = new URL(buildDownloadUrl(video, "original"), "http://x");
    expect(url.searchParams.get("format")).toBe("original");
    expect(url.searchParams.get("url")).toBe(video);
  });

  it("passes a new file name along, and leaves it out when there isn't one", () => {
    const renamed = new URL(buildDownloadUrl(video, "mp3", { name: "  Zoo & café  " }), "http://x");
    expect(renamed.searchParams.get("name")).toBe("Zoo & café");
    expect(
      new URL(buildDownloadUrl(video, "mp3", { name: "   " }), "http://x").searchParams.has("name"),
    ).toBe(false);
    expect(new URL(buildDownloadUrl(video), "http://x").searchParams.has("name")).toBe(false);
  });

  it("passes along the Spotify song it's for, if any", () => {
    const url = new URL(
      buildDownloadUrl(video, "mp3", { spotifyId: "4u7EnebtmKWzUH433cf5Qv" }),
      "http://x",
    );
    expect(url.searchParams.get("spotifyId")).toBe("4u7EnebtmKWzUH433cf5Qv");
    expect(new URL(buildDownloadUrl(video), "http://x").searchParams.has("spotifyId")).toBe(false);
  });
});

describe("ffmpegMp3Args", () => {
  it("reads stdin and writes a 320 kbps constant-bitrate MP3 to stdout", () => {
    const args = ffmpegMp3Args();
    expect(args[args.indexOf("-i") + 1]).toBe("pipe:0");
    expect(args[args.indexOf("-c:a") + 1]).toBe("libmp3lame");
    expect(MP3_BITRATE).toBe("320k");
    expect(args[args.indexOf("-b:a") + 1]).toBe(MP3_BITRATE);
    expect(args[args.indexOf("-compression_level") + 1]).toBe(LAME_QUALITY);
    expect(args.slice(-3)).toEqual(["-f", "mp3", "pipe:1"]);
  });

  it("writes no tag of its own: the app puts its ID3v2.3 tag in front (it can't stream one with a cover)", () => {
    const args = ffmpegMp3Args();
    expect(args[args.indexOf("-write_id3v2") + 1]).toBe("0");
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("-1");
    expect(args.some((a) => a.startsWith("title="))).toBe(false);
  });
});

describe("tags of the original audio", () => {
  it("keep Unicode intact and leave out the artist when there isn't one", () => {
    const args = audioOutput("original", { title: "Café – Ünïcödé ♪" }, "opus").ffmpegArgs;
    expect(args).toContain("title=Café – Ünïcödé ♪");
    expect(args.some((a) => a.startsWith("artist="))).toBe(false);
  });

  it("are passed as single arguments (no shell quoting involved)", () => {
    const args = audioOutput(
      "original",
      { title: 'a "quoted" & piped | title' },
      "opus",
    ).ffmpegArgs;
    expect(args).toContain('title=a "quoted" & piped | title');
  });
});

describe("yt-dlp errors", () => {
  it("keeps just the reason from yt-dlp's last ERROR line", () => {
    const stderr = [
      "WARNING: [youtube] Falling back to generic n function search",
      "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you’re not a bot",
      "",
    ].join("\r\n");
    expect(ytDlpErrorLine(stderr)).toBe("Sign in to confirm you’re not a bot");
    expect(ytDlpErrorLine("ERROR: Unable to download webpage: timed out")).toBe(
      "Unable to download webpage: timed out",
    );
    expect(ytDlpErrorLine("some other problem")).toBe("some other problem");
    expect(ytDlpErrorLine("")).toBe("");
  });

  it("explains a failed youtube-dl-exec call from yt-dlp's output, not the command line", () => {
    const failure = Object.assign(new Error("The command spawned as:\n\n  `yt-dlp …`"), {
      stderr: "ERROR: [youtube] abcdefghijk: Video unavailable",
    });
    expect(ytDlpFailure(failure)).toBe("Video unavailable");
    expect(ytDlpFailure(new Error("spawn yt-dlp ENOENT"))).toBe("spawn yt-dlp ENOENT");
  });
});
