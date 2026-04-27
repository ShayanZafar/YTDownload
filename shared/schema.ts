import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const downloads = pgTable("downloads", {
  id: serial("id").primaryKey(),
  url: text("url").notNull(),
  title: text("title").notNull(),
  downloadedAt: timestamp("downloaded_at").defaultNow(),
});

export const insertDownloadSchema = createInsertSchema(downloads).omit({
  id: true,
  downloadedAt: true,
});

export type Download = typeof downloads.$inferSelect;
export type InsertDownload = z.infer<typeof insertDownloadSchema>;
