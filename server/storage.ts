import { db } from "./db";
import { downloads, type InsertDownload, type Download } from "@shared/schema";
import { desc } from "drizzle-orm";

export interface IStorage {
  getDownloads(): Promise<Download[]>;
  createDownload(download: InsertDownload): Promise<Download>;
}

export class DatabaseStorage implements IStorage {
  async getDownloads(): Promise<Download[]> {
    return await db.select().from(downloads).orderBy(desc(downloads.downloadedAt));
  }

  async createDownload(insertDownload: InsertDownload): Promise<Download> {
    const [download] = await db.insert(downloads).values(insertDownload).returning();
    return download;
  }
}

export const storage = new DatabaseStorage();
