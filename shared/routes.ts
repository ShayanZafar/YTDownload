import { z } from "zod";
import {
  audioSources,
  deletedSongSchema,
  folderFilesSchema,
  qualityBarSchema,
  youtubeSignInSchema,
  songCheckSchema,
  betterCopyLookupSchema,
  replacedSongSchema,
  renamedSongSchema,
  sanitizedSongSchema,
  downloadSchema,
  folderEntrySchema,
  lyricsSchema,
  folderListingSchema,
  musicLibrarySchema,
  historyInFolderSchema,
  songDetailsSchema,
  songDetailsWrittenSchema,
  songLookupSchema,
  trimInputSchema,
  trimUndoSchema,
  trimmedSongSchema,
  waveformSchema,
  noBinSchema,
  playlistFileSongSchema,
  saveSettingsSchema,
  savedPlaylistFileSchema,
  searchResultSchema,
  songToFindSchema,
  songsInFolderSchema,
  sourceHealthReportSchema,
  spotifyIdSchema,
  spotifyPlaylistSchema,
  spotifyAccountSchema,
  ownPlaylistSchema,
  spotifyTrackSchema,
} from "./schema";

/**
 * What the download endpoint can produce:
 * - "mp3": converted to a 320 kbps MP3 — plays everywhere (the default).
 * - "original": the source's own audio stream, not re-encoded — smaller and
 *   untouched, saved as .opus (or .m4a when YouTube only has AAC; SoundCloud's
 *   MP3 stays an .mp3).
 */
export const downloadFormats = ["mp3", "original"] as const;
export type DownloadFormat = (typeof downloadFormats)[number];

export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
  /**
   * A `502` for a request YouTube refused because it's limiting this computer
   * (throttled, or a bot check): the usual message — what to do instead — plus
   * which source refused and `limited: true`. Answered at once: the app never
   * waits it out.
   */
  limited: z.object({
    message: z.string(),
    source: z.string(),
    limited: z.literal(true),
  }),
};

export type LimitedError = z.infer<typeof errorSchemas.limited>;

/** A `502`: a source failed (`{ message }`), or YouTube refused (`limited`). */
const upstreamError = z.union([errorSchemas.limited, errorSchemas.internal]);

export const api = {
  downloads: {
    list: {
      method: "GET" as const,
      path: "/api/downloads" as const,
      responses: {
        200: z.array(downloadSchema),
      },
    },
    /** Takes one entry out of the history (the file it downloaded stays). Answers with the entry. */
    remove: {
      method: "DELETE" as const,
      path: "/api/downloads/:id" as const,
      responses: { 200: downloadSchema, 404: errorSchemas.notFound },
    },
    /** Empties the history. Answers with the entries it had, so they can be put back. */
    clear: {
      method: "DELETE" as const,
      path: "/api/downloads" as const,
      responses: { 200: z.array(downloadSchema) },
    },
    /**
     * Which downloads are in the "Save to" folder still, to play them from it
     * (on the computer running the app only).
     */
    inFolder: {
      method: "GET" as const,
      path: "/api/downloads/in-folder" as const,
      responses: { 200: historyInFolderSchema },
    },
    /** Puts removed entries back (Undo), in date order; entries still there are skipped. */
    restore: {
      method: "POST" as const,
      path: "/api/downloads/restore" as const,
      input: z.object({ entries: z.array(downloadSchema).max(1000, "Too many entries") }),
      responses: { 200: z.array(downloadSchema) },
    },
  },
  /** A song's lyrics (from LRCLIB), for the music player. */
  lyrics: {
    get: {
      method: "GET" as const,
      path: "/api/lyrics" as const,
      query: z.object({
        title: z.string().trim().min(1, "Which song?").max(300, "That title is too long"),
        artist: z.string().trim().max(300, "That artist is too long").optional(),
        /** The song's length in seconds, to tell recordings apart. */
        duration: z.coerce
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60)
          .optional(),
      }),
      responses: {
        /** null: LRCLIB doesn't have them. */
        200: z.object({ lyrics: lyricsSchema.nullable() }),
        400: errorSchemas.validation,
        502: errorSchemas.internal,
      },
    },
  },
  video: {
    info: {
      method: "POST" as const,
      path: "/api/video/info" as const,
      input: z.object({ url: z.url() }),
      responses: {
        200: z.object({
          title: z.string(),
          thumbnail: z.string(),
          url: z.string(),
          /** Who uploaded it: with the title, it says the song's artist (shared/song-name.ts). */
          channel: z.string().optional(),
        }),
        400: errorSchemas.validation,
        500: errorSchemas.internal,
        502: errorSchemas.limited,
      },
    },
    search: {
      method: "GET" as const,
      path: "/api/search" as const,
      query: z.object({
        q: z
          .string({ error: "Type something to search for" })
          .trim()
          .min(1, "Type something to search for")
          .max(200, "That search is too long"),
        /**
         * "soundcloud": search SoundCloud alone — for a song YouTube refused to
         * hand over. Left out: YouTube, with SoundCloud as its fallback.
         */
        source: z.literal("soundcloud", { error: 'source must be "soundcloud"' }).optional(),
      }),
      responses: {
        200: z.object({
          results: z.array(searchResultSchema),
          /** Which source the results are from (each result says so too). */
          source: z.enum(audioSources),
          /** Present when the search was a Spotify song link: the song it points to. */
          spotify: spotifyTrackSchema.optional(),
        }),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        500: errorSchemas.internal,
        502: upstreamError,
      },
    },
    download: {
      method: "GET" as const,
      path: "/api/video/download" as const,
      query: z.object({
        /** A YouTube video's link, or a SoundCloud track's canonical link (a search result's). */
        url: z.string().min(1, "Missing YouTube or SoundCloud link"),
        format: z
          .enum(downloadFormats, { error: 'format must be "mp3" or "original"' })
          .default("mp3"),
        /** File name to save as (without extension); the video's title if left out. */
        name: z.string().max(300, "That file name is too long").optional(),
        /** The Spotify song this is, kept with the history entry. */
        spotifyId: spotifyIdSchema.optional(),
      }),
    },
    /** Download straight into the "Save to" folder (streams progress as JSON lines). */
    save: {
      method: "POST" as const,
      path: "/api/video/save" as const,
      input: z.object({
        url: z.string().min(1, "Missing YouTube or SoundCloud link"),
        format: z
          .enum(downloadFormats, { error: 'format must be "mp3" or "original"' })
          .default("mp3"),
        name: z.string().max(300, "That file name is too long").optional(),
        spotifyId: spotifyIdSchema.optional(),
      }),
    },
  },
  spotify: {
    /**
     * Where a Spotify link leads, as its open.spotify.com address: a
     * spotify.link short link is opened to find out.
     */
    link: {
      method: "GET" as const,
      path: "/api/spotify/link" as const,
      query: z.object({
        link: z
          .string({ error: "Paste a Spotify link" })
          .trim()
          .min(1, "Paste a Spotify link")
          .max(500, "That link is too long"),
      }),
      responses: {
        200: z.object({
          kind: z.enum(["track", "playlist", "album"]),
          url: z.string(),
        }),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        502: errorSchemas.internal,
      },
    },
    /** The songs in a public Spotify playlist or album (up to 1,000 songs of a playlist). */
    playlist: {
      method: "GET" as const,
      path: "/api/spotify/playlist" as const,
      query: z.object({
        link: z
          .string({ error: "Paste a Spotify playlist link" })
          .trim()
          .min(1, "Paste a Spotify playlist link")
          .max(500, "That link is too long"),
      }),
      responses: {
        200: spotifyPlaylistSchema,
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        502: errorSchemas.internal,
      },
    },
  },
  /**
   * Signing in with Spotify, so your own playlists list whole (see
   * server/spotify-sign-in.ts). Only a browser on the computer running the
   * app can see or change it.
   */
  spotifyAccount: {
    /** Whether there's a Client ID, who is signed in, and the address to give Spotify. */
    status: {
      method: "GET" as const,
      path: "/api/spotify/account" as const,
      responses: { 200: spotifyAccountSchema },
    },
    /** Sets (or, with null, removes) your Spotify app's Client ID; a new one signs you out. */
    clientId: {
      method: "PUT" as const,
      path: "/api/spotify/account/client-id" as const,
      input: z.object({ clientId: z.string().max(100).nullable() }),
      responses: { 200: spotifyAccountSchema, 400: errorSchemas.validation },
    },
    /** Starts a sign-in: where to send the browser (Spotify's sign-in page). */
    signIn: {
      method: "POST" as const,
      path: "/api/spotify/account/sign-in" as const,
      responses: { 200: z.object({ url: z.string() }), 400: errorSchemas.validation },
    },
    signOut: {
      method: "POST" as const,
      path: "/api/spotify/account/sign-out" as const,
      responses: { 200: spotifyAccountSchema },
    },
    /** Your playlists on Spotify, to open one without finding its link. */
    playlists: {
      method: "GET" as const,
      path: "/api/spotify/account/playlists" as const,
      responses: {
        200: z.array(ownPlaylistSchema),
        401: errorSchemas.validation,
        502: errorSchemas.internal,
      },
    },
  },
  youtube: {
    /** The videos in a public YouTube playlist (the first 500). */
    playlist: {
      method: "GET" as const,
      path: "/api/youtube/playlist" as const,
      query: z.object({
        link: z
          .string({ error: "Paste a YouTube playlist link" })
          .trim()
          .min(1, "Paste a YouTube playlist link")
          .max(500, "That link is too long"),
      }),
      responses: {
        200: spotifyPlaylistSchema,
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        502: upstreamError,
      },
    },
  },
  health: {
    /**
     * How YouTube, SoundCloud and Spotify have been answering over the last 24
     * hours (the same report as `data/source-health.json`; see
     * server/source-health.ts).
     */
    sources: {
      method: "GET" as const,
      path: "/api/health/sources" as const,
      responses: { 200: sourceHealthReportSchema },
    },
  },
  settings: {
    get: {
      method: "GET" as const,
      path: "/api/settings" as const,
      responses: { 200: saveSettingsSchema },
    },
    update: {
      method: "PUT" as const,
      path: "/api/settings" as const,
      input: z
        .object({
          /** A folder on this computer, or null to go back to the browser's downloads. */
          saveFolder: z.string().max(1000).nullable().optional(),
          /** Housekeeping's bar for a song's sound. */
          qualityBar: qualityBarSchema.optional(),
          /** Whose YouTube sign-in to use when YouTube asks for one. */
          youtubeSignIn: youtubeSignInSchema.optional(),
        })
        .refine(
          (input) =>
            input.saveFolder !== undefined ||
            input.qualityBar !== undefined ||
            input.youtubeSignIn !== undefined,
          { message: "Give a folder, a quality bar or a YouTube sign-in." },
        ),
      responses: { 200: saveSettingsSchema, 400: errorSchemas.validation },
    },
  },
  folders: {
    list: {
      method: "GET" as const,
      path: "/api/folders" as const,
      query: z.object({ path: z.string().max(1000).optional() }),
      responses: { 200: folderListingSchema },
    },
    create: {
      method: "POST" as const,
      path: "/api/folders" as const,
      input: z.object({
        parent: z.string().min(1).max(1000),
        name: z.string().min(1, "Give the new folder a name").max(200),
      }),
      responses: { 201: folderEntrySchema },
    },
    /** Which of these songs are already in the "Save to" folder (or its subfolders). */
    songs: {
      method: "POST" as const,
      path: "/api/folders/songs" as const,
      input: z.object({
        songs: z.array(songToFindSchema).max(1000, "That's too many songs to look for at once"),
      }),
      responses: { 200: songsInFolderSchema },
    },
    /**
     * Writes a playlist's songs that are in the "Save to" folder into it as an
     * .m3u8 playlist file, in the playlist's order (see server/playlist-file.ts).
     */
    playlistFile: {
      method: "POST" as const,
      path: "/api/folders/playlist-file" as const,
      input: z.object({
        name: z
          .string()
          .trim()
          .min(1, "The playlist needs a name")
          .max(300, "That playlist name is too long"),
        songs: z
          .array(playlistFileSongSchema)
          .min(1, "The playlist has no songs")
          .max(1000, "That's too many songs for one playlist file"),
      }),
      responses: { 201: savedPlaylistFileSchema },
    },
  },
  /**
   * The music player's songs: those in the "Save to" folder, for a browser on
   * the computer running the app. (A phone plays songs stored on the phone.)
   */
  music: {
    list: {
      method: "GET" as const,
      path: "/api/music" as const,
      responses: { 200: musicLibrarySchema },
    },
    /** A song's file, untouched — range requests work, so the player can seek. */
    audio: { method: "GET" as const, path: "/api/music/:id" as const },
    /** A song converted to FLAC (lossless), for a browser that can't play the file itself. */
    flac: { method: "GET" as const, path: "/api/music/:id/flac" as const },
    /** A song's cover picture, from its tags — 204 when it has none. */
    cover: { method: "GET" as const, path: "/api/music/:id/cover" as const },
    /** A song's waveform and quiet stretches, for picking what to cut out. */
    waveform: {
      method: "GET" as const,
      path: "/api/music/:id/waveform" as const,
      responses: { 200: waveformSchema },
    },
    /**
     * Cuts a part out of a song and joins the rest (dead air, say), keeping
     * its tags and cover. The original is kept as a backup, for Undo.
     */
    trim: {
      method: "POST" as const,
      path: "/api/music/:id/trim" as const,
      input: trimInputSchema,
      responses: { 200: trimmedSongSchema },
    },
    /** Puts a trimmed song's original back. */
    undoTrim: {
      method: "POST" as const,
      path: "/api/music/trim/undo" as const,
      input: trimUndoSchema,
      responses: { 200: trimmedSongSchema.pick({ id: true, duration: true }) },
    },
    /**
     * Fill in details: what a song's tags lack, and what the music catalogues
     * (iTunes, Deezer, MusicBrainz) have for it. Nothing is written.
     */
    lookUpDetails: {
      method: "GET" as const,
      path: "/api/music/:id/details" as const,
      responses: { 200: songLookupSchema },
    },
    /** Writes the details a song still lacks into its file; tags it has stay as they are. */
    writeDetails: {
      method: "POST" as const,
      path: "/api/music/:id/details" as const,
      input: songDetailsSchema,
      responses: { 200: songDetailsWrittenSchema },
    },
    /**
     * The details log's newest lines, as plain text: each song looked up,
     * written or downloaded, and what happened and why (server/details-log.ts).
     */
    detailsLog: {
      method: "GET" as const,
      path: "/api/details-log" as const,
    },
    /**
     * Deletes a song from the folder: to the Recycle Bin / Trash, so it can be
     * put back from there — or for good, only when `permanently` says so
     * (a drive with no bin answers `409` with `noBin` instead).
     */
    remove: {
      method: "DELETE" as const,
      path: "/api/music/:id" as const,
      input: z.object({ permanently: z.boolean().optional() }),
      responses: { 200: deletedSongSchema, 409: noBinSchema },
    },
    /**
     * Housekeeping: reads a song all the way through (ffmpeg) and says what's
     * wrong with it — not audio, cut short, damaged — with its bitrate.
     * Nothing is changed.
     */
    check: {
      method: "GET" as const,
      path: "/api/music/:id/check" as const,
      responses: { 200: songCheckSchema },
    },
    /**
     * Housekeeping's better copies: the same song, at the same length, from
     * YouTube (else SoundCloud), when the audio it gives has a higher bitrate
     * than the song's — or why there's none. Nothing is changed.
     */
    findBetterCopy: {
      method: "GET" as const,
      path: "/api/music/:id/better-copy" as const,
      responses: { 200: betterCopyLookupSchema },
    },
    /**
     * Replaces the song with the copy at `url` (as `findBetterCopy` gave it),
     * in the song's own file type, with its tags and cover; the old song goes
     * to the bin. `409` if its drive has none (nothing changed), `422` if the
     * copy didn't check out.
     */
    replaceWithBetterCopy: {
      method: "POST" as const,
      path: "/api/music/:id/better-copy" as const,
      input: z.object({ url: z.string().min(1).max(2000) }),
      responses: { 200: replacedSongSchema },
    },
    /** Housekeeping: the folder's files that aren't songs (pictures, programs, leftovers). */
    otherFiles: {
      method: "GET" as const,
      path: "/api/folder-files" as const,
      responses: { 200: folderFilesSchema },
    },
    /** Deletes a file that isn't a song, as `remove` does a song: to the bin, or for good. */
    removeOtherFile: {
      method: "DELETE" as const,
      path: "/api/folder-files/:id" as const,
      input: z.object({ permanently: z.boolean().optional() }),
      responses: { 200: deletedSongSchema, 409: noBinSchema },
    },
    /**
     * Gives a song whose content is another kind of audio than its name says
     * (a ".mp3" that's really an M4A) the extension it should have. `409` if
     * its name is right already, or another file has that name.
     */
    fixName: {
      method: "POST" as const,
      path: "/api/music/:id/fix-name" as const,
      responses: { 200: renamedSongSchema },
    },
    /**
     * Rename, and Sanitize Filename: renames a song's file, in its own folder,
     * to `name` (made safe; its extension stays; never a numbered name), and/or
     * gives it a new `title` and `artist` tag. `409` if nothing would change,
     * or (nothing changed) another file has that name.
     */
    rename: {
      method: "POST" as const,
      path: "/api/music/:id/rename" as const,
      input: z
        .object({
          name: z.string().trim().min(1).max(300).optional(),
          title: z.string().trim().min(1).max(300).optional(),
          artist: z.string().trim().min(1).max(300).optional(),
        })
        .refine((input) => input.name ?? input.title ?? input.artist, {
          message: "Give a new name, title or artist.",
        }),
      responses: { 200: sanitizedSongSchema },
    },
  },
};

/**
 * Link for downloading a video's audio in the given format — saved under
 * `name` (made safe with safeFileName on the server) instead of the title,
 * and remembered in the history as `spotifyId` when it's a Spotify song.
 */
export function buildDownloadUrl(
  videoUrl: string,
  format: DownloadFormat = "mp3",
  { name, spotifyId }: { name?: string; spotifyId?: string } = {},
): string {
  const params = new URLSearchParams({ url: videoUrl });
  if (format !== "mp3") params.set("format", format);
  if (name?.trim()) params.set("name", name.trim());
  if (spotifyId) params.set("spotifyId", spotifyId);
  return `${api.video.download.path}?${params}`;
}

export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}
