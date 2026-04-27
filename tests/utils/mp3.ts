import { promises as fs } from "fs";

export interface AudioVerificationResult {
  isValid: boolean;
  size: number;
  format: string;
  reason: string;
}

/**
 * Verify that a file on disk looks like a real audio file streamed from YouTube.
 *
 * The download endpoint labels every response as `audio/mpeg` / `.mp3` for
 * convenience, but YouTube actually serves audio in one of three containers
 * depending on the source video:
 *   - MP3 (rare):  starts with "ID3" or an MPEG sync word (0xFF 0xEx/Fx)
 *   - WebM/Opus:   starts with the EBML magic bytes 0x1A 0x45 0xDF 0xA3
 *   - MP4/M4A:     ISO base media — at offset 4 the 4 bytes are "ftyp"
 *
 * This helper accepts any of those — it confirms we got a real audio
 * payload, not an HTML error page or an empty body.
 */
export async function verifyAudioFile(filePath: string): Promise<AudioVerificationResult> {
  const stat = await fs.stat(filePath);
  if (stat.size < 1024) {
    return { isValid: false, size: stat.size, format: "unknown", reason: "file too small to be audio" };
  }

  const fh = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);

    // ID3v2 tag
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      return { isValid: true, size: stat.size, format: "mp3", reason: "ID3v2 header present" };
    }

    // MPEG audio frame sync: 0xFF followed by 0xE0..0xFF
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
      return { isValid: true, size: stat.size, format: "mp3", reason: "MPEG audio frame sync present" };
    }

    // WebM / Matroska EBML header
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return { isValid: true, size: stat.size, format: "webm", reason: "EBML (WebM/Matroska) header present" };
    }

    // ISO base media (MP4 / M4A): bytes 4..7 == "ftyp"
    if (
      head[4] === 0x66 && // f
      head[5] === 0x74 && // t
      head[6] === 0x79 && // y
      head[7] === 0x70    // p
    ) {
      return { isValid: true, size: stat.size, format: "mp4", reason: 'ISO BMFF "ftyp" box present' };
    }

    return {
      isValid: false,
      size: stat.size,
      format: "unknown",
      reason: `unrecognised header bytes: ${Array.from(head.slice(0, 8))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ")}`,
    };
  } finally {
    await fh.close();
  }
}

/**
 * @deprecated Kept as an alias so older imports keep working. Prefer
 * `verifyAudioFile` for new code — YouTube serves more than one container.
 */
export const verifyMp3File = verifyAudioFile;
