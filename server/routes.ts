import type { Express } from "express";
import { type Server } from "http";
import youtubedl from "youtube-dl-exec";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { extractVideoId, pickThumbnail, type ThumbnailLike } from "./youtube-url";

type YtDlpInfo = ThumbnailLike & {
  title?: string;
};

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  app.get(api.downloads.list.path, async (_req, res) => {
    try {
      const allDownloads = await storage.getDownloads();
      res.status(200).json(allDownloads);
    } catch {
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

      const canonical = `https://www.youtube.com/watch?v=${videoId}`;

      const info = (await youtubedl(canonical, {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        noPlaylist: true,
      })) as YtDlpInfo;

      res.status(200).json({
        title: info.title ?? "Untitled",
        thumbnail: pickThumbnail(info),
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

      const canonical = `https://www.youtube.com/watch?v=${videoId}`;

      // Light metadata pass first so we have a filename and can fail early
      // (with a clean 500) before opening a streaming response.
      const info = (await youtubedl(canonical, {
        dumpSingleJson: true,
        skipDownload: true,
        noWarnings: true,
        noPlaylist: true,
      })) as YtDlpInfo;

      const safeTitle = (info.title ?? "audio").replace(/[^\w\s-]/g, "").trim() || "audio";

      try {
        await storage.createDownload({ url, title: safeTitle });
      } catch (dbError) {
        console.error("Failed to log download", dbError);
      }

      res.header("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);
      res.header("Content-Type", "audio/mpeg");
      res.header("Accept-Ranges", "bytes");

      // Spawn yt-dlp and stream stdout straight into the response.
      // `output: "-"` tells yt-dlp to write the audio bytes to stdout.
      const subprocess = youtubedl.exec(canonical, {
        format: "bestaudio",
        output: "-",
        quiet: true,
        noWarnings: true,
        noPlaylist: true,
      });

      if (!subprocess.stdout || !subprocess.stderr) {
        throw new Error("Failed to spawn yt-dlp subprocess");
      }

      let stderrBuf = "";
      subprocess.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString();
      });

      subprocess.stdout.pipe(res);

      subprocess.on("error", (e) => {
        console.error("yt-dlp spawn error", e);
        if (!res.headersSent) res.status(500).send(e.message);
        else res.end();
      });

      subprocess.on("close", (code) => {
        if (code !== 0 && !res.writableEnded) {
          console.error(`yt-dlp exited with code ${code}: ${stderrBuf}`);
          res.end();
        }
      });

      // If the client aborts, kill the subprocess so we don't leak it.
      req.on("close", () => {
        if (subprocess.exitCode === null) subprocess.kill("SIGTERM");
      });
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
