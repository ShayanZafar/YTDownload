import { z } from "zod";
import {
  downloadSchema,
  folderEntrySchema,
  folderListingSchema,
  musicLibrarySchema,
  saveSettingsSchema,
  searchResultSchema,
  songToFindSchema,
  songsInFolderSchema,
  spotifyIdSchema,
  spotifyPlaylistSchema,
  spotifyTrackSchema,
} from "./schema";

/**
 * What the download endpoint can produce:
 * - "mp3": converted to a 320 kbps MP3 — plays everywhere (the default).
 * - "original": YouTube's own audio stream, not re-encoded — smaller and
 *   untouched, saved as .opus (or .m4a when YouTube only has AAC).
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
};

export const api = {
  downloads: {
    list: {
      method: "GET" as const,
      path: "/api/downloads" as const,
      responses: {
        200: z.array(downloadSchema),
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
        }),
        400: errorSchemas.validation,
        500: errorSchemas.internal,
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
      }),
      responses: {
        200: z.object({
          results: z.array(searchResultSchema),
          /** Present when the search was a Spotify song link: the song it points to. */
          spotify: spotifyTrackSchema.optional(),
        }),
        400: errorSchemas.validation,
        404: errorSchemas.notFound,
        500: errorSchemas.internal,
        502: errorSchemas.internal,
      },
    },
    download: {
      method: "GET" as const,
      path: "/api/video/download" as const,
      query: z.object({
        url: z.string().min(1, "Missing YouTube URL"),
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
        url: z.string().min(1, "Missing YouTube URL"),
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
    /** The songs in a public Spotify playlist or album (the first 100 of a playlist). */
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
  settings: {
    get: {
      method: "GET" as const,
      path: "/api/settings" as const,
      responses: { 200: saveSettingsSchema },
    },
    update: {
      method: "PUT" as const,
      path: "/api/settings" as const,
      input: z.object({
        /** A folder on this computer, or null to go back to the browser's downloads. */
        saveFolder: z.string().max(1000).nullable(),
      }),
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
