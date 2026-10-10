import { z } from "zod";

/** A Spotify song, playlist or album id: 22 letters and digits. */
export const spotifyIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9]{22}$/, "That isn't a Spotify song id");

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
});

export type Download = z.infer<typeof downloadSchema>;

/** One song search result (a YouTube video). */
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
});

export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * Uploads within this many seconds of a Spotify song's length are treated as
 * the same recording (ranked first, and marked "Same length" in the results).
 */
export const SAME_LENGTH_SECONDS = 5;

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
});

export type SpotifyTrack = z.infer<typeof spotifyTrackSchema>;
export type InsertDownload = Pick<Download, "url" | "title" | "spotifyId">;

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
   * Spotify shares only the first 100 songs of a playlist this way, and the app
   * lists at most the first 500 videos of a YouTube playlist: true if there may be more.
   */
  maybeMore: z.boolean(),
});

export type SpotifyPlaylist = z.infer<typeof spotifyPlaylistSchema>;

/** The "Save to" setting as the page sees it. */
export const saveSettingsSchema = z.object({
  /** Folder downloads are saved into, or null for the browser's own downloads. */
  saveFolder: z.string().nullable(),
  /**
   * Can this browser save into a folder? Only one on the computer running the
   * app can — elsewhere (e.g. a phone) downloads go to that device instead.
   */
  canSaveToFolder: z.boolean(),
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
  /** Length in seconds, when the file says. */
  duration: z.number().nullable(),
  /** When it arrived in the folder (ISO 8601), for "Recently added". */
  addedAt: z.string(),
  size: z.number(),
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
