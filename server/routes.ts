import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import ytdl from "@distube/ytdl-core";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  app.get(api.downloads.list.path, async (req, res) => {
    try {
      const allDownloads = await storage.getDownloads();
      res.status(200).json(allDownloads);
    } catch (error) {
      res.status(500).json({ message: "Failed to fetch downloads" });
    }
  });

  app.post(api.video.info.path, async (req, res) => {
    try {
      const input = api.video.info.input.parse(req.body);
      
      if (!ytdl.validateURL(input.url)) {
        return res.status(400).json({ message: "Invalid YouTube URL" });
      }

      const info = await ytdl.getInfo(input.url);
      
      res.status(200).json({
        title: info.videoDetails.title,
        thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1]?.url || "",
        url: input.url
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      res.status(500).json({ message: err instanceof Error ? err.message : "Failed to get video info" });
    }
  });

  // Since download returns a file, we won't use our json-based response schema
  app.get('/api/video/download', async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url || !ytdl.validateURL(url)) {
        return res.status(400).send("Invalid or missing YouTube URL");
      }

      const info = await ytdl.getInfo(url);
      const title = info.videoDetails.title.replace(/[^\w\s-]/g, '');

      // Log download to database
      try {
        await storage.createDownload({ url, title });
      } catch (dbError) {
        console.error("Failed to log download", dbError);
      }

      res.header('Content-Disposition', `attachment; filename="${title}.mp3"`);
      res.header('Content-Type', 'audio/mpeg');
      res.header('Accept-Ranges', 'bytes');

      ytdl(url, {
        filter: 'audioonly',
        quality: 'highestaudio',
      }).pipe(res);

    } catch (err) {
      console.error(err);
      res.status(500).send(err instanceof Error ? err.message : "Failed to download video");
    }
  });

  return httpServer;
}
