/**
 * What a file really is, from its first bytes — not its name. A song whose
 * name says one thing and whose content says another (a ".mp3" that's really
 * an M4A, say) plays wrong or not at all, and a file that isn't audio at all
 * (a program, a web page) has no business in the player.
 *
 * Each kind of audio file starts the same way: MP3 with a frame header (after
 * any ID3 tag), M4A with "ftyp", FLAC with "fLaC" (also after any ID3 tag),
 * Ogg with "OggS"… (`sniffBytes()`). A few common kinds of file that aren't
 * audio are told by their own start, so the app can say what they are; any
 * other start can't be told, and the file's name is believed.
 *
 * Only the first few kilobytes are read, once per file (library.ts keeps the
 * answer with its tags until the file changes).
 */
import { promises as fs } from "fs";
import { extensionOf } from "@shared/audio-types";

/**
 * What the start of a file says it is: audio, with the extension that kind
 * has (".m4a"), or something else ("a Windows program"). Undefined: can't tell.
 */
export type FileKind = { audio: string } | { other: string };

/** How much of a file is read: enough for an ID3 tag's header and what follows. */
const START_BYTES = 4096;
/** An ID3 tag can be big (a cover picture inside); what comes after it is read on its own. */
const AFTER_TAG_BYTES = 4096;

// Extensions that are the same kind of file, by the name `sniffBytes()` gives that kind.
const SAME_KIND: Record<string, string> = {
  ".oga": ".ogg",
  ".opus": ".ogg",
  ".mka": ".webm",
  ".aif": ".aiff",
};
const kindOf = (ext: string) => SAME_KIND[ext] ?? ext;

/** Is `b` (from `at`) these ASCII letters? */
function startsWith(b: Uint8Array, text: string, at = 0): boolean {
  if (b.length < at + text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

/** An ID3v2 tag's whole length (header and all), if `b` starts with one. */
export function id3Length(b: Uint8Array): number | undefined {
  if (!startsWith(b, "ID3") || b.length < 10) return undefined;
  // The size is "syncsafe": 7 bits a byte.
  if ((b[6] | b[7] | b[8] | b[9]) & 0x80) return undefined;
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
  const footer = b[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

/** An MPEG audio frame header (MP3) or an ADTS one (AAC) at `at`? */
function mpegAt(b: Uint8Array, at: number): ".mp3" | ".aac" | undefined {
  if (b.length < at + 4 || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return undefined;
  const layer = (b[at + 1] >> 1) & 3;
  if (layer === 0) return (b[at + 1] & 0xf6) === 0xf0 ? ".aac" : undefined;
  const version = (b[at + 1] >> 3) & 3;
  const bitrate = b[at + 2] >> 4;
  const rate = (b[at + 2] >> 2) & 3;
  return version !== 1 && bitrate !== 15 && rate !== 3 ? ".mp3" : undefined;
}

/** The kind of audio `b` starts with, or undefined. */
function audioStart(b: Uint8Array): string | undefined {
  if (startsWith(b, "fLaC")) return ".flac";
  if (startsWith(b, "OggS")) {
    // The first page holds the codec's own header: "OpusHead", or Vorbis's.
    return startsWith(b, "OpusHead", 28) ? ".opus" : ".ogg";
  }
  if (startsWith(b, "ftyp", 4) || startsWith(b, "moov", 4)) return ".m4a";
  if ((startsWith(b, "RIFF") || startsWith(b, "RF64")) && startsWith(b, "WAVE", 8)) return ".wav";
  if (startsWith(b, "FORM") && (startsWith(b, "AIFF", 8) || startsWith(b, "AIFC", 8))) {
    return ".aiff";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // Matroska; WebM says so in its header.
    return Buffer.from(b.subarray(0, 64)).includes("webm") ? ".webm" : ".mka";
  }
  const asf = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11];
  if (asf.every((byte, i) => b[i] === byte)) return ".wma";
  if (startsWith(b, "MAC ")) return ".ape";
  if (startsWith(b, "wvpk")) return ".wv";
  return mpegAt(b, 0);
}

/** What a file that isn't audio is, by its start — the kinds worth naming. */
function otherStart(b: Uint8Array): string | undefined {
  const bytes = (...want: number[]) => want.every((byte, i) => b[i] === byte);
  if (startsWith(b, "MZ")) return "a Windows program";
  if (bytes(0x7f, 0x45, 0x4c, 0x46)) return "a program";
  if (
    bytes(0xcf, 0xfa, 0xed, 0xfe) ||
    bytes(0xce, 0xfa, 0xed, 0xfe) ||
    bytes(0xfe, 0xed, 0xfa, 0xcf) ||
    bytes(0xca, 0xfe, 0xba, 0xbe)
  ) {
    return "a program";
  }
  if (startsWith(b, "#!")) return "a script";
  if (startsWith(b, "PK") && (bytes(0x50, 0x4b, 3, 4) || bytes(0x50, 0x4b, 5, 6))) {
    return "a zip archive";
  }
  if (startsWith(b, "Rar!")) return "a RAR archive";
  if (bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return "a 7-Zip archive";
  if (bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "an installer or Office file";
  if (bytes(0x4c, 0, 0, 0, 1, 0x14, 2, 0)) return "a Windows shortcut";
  if (startsWith(b, "%PDF")) return "a PDF";
  if (bytes(0xff, 0xd8, 0xff) || bytes(0x89, 0x50, 0x4e, 0x47) || startsWith(b, "GIF8")) {
    return "a picture";
  }
  // Text: a web page, or a script that runs if it's opened.
  const text = Buffer.from(b.subarray(0, 512))
    .toString("latin1")
    .replace(/^(\xef\xbb\xbf|\xff\xfe|\xfe\xff)/, "")
    .trimStart()
    .toLowerCase();
  if (/^<(!doctype|html|head|body|script|svg|\?xml)/.test(text)) return "a web page";
  return undefined;
}

/**
 * What `start` (a file's first bytes) says the file is. `afterTag` is what
 * follows an ID3 tag at the start, when the tag is longer than `start`.
 */
export function sniffBytes(start: Uint8Array, afterTag?: Uint8Array): FileKind | undefined {
  const tag = id3Length(start);
  if (tag !== undefined) {
    let rest = afterTag ?? start.subarray(Math.min(tag, start.length));
    // Some taggers pad past the size they wrote.
    let zeros = 0;
    while (zeros < rest.length && rest[zeros] === 0) zeros++;
    rest = rest.subarray(zeros);
    const audio = audioStart(rest);
    // An ID3 tag with something unknown after it: still most likely audio.
    return audio ? { audio } : undefined;
  }
  const audio = audioStart(start);
  if (audio) return { audio };
  const other = otherStart(start);
  return other ? { other } : undefined;
}

/** Reads a file's start (and what follows an ID3 tag there) and says what it is. */
export async function sniffFile(file: string): Promise<FileKind | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const start = Buffer.alloc(START_BYTES);
    const { bytesRead } = await handle.read(start, 0, START_BYTES, 0);
    const head = start.subarray(0, bytesRead);
    const tag = id3Length(head);
    let afterTag: Buffer | undefined;
    if (tag !== undefined && tag + 16 > bytesRead) {
      afterTag = Buffer.alloc(AFTER_TAG_BYTES);
      const after = await handle.read(afterTag, 0, AFTER_TAG_BYTES, tag);
      afterTag = afterTag.subarray(0, after.bytesRead);
    }
    return sniffBytes(head, afterTag);
  } finally {
    await handle.close();
  }
}

/** What's wrong with a file named `fileName` whose start says `kind`, if anything. */
export type KindProblem = {
  /** It's really this kind of audio: the extension it should have (".m4a"). */
  realType?: string;
  /** It isn't audio at all: what it is ("a Windows program"). */
  notAudio?: string;
};

export function kindProblem(fileName: string, kind: FileKind | undefined): KindProblem {
  if (!kind) return {};
  if ("other" in kind) return { notAudio: kind.other };
  return kindOf(kind.audio) === kindOf(extensionOf(fileName)) ? {} : { realType: kind.audio };
}
