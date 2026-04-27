import { promises as fs } from "fs";

export interface Mp3VerificationResult {
  isValid: boolean;
  size: number;
  reason: string;
}

/**
 * Verify that a file on disk looks like a real MP3 audio file.
 *
 * An MP3 file starts with one of:
 *   - "ID3" (0x49 0x44 0x33) -> ID3v2 metadata header
 *   - 0xFF followed by a byte whose top 3 bits are set (0xE0..0xFF)
 *     -> raw MPEG audio frame sync word
 *
 * This is the same heuristic used by `file(1)` and most media players.
 */
export async function verifyMp3File(filePath: string): Promise<Mp3VerificationResult> {
  const stat = await fs.stat(filePath);
  if (stat.size < 1024) {
    return { isValid: false, size: stat.size, reason: "file too small to be audio" };
  }

  const fh = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(3);
    await fh.read(head, 0, 3, 0);

    // ID3v2 tag
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      return { isValid: true, size: stat.size, reason: "ID3v2 header present" };
    }

    // MPEG audio frame sync: 0xFF followed by 0xE0..0xFF
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
      return { isValid: true, size: stat.size, reason: "MPEG audio frame sync present" };
    }

    return {
      isValid: false,
      size: stat.size,
      reason: `unexpected header bytes: ${head[0].toString(16)} ${head[1].toString(16)} ${head[2].toString(16)}`,
    };
  } finally {
    await fh.close();
  }
}
