import { z } from "zod";
import { downloadSchema, searchResultSchema, spotifyTrackSchema } from "./schema";

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
      input: z.object({ url: z.string().url() }),
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
          .string({
            required_error: "Type something to search for",
            invalid_type_error: "Type something to search for",
          })
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
          .enum(downloadFormats, {
            errorMap: () => ({ message: 'format must be "mp3" or "original"' }),
          })
          .default("mp3"),
      }),
    },
  },
};

/** Link for downloading a video's audio in the given format. */
export function buildDownloadUrl(videoUrl: string, format: DownloadFormat = "mp3"): string {
  const params = new URLSearchParams({ url: videoUrl });
  if (format !== "mp3") params.set("format", format);
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
