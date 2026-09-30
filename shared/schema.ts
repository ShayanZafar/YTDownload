import { z } from "zod";

/** One entry in the download history (stored in data/history.json by the server). */
export const downloadSchema = z.object({
  id: z.number().int(),
  url: z.string(),
  title: z.string(),
  /** ISO 8601 timestamp, e.g. "2026-09-29T22:58:44.009Z". */
  downloadedAt: z.string(),
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
export type InsertDownload = Pick<Download, "url" | "title">;
