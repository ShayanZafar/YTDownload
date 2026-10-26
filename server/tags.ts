/**
 * Tags written into downloaded files, beyond what ffmpeg's -metadata can do.
 *
 * The ID3v2.3 tag at the start of a downloaded MP3: title, artist, album,
 * genre, year, track number, the Spotify song (TXXX:spotify_id) and the cover.
 *
 * ffmpeg writes MP3 tags itself, but with a cover it can only get the tag's
 * size right by going back to the start of the file afterwards — which a
 * stream (the download, or the save into a folder) can't do. So ffmpeg writes
 * the MP3 without a tag (`-id3v2_version 0`) and the app puts this one in front.
 * ID3v2.3 rather than 2.4: Windows Explorer and many car and phone players
 * only read 2.3.
 */

export type SongTags = {
  title: string;
  artist?: string;
  album?: string;
  /** "Rock" (from the music catalogues: download-details.ts). */
  genre?: string;
  /** "1987", or a whole date "1987-11-12" (ID3v2.3 keeps only the year). */
  date?: string;
  /** The song's number on its album. */
  track?: number;
  /** The Spotify song this is. */
  spotifyId?: string;
};

/** The ID3v2.3 tag for these tags and cover (a JPEG), ready to go before the MP3's audio. */
export function id3v2Tag(tags: SongTags, cover?: Buffer): Buffer {
  const frames: Buffer[] = [textFrame("TIT2", tags.title)];
  if (tags.artist) frames.push(textFrame("TPE1", tags.artist));
  if (tags.album) frames.push(textFrame("TALB", tags.album));
  if (tags.genre) frames.push(textFrame("TCON", tags.genre));
  const year = /^\d{4}/.exec(tags.date ?? "")?.[0];
  if (year) frames.push(textFrame("TYER", year));
  if (tags.track && tags.track > 0) frames.push(textFrame("TRCK", String(tags.track)));
  if (tags.spotifyId) {
    frames.push(frame("TXXX", encoded("spotify_id", tags.spotifyId)));
  }
  if (cover) {
    frames.push(
      frame(
        "APIC",
        Buffer.concat([
          Buffer.from([0]), // the MIME type and description are Latin-1
          Buffer.from("image/jpeg\0", "latin1"),
          Buffer.from([3]), // picture type 3: the front cover
          Buffer.from("\0", "latin1"), // no description
          cover,
        ]),
      ),
    );
  }
  const body = Buffer.concat(frames);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(body.length)]);
  return Buffer.concat([header, body]);
}

function textFrame(id: string, text: string): Buffer {
  return frame(id, encoded(text));
}

/**
 * Text with its encoding byte: Latin-1 when every character fits, otherwise
 * UTF-16 with a byte-order mark (ID3v2.3 has no UTF-8). Several strings (a
 * TXXX frame's description and value) share the one encoding byte, each but
 * the last ended by a zero.
 */
function encoded(...texts: string[]): Buffer {
  const latin1 = texts.every((text) => [...text].every((c) => c.charCodeAt(0) <= 0xff));
  const parts = texts.map((text, i) => {
    const last = i === texts.length - 1;
    return latin1
      ? Buffer.concat([Buffer.from(text, "latin1"), Buffer.alloc(last ? 0 : 1)])
      : Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(text, "utf16le"),
          Buffer.alloc(last ? 0 : 2),
        ]);
  });
  return Buffer.concat([Buffer.from([latin1 ? 0 : 1]), ...parts]);
}

/** A v2.3 frame: its id, its size (a plain 32-bit number in 2.3) and no flags. */
function frame(id: string, data: Buffer): Buffer {
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1");
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

/** The tag's size, 7 bits to a byte (so it can't look like the start of MP3 audio). */
function syncsafe(n: number): number[] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

/** A JPEG's width and height, from its frame header, or undefined if it isn't a JPEG. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | undefined {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return undefined;
    const marker = jpeg[at + 1];
    const length = jpeg.readUInt16BE(at + 2);
    // SOF0…SOF15 hold the size (C4, C8 and CC are other things).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return undefined;
}

/**
 * The cover as an Ogg file holds it: a FLAC picture block (front cover, a
 * JPEG unless `type` says), base64-encoded into a METADATA_BLOCK_PICTURE comment.
 */
export function flacPictureBlock(jpeg: Buffer, type = "image/jpeg"): string {
  const size = jpegSize(jpeg) ?? { width: 0, height: 0 };
  const mime = Buffer.from(type, "latin1");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(3, 0); // the front cover
  header.writeUInt32BE(mime.length, 4);
  const details = Buffer.alloc(24);
  details.writeUInt32BE(0, 0); // no description
  details.writeUInt32BE(size.width, 4);
  details.writeUInt32BE(size.height, 8);
  details.writeUInt32BE(24, 12); // colour depth
  details.writeUInt32BE(0, 16); // not an indexed-colour picture
  details.writeUInt32BE(jpeg.length, 20);
  return Buffer.concat([header, mime, details, jpeg]).toString("base64");
}

/**
 * A value for ffmpeg's metadata file (`-f ffmetadata`), with the characters
 * that file format gives a meaning to escaped. (A cover is too big for a
 * command line on Windows, so an Opus file's cover goes in through one.)
 */
export const ffmetadataValue = (value: string) => value.replace(/[=;#\\\n]/g, (c) => `\\${c}`);
