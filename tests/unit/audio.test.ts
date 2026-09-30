import { describe, it, expect } from "vitest";
import {
  AUDIO_FORMAT,
  LAME_QUALITY,
  MP3_BITRATE,
  ffmpegMp3Args,
  ytDlpAudioArgs,
} from "../../server/audio";

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
});

describe("ffmpegMp3Args", () => {
  it("reads stdin and writes a 320 kbps constant-bitrate MP3 to stdout", () => {
    const args = ffmpegMp3Args({ title: "Song" });
    expect(args[args.indexOf("-i") + 1]).toBe("pipe:0");
    expect(args[args.indexOf("-c:a") + 1]).toBe("libmp3lame");
    expect(MP3_BITRATE).toBe("320k");
    expect(args[args.indexOf("-b:a") + 1]).toBe(MP3_BITRATE);
    expect(args[args.indexOf("-compression_level") + 1]).toBe(LAME_QUALITY);
    expect(args.slice(-3)).toEqual(["-f", "mp3", "pipe:1"]);
  });

  it("writes ID3v2.3 title and artist tags, keeping Unicode intact", () => {
    const args = ffmpegMp3Args({ title: "Café – Ünïcödé ♪", artist: "Someone" });
    expect(args).toContain("title=Café – Ünïcödé ♪");
    expect(args).toContain("artist=Someone");
    expect(args[args.indexOf("-id3v2_version") + 1]).toBe("3");
  });

  it("omits the artist tag when there isn't one", () => {
    expect(ffmpegMp3Args({ title: "Song" }).some((a) => a.startsWith("artist="))).toBe(false);
  });

  it("passes titles as a single argument (no shell quoting involved)", () => {
    const args = ffmpegMp3Args({ title: 'a "quoted" & piped | title' });
    expect(args).toContain('title=a "quoted" & piped | title');
  });
});
