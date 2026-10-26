/**
 * An MP3's ID3v2 frames, byte for byte, for putting back the ones ffmpeg
 * can't copy. ffmpeg reads only an ID3v2 tag's text frames, comments, lyrics,
 * pictures, chapters and private data, so a song copied into a new file
 * loses the rest — web addresses (WOAS, WXXX…), play counts (PCNT), ratings
 * (POPM) — which Fill in details mustn't (song-details.ts checks it hasn't).
 * Tags that are unsynchronised or have an extended header or footer are left
 * alone: their frames can't simply be moved.
 */

type Id3Tag = {
  version: number;
  /** Where its frames end (its padding starts), and where the tag ends. */
  framesEnd: number;
  end: number;
  frames: { id: string; bytes: Buffer }[];
};

const syncsafeAt = (data: Buffer, at: number) =>
  ((data[at] & 0x7f) << 21) |
  ((data[at + 1] & 0x7f) << 14) |
  ((data[at + 2] & 0x7f) << 7) |
  (data[at + 3] & 0x7f);

/** The ID3v2.3 or 2.4 tag at the start of `file`, and its frames; undefined if there's none to work with. */
export function readId3Frames(file: Buffer): Id3Tag | undefined {
  if (file.length < 10 || file.toString("latin1", 0, 3) !== "ID3") return undefined;
  const version = file[3];
  // Unsynchronised, extended header, footer.
  if ((version !== 3 && version !== 4) || (file[5] & 0xd0) !== 0) return undefined;
  const end = 10 + syncsafeAt(file, 6);
  if (end > file.length) return undefined;
  const frames: Id3Tag["frames"] = [];
  let at = 10;
  while (at + 10 <= end) {
    const id = file.toString("latin1", at, at + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 4 ? syncsafeAt(file, at + 4) : file.readUInt32BE(at + 4);
    if (at + 10 + size > end) return undefined;
    frames.push({ id, bytes: file.subarray(at, at + 10 + size) });
    at += 10 + size;
  }
  return { version, framesEnd: at, end, frames };
}

/**
 * `copy` with `original`'s frames whose ids are `ids` added to its tag, or
 * undefined if there are none or the two tags can't be joined.
 */
export function withFramesFrom(original: Buffer, copy: Buffer, ids: string[]): Buffer | undefined {
  const from = readId3Frames(original);
  const to = readId3Frames(copy);
  if (!from || !to || from.version !== to.version) return undefined;
  const moving = from.frames.filter((frame) => ids.includes(frame.id));
  if (moving.length === 0) return undefined;
  const body = Buffer.concat([
    copy.subarray(10, to.framesEnd),
    ...moving.map((frame) => frame.bytes),
    copy.subarray(to.framesEnd, to.end),
  ]);
  if (body.length >= 1 << 28) return undefined;
  const header = Buffer.from(copy.subarray(0, 10));
  header.set(
    [
      (body.length >> 21) & 0x7f,
      (body.length >> 14) & 0x7f,
      (body.length >> 7) & 0x7f,
      body.length & 0x7f,
    ],
    6,
  );
  return Buffer.concat([header, body, copy.subarray(to.end)]);
}
