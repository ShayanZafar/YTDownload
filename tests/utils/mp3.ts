import { promises as fs } from "fs";

export interface AudioVerificationResult {
  isValid: boolean;
  size: number;
  format: string;
  reason: string;
}

/**
 * Verify that a file is a real MP3 — what the download endpoint produces after
 * converting with ffmpeg: an optional ID3v2 tag followed by an MPEG-1/2 Layer III
 * frame header. A WebM/M4A file renamed to .mp3 fails this check.
 */
export async function verifyMp3File(filePath: string): Promise<AudioVerificationResult> {
  const stat = await fs.stat(filePath);
  const fail = (reason: string): AudioVerificationResult => ({
    isValid: false,
    size: stat.size,
    format: "unknown",
    reason,
  });
  if (stat.size < 1024) return fail("file too small to be audio");

  const fh = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(10);
    await fh.read(head, 0, 10, 0);

    // Skip an ID3v2 tag if there is one (its size is a 28-bit "syncsafe" int).
    let offset = 0;
    if (head.toString("latin1", 0, 3) === "ID3") {
      const tagSize = (head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9];
      const hasFooter = (head[5] & 0x10) !== 0;
      offset = 10 + tagSize + (hasFooter ? 10 : 0);
    }

    const frame = Buffer.alloc(2);
    await fh.read(frame, 0, 2, offset);
    const isSync = frame[0] === 0xff && (frame[1] & 0xe0) === 0xe0;
    const isLayer3 = (frame[1] & 0x06) === 0x02;
    if (!isSync || !isLayer3) {
      const hex = Array.from(frame)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      return fail(`no MP3 frame header at byte ${offset} (found ${hex})`);
    }

    return {
      isValid: true,
      size: stat.size,
      format: "mp3",
      reason: offset > 0 ? "ID3v2 tag followed by an MP3 frame" : "MP3 frame header",
    };
  } finally {
    await fh.close();
  }
}
