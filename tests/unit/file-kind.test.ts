import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { FFMPEG_PATH } from "../../server/audio";
import { id3Length, kindProblem, sniffBytes, sniffFile } from "../../server/file-kind";

/**
 * server/file-kind.ts: what a file really is, from its first bytes — so a
 * ".mp3" that's really an M4A can be renamed, and a file that isn't audio at
 * all (a program, a web page) is never played. Real files made with ffmpeg,
 * plus the starts of files that aren't audio.
 */

let dir: string;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH!, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
  });
}

/** A second of tone in `file`, made with these ffmpeg output arguments. */
async function tone(name: string, args: string[]): Promise<string> {
  const file = path.join(dir, name);
  await ffmpeg(["-f", "lavfi", "-i", "sine=duration=1", ...args, file]);
  return file;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-file-kind-"));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("what a file really is", () => {
  it("tells each kind of audio the app plays by its content, whatever its name", async () => {
    const made: [string, string[], string][] = [
      ["a.mp3", ["-c:a", "libmp3lame", "-id3v2_version", "3"], ".mp3"],
      ["b.bin", ["-c:a", "libmp3lame", "-id3v2_version", "0", "-f", "mp3"], ".mp3"],
      ["c.mp3", ["-c:a", "aac", "-f", "mp4"], ".m4a"],
      ["d.mp3", ["-c:a", "aac", "-f", "adts"], ".aac"],
      ["e.flac", ["-c:a", "flac"], ".flac"],
      ["f.opus", ["-c:a", "libopus"], ".opus"],
      ["g.ogg", ["-c:a", "libvorbis"], ".ogg"],
      ["h.wav", [], ".wav"],
      ["i.webm", ["-c:a", "libopus"], ".webm"],
      ["j.mka", ["-c:a", "flac"], ".mka"],
      ["k.wma", ["-c:a", "wmav2"], ".wma"],
      ["l.aiff", [], ".aiff"],
    ];
    for (const [name, args, kind] of made) {
      expect(await sniffFile(await tone(name, args)), name).toEqual({ audio: kind });
    }
  });

  it("looks past an ID3 tag, however big (a cover picture inside it)", async () => {
    const picture = path.join(dir, "cover.png");
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=256x256,geq=random(1)*255:128:128",
      "-frames:v",
      "1",
      picture,
    ]);
    const song = await tone("plain.mp3", ["-c:a", "libmp3lame"]);
    const withCover = path.join(dir, "with cover.mp3");
    await ffmpeg([
      ...["-i", song, "-i", picture, "-map", "0:a", "-map", "1:v", "-c", "copy"],
      ...["-id3v2_version", "3", withCover],
    ]);
    const start = await fs.readFile(withCover);
    expect(id3Length(start)).toBeGreaterThan(4096); // more than the first read holds
    expect(await sniffFile(withCover)).toEqual({ audio: ".mp3" });
    // A FLAC with an ID3 tag in front (some taggers write one).
    const flac = await fs.readFile(await tone("tagged.flac", ["-c:a", "flac"]));
    const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 20, ...Buffer.alloc(20)]);
    expect(sniffBytes(Buffer.concat([id3, flac]))).toEqual({ audio: ".flac" });
    // Padding past the tag's size, then the audio.
    const mp3 = await fs.readFile(
      await tone("padded.mp3", ["-c:a", "libmp3lame", "-id3v2_version", "0"]),
    );
    expect(sniffBytes(Buffer.concat([id3, Buffer.alloc(300), mp3]))).toEqual({ audio: ".mp3" });
    // A tag and then nothing that can be told: most likely still audio, so no verdict.
    expect(sniffBytes(Buffer.concat([id3, Buffer.from("something else")]))).toBeUndefined();
  });

  it("names the common files that aren't audio", () => {
    const starts: [Buffer, string][] = [
      [Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)]), "a Windows program"],
      [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]), "a program"],
      [Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), "a program"],
      [Buffer.from("#!/bin/sh\nrm -rf ~\n"), "a script"],
      [Buffer.from([0x50, 0x4b, 3, 4, 20, 0]), "a zip archive"],
      [Buffer.from("Rar!\x1a\x07\x00"), "a RAR archive"],
      [Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]), "a 7-Zip archive"],
      [
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        "an installer or Office file",
      ],
      [Buffer.from([0x4c, 0, 0, 0, 1, 0x14, 2, 0, 0, 0]), "a Windows shortcut"],
      [Buffer.from("%PDF-1.7\n"), "a PDF"],
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), "a picture"],
      [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), "a picture"],
      [Buffer.from("﻿  <!DOCTYPE html><html><script>alert(1)</script>"), "a web page"],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"), "a web page"],
    ];
    for (const [start, what] of starts) expect(sniffBytes(start), what).toEqual({ other: what });
    // Anything else can't be told: the file's name is believed.
    expect(sniffBytes(Buffer.from("just some text"))).toBeUndefined();
    expect(sniffBytes(Buffer.alloc(0))).toBeUndefined();
  });

  it("says what's wrong with a file's name, if anything", () => {
    expect(kindProblem("Song.mp3", { audio: ".mp3" })).toEqual({});
    expect(kindProblem("Song.MP3", { audio: ".mp3" })).toEqual({});
    expect(kindProblem("Song.mp3", { audio: ".m4a" })).toEqual({ realType: ".m4a" });
    expect(kindProblem("Song.m4a", { audio: ".mp3" })).toEqual({ realType: ".mp3" });
    // The same kind of file under its other names.
    expect(kindProblem("Song.ogg", { audio: ".opus" })).toEqual({});
    expect(kindProblem("Song.opus", { audio: ".ogg" })).toEqual({});
    expect(kindProblem("Song.oga", { audio: ".ogg" })).toEqual({});
    expect(kindProblem("Song.mka", { audio: ".webm" })).toEqual({});
    expect(kindProblem("Song.aif", { audio: ".aiff" })).toEqual({});
    expect(kindProblem("Song.mp3", { other: "a Windows program" })).toEqual({
      notAudio: "a Windows program",
    });
    expect(kindProblem("Song.mp3", undefined)).toEqual({});
  });
});
