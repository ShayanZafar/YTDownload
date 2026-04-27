import type { Express } from "express";
import { createServer, type Server } from "http";
import { Readable } from "stream";
import { Innertube } from "youtubei.js";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";

// Lazy singleton — Innertube.create() does an HTTP handshake with YouTube,
// so we only want to do it once per process and reuse the client thereafter.
let innertubePromise: Promise<Innertube> | null = null;
function getInnertube(): Promise<Innertube> {
  if (!innertubePromise) {
    innertubePromise = Innertube.create();
  }
  return innertubePromise;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/**
 * Extract a YouTube video ID from any common URL shape:
 *   - https://www.youtube.com/watch?v=ID
 *   - https://youtu.be/ID
 *   - https://www.youtube.com/shorts/ID
 *   - https://www.youtube.com/embed/ID
 *   - https://www.youtube.com/v/ID
 * Returns null if the URL isn't a YouTube link or has no parsable ID.
 */
function extractVideoId(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!YOUTUBE_HOSTS.has(parsed.hostname)) return null;

  if (parsed.hostname === "youtu.be") {
    const id = parsed.pathname.slice(1).split("/")[0];
    return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }

  const v = parsed.searchParams.get("v");
  if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

  // /shorts/ID, /embed/ID, /v/ID
  const m = parsed.pathname.match(/\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
  if (m) return m[1];

  return null;
}

function bestThumbnail(thumbs: Array<{ url: string; width?: number }> | undefined): string {
  if (!thumbs || thumbs.length === 0) return "";
  return [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].url;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get(api.downloads.list.path, async (_req, res) => {
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

      const videoId = extractVideoId(input.url);
      if (!videoId) {
        return res.status(400).json({ message: "Invalid YouTube URL" });
      }

      const yt = await getInnertube();
      const info = await yt.getBasicInfo(videoId);

      res.status(200).json({
        title: info.basic_info.title ?? "Untitled",
        thumbnail: bestThumbnail(info.basic_info.thumbnail),
        url: input.url,
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join("."),
        });
      }
      res
        .status(500)
        .json({ message: err instanceof Error ? err.message : "Failed to get video info" });
    }
  });

  // Streams the audio track of a video as a download. Note: YouTube serves
  // audio in webm/opus or m4a/aac containers — not true MP3 — but we keep
  // the .mp3/audio-mpeg headers so the file is recognised as audio by
  // browsers and music players. Re-encoding to real MP3 would require
  // ffmpeg; that's a deliberate non-goal here.
  app.get("/api/video/download", async (req, res) => {
    try {
      const url = req.query.url as string;
      const videoId = url ? extractVideoId(url) : null;
      if (!videoId) {
        return res.status(400).send("Invalid or missing YouTube URL");
      }

      const yt = await getInnertube();
      // getInfo() (not getBasicInfo) loads the player, which is required to
      // decipher the signed audio URLs YouTube returns.
      const info = await yt.getInfo(videoId);
      const safeTitle = (info.basic_info.title ?? "audio").replace(/[^\w\s-]/g, "").trim() || "audio";

      // Log download to database (best-effort).
      try {
        await storage.createDownload({ url, title: safeTitle });
      } catch (dbError) {
        console.error("Failed to log download", dbError);
      }

      res.header("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);
      res.header("Content-Type", "audio/mpeg");
      res.header("Accept-Ranges", "bytes");

      const webStream = await info.download({
        type: "audio",
        quality: "best",
        format: "any",
      });

      // Convert the Web ReadableStream that youtubei.js returns into a
      // Node Readable so we can pipe it through Express.
      Readable.fromWeb(webStream as any).pipe(res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).send(err instanceof Error ? err.message : "Failed to download video");
      } else {
        res.end();
      }
    }
  });

  return httpServer;
}
