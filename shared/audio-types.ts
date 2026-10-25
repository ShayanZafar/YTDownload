/**
 * The audio files the app knows, by extension — the songs it looks for in the
 * "Save to" folder, and the ones a phone can pick for the player. For each:
 * the type it's sent as, and what to ask a browser (`canPlayType`) to find out
 * whether it can play such a file itself. A file the browser can't play is
 * converted by the app on the computer it runs on (see server/music.ts); on
 * another device it's marked as one this browser can't play.
 */
export type AudioType = {
  /** The MIME type a file like this is sent as. */
  mime: string;
  /** What to ask `canPlayType()`: the type, with the codec such a file usually has. */
  check: string;
};

export const AUDIO_TYPES: Readonly<Record<string, AudioType>> = {
  ".mp3": { mime: "audio/mpeg", check: "audio/mpeg" },
  ".m4a": { mime: "audio/mp4", check: 'audio/mp4; codecs="mp4a.40.2"' },
  ".aac": { mime: "audio/aac", check: "audio/aac" },
  ".opus": { mime: "audio/ogg", check: 'audio/ogg; codecs="opus"' },
  ".ogg": { mime: "audio/ogg", check: 'audio/ogg; codecs="vorbis"' },
  ".oga": { mime: "audio/ogg", check: 'audio/ogg; codecs="vorbis"' },
  ".flac": { mime: "audio/flac", check: "audio/flac" },
  ".wav": { mime: "audio/wav", check: 'audio/wav; codecs="1"' },
  ".webm": { mime: "audio/webm", check: 'audio/webm; codecs="opus"' },
  ".mka": { mime: "audio/x-matroska", check: "audio/x-matroska" },
  ".wma": { mime: "audio/x-ms-wma", check: "audio/x-ms-wma" },
  ".aif": { mime: "audio/aiff", check: "audio/aiff" },
  ".aiff": { mime: "audio/aiff", check: "audio/aiff" },
  ".ape": { mime: "audio/x-ape", check: "audio/x-ape" },
  ".wv": { mime: "audio/x-wavpack", check: "audio/x-wavpack" },
};

/** A file's extension, lowercase: "Song.MP3" → ".mp3" ("" if it has none). */
export function extensionOf(fileName: string): string {
  const match = /\.[^.\\/]+$/.exec(fileName);
  return match ? match[0].toLowerCase() : "";
}

/** What the app knows about this kind of audio file, or undefined if it isn't one. */
export function audioTypeOf(fileName: string): AudioType | undefined {
  const ext = extensionOf(fileName);
  return Object.prototype.hasOwnProperty.call(AUDIO_TYPES, ext) ? AUDIO_TYPES[ext] : undefined;
}

/**
 * A song's name from its file, for one with no title tag: the file name
 * without its folders and extension. "Queen\Bohemian Rhapsody.mp3" → "Bohemian Rhapsody".
 */
export function songNameOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const ext = extensionOf(name);
  return (ext && name.length > ext.length ? name.slice(0, -ext.length) : name).trim() || name;
}

/**
 * A file's genres, each once: "Rock; Pop" (one tag holding several, the way
 * some taggers write them) counts as two. ID3v1's numbered genres come as
 * names already (music-metadata turns "(17)" into "Rock").
 */
export function genresOf(tags: string[] | undefined): string[] {
  const genres = (tags ?? []).flatMap((tag) => tag.split(/\s*;\s*/));
  const seen = new Set<string>();
  return genres
    .map((genre) => genre.replace(/\s+/g, " ").trim())
    .filter((genre) => {
      const key = genre.toLowerCase();
      if (!genre || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
