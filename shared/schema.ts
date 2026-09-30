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
export type InsertDownload = Pick<Download, "url" | "title">;
