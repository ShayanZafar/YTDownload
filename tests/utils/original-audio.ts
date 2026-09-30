import { promises as fs } from "fs";
import type { AudioVerificationResult } from "./mp3";

/**
 * Verify a file from `?format=original` is a real audio file of the type its
 * extension claims — i.e. YouTube's stream was repackaged, not left as WebM or
 * turned into something else:
 *   .opus → Ogg page ("OggS") whose first packet is an Opus header ("OpusHead")
 *   .m4a  → ISO media file ("ftyp" box at byte 4)
 *   .mka  → Matroska (EBML header)
 */
export async function verifyOriginalAudioFile(
  filePath: string,
  ext: string,
): Promise<AudioVerificationResult> {
  const stat = await fs.stat(filePath);
  const result = (isValid: boolean, reason: string): AudioVerificationResult => ({
    isValid,
    size: stat.size,
    format: ext,
    reason,
  });
  if (stat.size < 1024) return result(false, "file too small to be audio");

  const fh = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(64);
    await fh.read(head, 0, 64, 0);
    const ascii = (start: number, end: number) => head.toString("latin1", start, end);

    switch (ext) {
      case "opus":
        return ascii(0, 4) === "OggS" && ascii(28, 36) === "OpusHead"
          ? result(true, "Ogg Opus")
          : result(false, `not Ogg Opus (starts with "${ascii(0, 4)}")`);
      case "m4a":
        return ascii(4, 8) === "ftyp"
          ? result(true, "MP4 audio")
          : result(false, "no ftyp box at byte 4");
      case "mka":
        return head.readUInt32BE(0) === 0x1a45dfa3
          ? result(true, "Matroska audio")
          : result(false, "no EBML header");
      default:
        return result(false, `unexpected extension .${ext}`);
    }
  } finally {
    await fh.close();
  }
}
