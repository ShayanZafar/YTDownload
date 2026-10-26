import { z } from "zod";

/** A Spotify song, playlist or album id: 22 letters and digits. */
export const spotifyIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{22}$/, "That isn't a Spotify song id");

/**
 * Where audio comes from: YouTube, or SoundCloud — the fallback a search uses
 * when YouTube can't answer (see docs/sources.md). Left out means YouTube.
 */
export const audioSources = ["youtube", "soundcloud"] as const;
export type AudioSource = (typeof audioSources)[number];

/** One entry in the download history (stored in data/history.json by the server). */
export const downloadSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  /** ISO 8601 timestamp, e.g. "2026-09-29T22:58:44.009Z". */
  downloadedAt: z.string(),
  /**
   * The Spotify song this download is (when it was found from a Spotify link
   * or playlist), so the playlist panel can show which songs you already have.
   */
  spotifyId: z.string().optional(),
  /** Where the audio came from, when it wasn't YouTube. */
  source: z.enum(audioSources).optional(),
  /**
   * The file it became: its name in the "Save to" folder (a save), or the name
   * the browser was given (a download). Older entries don't have it.
   */
  fileName: z.string().max(1000).optional(),
});

export type Download = z.infer<typeof downloadSchema>;

/** One line of synced lyrics: when it's sung (seconds into the song) and the words. */
export const lyricLineSchema = z.object({ time: z.number(), text: z.string() });
export type LyricLine = z.infer<typeof lyricLineSchema>;

/** A song's lyrics, from LRCLIB (server/lyrics.ts). */
export const lyricsSchema = z.object({
  /** The lines with their times, when LRCLIB has them; the player follows along. */
  synced: z.array(lyricLineSchema).nullable(),
  /** The words without times. */
  plain: z.string().nullable(),
  /** LRCLIB says the song has no words. */
  instrumental: z.boolean(),
  /** The song LRCLIB found, as it names it. */
  track: z.string(),
  artist: z.string(),
});
export type Lyrics = z.infer<typeof lyricsSchema>;

/** One song search result: a YouTube video, or a SoundCloud track (`source`). */
export const searchResultSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  channel: z.string(),
  /** Length in seconds, when YouTube reports it. */
  duration: z.number().nullable(),
  thumbnail: z.string(),
  /** Uploaded by the artist or label ("Artist - Topic", VEVO, or the artist's own verified channel). */
  official: z.boolean(),
  /** Where it is: YouTube when left out, or SoundCloud (searched when YouTube can't answer). */
  source: z.enum(audioSources).optional(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * Uploads within this many seconds of a Spotify song's length are treated as
 * the same recording (ranked first, and marked "Same length" in the results).
 */
export const SAME_LENGTH_SECONDS = 5;

/**
 * Is an upload of `seconds` a different recording from a song of `songSeconds`
 * altogether — a full set, a mix or an album (a 1:44:39 festival set for a
 * 7-minute song), or a preview? More than half the song's length, or two
 * minutes, away from it. Such uploads go after all the others in a song's
 * search, and the page never picks one by itself (it says why).
 */
export function otherLength(seconds: number, songSeconds: number): boolean {
  return Math.abs(seconds - songSeconds) > Math.max(120, songSeconds / 2);
}

/**
 * Where a song's details came from: Spotify's embed page (the usual; left
 * out), or Spotify's oEmbed endpoint — the fallback when the embed page can't
 * be read, which knows only the title and cover: no artists, no length.
 */
export const spotifyTrackSources = ["spotify", "spotify-oembed"] as const;
export type SpotifyTrackSource = (typeof spotifyTrackSources)[number];

/** A song read from a Spotify link, used to find the same recording on YouTube. */
export const spotifyTrackSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  artists: z.array(z.string()),
  /** Length in seconds. */
  duration: z.number().nullable(),
  /** Cover art. */
  thumbnail: z.string().nullable(),
  /** Present when the details came from a fallback (see `spotifyTrackSources`). */
  source: z.enum(spotifyTrackSources).optional(),
});

export type SpotifyTrack = z.infer<typeof spotifyTrackSchema>;
export type InsertDownload = Pick<Download, "url" | "title" | "spotifyId" | "source" | "fileName">;

/** One song in a Spotify playlist or album, as the playlist panel lists it. */
/** A YouTube video id: 11 letters, digits, - and _. */
export const youtubeVideoIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{11}$/, "That isn't a video id");

/**
 * A song in a playlist the panel shows: a Spotify playlist's or album's (its
 * Spotify id, found on YouTube when picked) or a YouTube playlist's video
 * (its video id, opened straight away).
 */
export const spotifyPlaylistTrackSchema = z.object({
  id: z.string(),
  /** The song's Spotify link, or the video's YouTube link. */
  url: z.string(),
  title: z.string(),
  /** As Spotify shows them: "Daft Punk, Pharrell Williams". A YouTube video's channel. */
  artists: z.string(),
  /** Length in seconds. */
  duration: z.number().nullable(),
  explicit: z.boolean(),
  /** A YouTube video's thumbnail (Spotify's songs have none). */
  thumbnail: z.string().optional(),
});

export type SpotifyPlaylistTrack = z.infer<typeof spotifyPlaylistTrackSchema>;

/** Where a playlist comes from. */
export const playlistSources = ["spotify", "youtube"] as const;
export type PlaylistSource = (typeof playlistSources)[number];

/**
 * A playlist the panel shows: a public Spotify playlist or album, read from
 * Spotify's embed page (no account needed), or a public YouTube playlist.
 */
/** The most songs the app lists of a Spotify playlist. */
export const SPOTIFY_PLAYLIST_MAX_SONGS = 1000;

/**
 * Why the app lists no more of a Spotify playlist: Spotify refused (HTTP 429,
 * "too many requests", with a time to ask again), the request failed, Spotify
 * shares only the first 100 songs of its own playlists (HTTP 404), or the
 * app's limit of `SPOTIFY_PLAYLIST_MAX_SONGS`.
 */
export const playlistMoreReasons = ["refused", "failed", "spotify-own", "limit"] as const;

export const spotifyPlaylistSchema = z.object({
  source: z.enum(playlistSources).default("spotify"),
  kind: z.enum(["playlist", "album"]),
  id: z.string(),
  url: z.string(),
  name: z.string(),
  /** Who made it: the playlist's owner, or the album's artists. */
  by: z.string().nullable(),
  /** Cover art. */
  image: z.string().nullable(),
  tracks: z.array(spotifyPlaylistTrackSchema),
  /**
   * True if there may be more: Spotify shares only the first 100 songs of its own
   * playlists, and the app lists at most `SPOTIFY_PLAYLIST_MAX_SONGS` songs of a
   * Spotify playlist and the first 500 videos of a YouTube playlist.
   */
  maybeMore: z.boolean(),
  /**
   * Why a Spotify playlist stopped short, when the app knows: with
   * `maybeMore` but without this, the embed page listed 100 songs and gave
   * no way to ask for the rest.
   */
  more: z
    .object({
      reason: z.enum(playlistMoreReasons),
      /**
       * When the app asks Spotify again (ISO 8601): for "refused", the time
       * Spotify gave (Retry-After); for "failed", a minute on.
       */
      retryAt: z.string().optional(),
      /** For "failed": what went wrong, in a few words ("HTTP 503", "no connection"). */
      note: z.string().optional(),
    })
    .optional(),
});

export type SpotifyPlaylist = z.infer<typeof spotifyPlaylistSchema>;

/** Signing in with Spotify, as the page sees it (never the passes themselves). */
export const spotifyAccountSchema = z.object({
  /** Can this browser sign in? Only one on the computer running the app can. */
  canSignIn: z.boolean(),
  /** Your Spotify app's Client ID, or null before you've added one. */
  clientId: z.string().nullable(),
  /** Who is signed in (their Spotify name), or null. */
  signedInAs: z.string().nullable(),
  /** The Redirect URI to add to your Spotify app: this app's, on 127.0.0.1. */
  redirectUri: z.string(),
  /** Why the last sign-in didn't work, or null. */
  error: z.string().nullable(),
});
export type SpotifyAccount = z.infer<typeof spotifyAccountSchema>;

/** One of your playlists on Spotify, in the list of them. */
export const ownPlaylistSchema = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string(),
  by: z.string().nullable(),
  image: z.string().nullable(),
  songs: z.number(),
});
export type OwnPlaylist = z.infer<typeof ownPlaylistSchema>;
export type PlaylistMore = NonNullable<SpotifyPlaylist["more"]>;

/**
 * Housekeeping's bar for a song's sound: songs below it are listed as low
 * quality. A bitrate in kbps (lossless files always pass), "lossless" for
 * lossless files only, or "off" not to look.
 */
export const qualityBars = ["off", "128", "192", "256", "lossless"] as const;
export const qualityBarSchema = z.enum(qualityBars);
export type QualityBar = z.infer<typeof qualityBarSchema>;

/** The "Save to" setting as the page sees it. */
export const saveSettingsSchema = z.object({
  /** Folder downloads are saved into, or null for the browser's own downloads. */
  saveFolder: z.string().nullable(),
  /**
   * Can this browser save into a folder? Only one on the computer running the
   * app can — elsewhere (e.g. a phone) downloads go to that device instead.
   */
  canSaveToFolder: z.boolean(),
  /**
   * The CPU cores of the computer running the app: "Download all" works on
   * this many songs at once. (The page may be on a phone, whose own count
   * says nothing about the app's computer.)
   */
  cpuCores: z.number().int().positive(),
  /** Housekeeping's bar for a song's sound (see qualityBars). */
  qualityBar: qualityBarSchema.default("128"),
});

export type SaveSettings = z.infer<typeof saveSettingsSchema>;

export const folderEntrySchema = z.object({ name: z.string(), path: z.string() });
export type FolderEntry = z.infer<typeof folderEntrySchema>;

/** One folder's contents in the folder browser, plus quick links to common places. */
export const folderListingSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  folders: z.array(folderEntrySchema),
  places: z.array(folderEntrySchema),
});

export type FolderListing = z.infer<typeof folderListingSchema>;

/** A song to look for in the "Save to" folder: a Spotify playlist's song, or a YouTube playlist's video. */
export const songToFindSchema = z.object({
  id: z.union([spotifyIdSchema, youtubeVideoIdSchema]),
  title: z.string().max(500),
  /** As Spotify shows them: "Daft Punk, Pharrell Williams". */
  artists: z.string().max(1000),
});

export type SongToFind = z.infer<typeof songToFindSchema>;

/** A song for "Save playlist file": a song to find, and its length for the playlist's list. */
export const playlistFileSongSchema = songToFindSchema.extend({
  /** Length in seconds. */
  duration: z.number().nonnegative().nullable().optional(),
});

export type PlaylistFileSong = z.infer<typeof playlistFileSongSchema>;

/** The playlist file written into the "Save to" folder. */
export const savedPlaylistFileSchema = z.object({
  /** Its name in the folder: "Road Trip.m3u8". */
  file: z.string(),
  /** How many songs it lists. */
  songs: z.number(),
  /** The playlist's songs that aren't in the folder (so aren't listed). */
  missing: z.number(),
  /** It replaced a playlist file the app had written before. */
  replaced: z.boolean(),
});

export type SavedPlaylistFile = z.infer<typeof savedPlaylistFileSchema>;

/**
 * How a song was recognised in the folder: by the Spotify song saved in the
 * file's tags (files this app downloads have it), by its title and artist (in
 * the tags, the file name or the folders it's in), or by a file named just
 * like the song with no artist to say otherwise.
 */
export const foundByValues = ["spotify", "title-artist", "title"] as const;

/** Which of a playlist's songs are already in the "Save to" folder. */
export const songsInFolderSchema = z.object({
  folder: z.string(),
  /** How many audio files the folder (and its subfolders) has. */
  files: z.number(),
  /** False if the folder has more files than the app looks at (see MAX_SONG_FILES). */
  complete: z.boolean(),
  /** Song id → the file that is that song (its path inside the folder). */
  found: z.record(z.string(), z.object({ file: z.string(), by: z.enum(foundByValues) })),
});

export type SongsInFolder = z.infer<typeof songsInFolderSchema>;

/** A song's id in the music player: where it is in the folder, hashed (see server/music.ts). */
export const musicIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "That isn't a song id");

/** A song in the "Save to" folder, as the music player lists it. */
export const musicTrackSchema = z.object({
  id: z.string(),
  /** Where it is inside the folder: "Queen\Greatest Hits\Bohemian Rhapsody.mp3". */
  path: z.string(),
  /** Its title tag, or else its file name (without the extension). */
  title: z.string(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  /** Its genre tags, each once (none when it has no genre tag). */
  genres: z.array(z.string()).default([]),
  /** The year its tags give. */
  year: z.number().int().nullable().default(null),
  /** Length in seconds, when the file says. */
  duration: z.number().nullable(),
  /** When it arrived in the folder (ISO 8601), for "Recently added". */
  addedAt: z.string(),
  size: z.number(),
  /** Its content is another kind of audio than its name says: the extension it should have (".m4a"). */
  realType: z.string().nullable().default(null),
  /** It isn't audio at all, by its content: what it is ("a Windows program"). It isn't played. */
  notAudio: z.string().nullable().default(null),
  /** Fill in details found nothing for it in any music catalogue (server/not-found.ts). */
  detailsNotFound: z.boolean().default(false),
});

export type MusicTrack = z.infer<typeof musicTrackSchema>;

/** The songs in the "Save to" folder (and its subfolders), for the music player. */
export const musicLibrarySchema = z.object({
  folder: z.string(),
  /** False if the folder has more files than the app looks at (see MAX_SONG_FILES). */
  complete: z.boolean(),
  tracks: z.array(musicTrackSchema),
});

export type MusicLibrary = z.infer<typeof musicLibrarySchema>;

/**
 * How a download in the history was recognised in the folder: by the file
 * name it was saved under (or, for an older entry, its title as a file name),
 * by the Spotify song in the file's tags, or by its title and artist.
 */
export const historyFoundByValues = ["file", "spotify", "title-artist", "title"] as const;

/** Which downloads in the history are (still) in the "Save to" folder. */
export const historyInFolderSchema = z.object({
  folder: z.string(),
  /** False if the folder has more files than the app looks at (see MAX_SONG_FILES). */
  complete: z.boolean(),
  /** History entry id → the song in the folder (its id for the player, and its path). */
  found: z.record(
    z.string(),
    z.object({ song: z.string(), file: z.string(), by: z.enum(historyFoundByValues) }),
  ),
});

export type HistoryInFolder = z.infer<typeof historyInFolderSchema>;

/** The details "Fill in details" can add to a song that lacks them. */
export const songDetailFields = [
  "title",
  "artist",
  "album",
  "genre",
  "year",
  "track",
  "cover",
] as const;
export type SongDetailField = (typeof songDetailFields)[number];

/** A song's details, as a music catalogue gives them (the cover as its address there). */
export const songDetailsSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  artist: z.string().trim().min(1).max(500).optional(),
  album: z.string().trim().min(1).max(500).optional(),
  genre: z.string().trim().min(1).max(200).optional(),
  year: z.number().int().min(1000).max(9999).optional(),
  track: z.number().int().min(1).max(9999).optional(),
  coverUrl: z.string().max(2000).optional(),
});

export type SongDetails = z.infer<typeof songDetailsSchema>;

/** What a folder song lacks, and what the music catalogues have for it. */
export const songLookupSchema = z.object({
  missing: z.array(z.enum(songDetailFields)),
  /** Can the app write tags into this kind of file? (Not a .wma or .wav, say.) */
  writable: z.boolean(),
  /** Why a file of a kind the app writes can't be written after all (its contents aren't what its name says). */
  problem: z.string().nullable().default(null),
  /** For a song not found (or with nothing to add): each search and why its answers weren't it. */
  notes: z.array(z.string()).default([]),
  /** What was found, just for the details it lacks — null when nothing was. */
  found: songDetailsSchema.nullable(),
  /**
   * The catalogue's song it matched, to show who's who before anything is
   * written — with `note` when it isn't the song's own details: another
   * version's genre, or the artist's.
   */
  match: z
    .object({
      title: z.string(),
      artist: z.string(),
      album: z.string().nullable(),
      note: z.string().nullable().default(null),
    })
    .nullable(),
  /**
   * The catalogue that answered — or "name" for a song with no title or
   * artist tags that no catalogue has: its "Artist - Song" file name's two halves
   * — or "artist" for a genre guessed from the artist alone (`guess`).
   */
  source: z.enum(["itunes", "deezer", "musicbrainz", "name", "artist"]).nullable(),
  /**
   * The genre found is a guess from the song's artist (no catalogue has one for the
   * song itself), and why: "3 of Linkin Park's other songs here are Rock". `source`
   * is "artist" when that's all that was found.
   */
  guess: z.string().nullable().default(null),
  /** Every catalogue answered and none has it (nor does its name say): marked Not found. */
  notFound: z.boolean().default(false),
});

export type SongLookup = z.infer<typeof songLookupSchema>;

/** What writing a song's details added, and the song as it is now. */
export const songDetailsWrittenSchema = z.object({
  added: z.array(z.enum(songDetailFields)),
  track: musicTrackSchema,
});

export type SongDetailsWritten = z.infer<typeof songDetailsWrittenSchema>;

/** A stretch of a song, in seconds from its start. */
export const timeRangeSchema = z.object({ start: z.number(), end: z.number() });
export type TimeRange = z.infer<typeof timeRangeSchema>;

/** A song's waveform, for picking the part to cut out (see server/trim.ts). */
export const waveformSchema = z.object({
  /** The song's length in seconds, as decoded. */
  duration: z.number(),
  /** How loud each equal slice of the song gets at its loudest, from 0 to 1. */
  peaks: z.array(z.number()),
  /** The quiet stretches (dead air) a second or longer, in order. */
  silences: z.array(timeRangeSchema),
});
export type Waveform = z.infer<typeof waveformSchema>;

/** What to cut out of a song: the part from `start` to `end` (seconds). */
export const trimInputSchema = z
  .object({
    start: z.number().finite().min(0, "The cut can't start before the song does"),
    end: z.number().finite(),
  })
  .refine((cut) => cut.end - cut.start >= 0.05, {
    error: "Pick a part to cut out: its end must come after its start",
    path: ["end"],
  });

/** A song with a part cut out of it. */
export const trimmedSongSchema = z.object({
  /** Its id (unchanged: it's the same file). */
  id: z.string(),
  /** Seconds taken out, and how long it is now. */
  removed: z.number(),
  duration: z.number(),
  /** Hands the original back (Undo); its copy is kept in the backup folder until then. */
  undo: z.string(),
});
export type TrimmedSong = z.infer<typeof trimmedSongSchema>;

/** Which trim to undo. */
export const trimUndoSchema = z.object({
  undo: z.string().regex(/^[a-f0-9]{24}$/, "That isn't a trim the app can undo"),
});

/** A song deleted from the "Save to" folder: to the Recycle Bin / Trash (`trashed`), or for good. */
export const deletedSongSchema = z.object({
  trashed: z.boolean(),
  /** What the bin is called on the computer running the app: "Recycle Bin" or "Trash". */
  bin: z.string(),
});

export type DeletedSong = z.infer<typeof deletedSongSchema>;

/** A song given the extension its content says it should have: its new id and place in the folder. */
export const renamedSongSchema = z.object({
  id: z.string(),
  path: z.string(),
});

export type RenamedSong = z.infer<typeof renamedSongSchema>;

/** Sanitize Filename's answer: the song as it is now, under its new name (and id). */
export const sanitizedSongSchema = z.object({ track: musicTrackSchema });

export type SanitizedSong = z.infer<typeof sanitizedSongSchema>;

/** Housekeeping's check of one folder song: what's wrong with it, and how it's encoded. */
export const songCheckSchema = z.object({
  /** It isn't audio, by its content: what it is ("a Windows program"). */
  notAudio: z.string().nullable(),
  /** It ends long before the length its header gives: how far it plays, and what it says. */
  cutShort: z.object({ plays: z.number(), says: z.number() }).nullable(),
  /** It can't be read through: why. */
  damaged: z.string().nullable(),
  /** How long it plays (or, if that's unknown, says it is), in seconds. */
  seconds: z.number().nullable(),
  /** Its average bitrate, for a lossy file. */
  kbps: z.number().nullable(),
  lossless: z.boolean(),
  /** "MPEG 1 Layer 3", "AAC", "FLAC"… as music-metadata names it. */
  codec: z.string().nullable(),
});

export type SongCheck = z.infer<typeof songCheckSchema>;

/** A better copy of a low-quality folder song, found online (Housekeeping's better copies). */
export const betterCopySchema = z.object({
  /** The upload's canonical link, to replace the song with. */
  url: z.string(),
  title: z.string(),
  channel: z.string(),
  source: z.enum(audioSources),
  /** Its length in seconds, as the search listed it. */
  seconds: z.number().nullable(),
  /** The bitrate of the audio it gives, in kbps: higher than the song's. */
  kbps: z.number(),
  /** "Opus", "AAC", "MP3"… */
  codec: z.string().nullable(),
});

export type BetterCopy = z.infer<typeof betterCopySchema>;

/** A look for a better copy of a song: its own bitrate, and the copy found — or why there's none. */
export const betterCopyLookupSchema = z.object({
  /** The song's own bitrate (null when it's lossless or unknown). */
  kbps: z.number().nullable(),
  copy: betterCopySchema.nullable(),
  /** Why no copy is offered: "The best copy found is 128 kbps, no better than this one's 128 kbps." */
  reason: z.string().nullable(),
});

export type BetterCopyLookup = z.infer<typeof betterCopyLookupSchema>;

/** A song replaced by a better copy: as it is now, its check, and where the old one went. */
export const replacedSongSchema = z.object({
  track: musicTrackSchema,
  check: songCheckSchema,
  /** The bin the old copy went to: "Recycle Bin" or "Trash". */
  bin: z.string(),
});

export type ReplacedSong = z.infer<typeof replacedSongSchema>;

/** A file in the "Save to" folder that isn't a song (Housekeeping), by an id like a song's. */
export const folderFileSchema = z.object({
  id: z.string(),
  path: z.string(),
  size: z.number(),
  /** What it is: "a picture", "a Windows program", "a download that didn't finish", "a TXT file". */
  what: z.string(),
  /** Left behind by a download that didn't finish (".part"): nothing to keep. */
  leftover: z.boolean(),
});

export type FolderFile = z.infer<typeof folderFileSchema>;

export const folderFilesSchema = z.object({ files: z.array(folderFileSchema) });

/**
 * A `409` for a delete that would have had to be for good — the song's drive
 * has no bin (a network or removable drive) — so it's left where it is.
 */
export const noBinSchema = z.object({
  message: z.string(),
  bin: z.string(),
  noBin: z.literal(true),
});

/**
 * Saving into the folder streams one JSON object per line: progress while the
 * audio arrives, then "done" (or "error").
 */
export const saveEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), bytes: z.number() }),
  z.object({
    type: z.literal("done"),
    fileName: z.string(),
    folder: z.string(),
    path: z.string(),
    bytes: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type SaveEvent = z.infer<typeof saveEventSchema>;

/**
 * How the outside sources the app depends on have been answering (the last
 * 24 hours), as `GET /api/health/sources` and `data/source-health.json` report
 * it (see server/source-health.ts). A source is `primary` for a job (`for`),
 * or a `fallback` tried when the primary fails.
 */
export const sourceRoles = ["primary", "fallback"] as const;

export const sourceHealthSchema = z.object({
  role: z.enum(sourceRoles),
  /** The job it's for: "audio", "song details". */
  for: z.string(),
  /** Attempts that worked, in the last 24 hours. */
  ok: z.number(),
  failed: z.number(),
  /** Of the failed: the source said to slow down (HTTP 429, "too many requests"). */
  throttled: z.number(),
  /** When it last worked (ISO 8601), or null. */
  lastOk: z.string().nullable(),
  /** What its last failure said, or null. */
  lastError: z.string().nullable(),
  /**
   * Until when (ISO 8601) the source has told the app to wait (an HTTP 429's
   * Retry-After), while that's still to come; else null.
   */
  refusedUntil: z.string().nullable(),
});

export type SourceHealth = z.infer<typeof sourceHealthSchema>;

export const sourceHealthReportSchema = z.object({
  updatedAt: z.string(),
  /**
   * True when some job can't be done: its primary source is unreliable (at
   * least 5 attempts in 24 hours, under half of them successful, or refusing
   * the app for more than another hour) and so is every fallback that could
   * stand in for it.
   */
  unreliable: z.boolean(),
  /** One plain sentence: "YouTube: 2 of 20 requests succeeded in the last 24 h (last error: …)." */
  summary: z.string(),
  sources: z.record(z.string(), sourceHealthSchema),
});

export type SourceHealthReport = z.infer<typeof sourceHealthReportSchema>;
