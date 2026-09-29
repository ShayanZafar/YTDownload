import type { Express } from "express";
import { type Server } from "http";
import type { ChildProcess } from "child_process";
import youtubedl from "youtube-dl-exec";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { extractVideoId, pickThumbnail, type ThumbnailLike } from "./youtube-url";
import { YT_DLP_BASE_FLAGS, spawnFfmpegMp3, spawnYtDlpAudio } from "./audio";

type YtDlpInfo = ThumbnailLike & {
  title?: string;
  uploader?: string;
  channel?: string;
};

const isRunning = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
const lastLine = (text: string) => text.trim().split(/\r?\n/).pop() ?? "";

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
        ...YT_DLP_BASE_FLAGS,
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

  // Streams a video's audio as an MP3 download: yt-dlp → ffmpeg → response.
  // See server/audio.ts for the encoding details.
  app.get("/api/video/download", async (req, res) => {
    // Watch for the browser going away (download cancelled, tab closed) from the
    // very start — the metadata lookup below can take 10–20s, and a cancel during
    // it must stop us from starting processes that would then block forever.
    let clientGone = false;
    let stopPipeline: (() => void) | undefined;
    res.on("close", () => {
      if (res.writableFinished) return; // normal completion
      clientGone = true;
      stopPipeline?.();
    });

    try {
      const url = req.query.url as string;
      const videoId = url ? extractVideoId(url) : null;
      if (!videoId) {
        return res.status(400).send("Invalid or missing YouTube URL");
      }

      const canonical = `https://www.youtube.com/watch?v=${videoId}`;

      // Light metadata pass first so we have a filename and tags, and can fail
      // early (with a clean 500) before opening a streaming response.
      const info = (await youtubedl(canonical, {
        dumpSingleJson: true,
        skipDownload: true,
        ...YT_DLP_BASE_FLAGS,
      })) as YtDlpInfo;

      const title = info.title ?? "audio";
      const safeTitle = title.replace(/[^\w\s-]/g, "").trim() || "audio";

      // Cancelled while we were looking up the video: don't log it or start work.
      if (clientGone) return;

      try {
        await storage.createDownload({ url, title: safeTitle });
      } catch (dbError) {
        console.error("Failed to log download", dbError);
      }
      if (clientGone) return;

      // These only go out with the first chunk of audio, so a failure before
      // then can still be turned into a proper error response (see below).
      res.header("Content-Disposition", `attachment; filename="${safeTitle}.mp3"`);
      res.header("Content-Type", "audio/mpeg");

      // ffmpeg first: if it can't start (throws), no yt-dlp has been left running.
      const ffmpeg = spawnFfmpegMp3({ title, artist: info.uploader ?? info.channel });
      const ytdlp = spawnYtDlpAudio(canonical);
      stopPipeline = () => {
        for (const p of [ytdlp, ffmpeg]) if (isRunning(p)) p.kill();
      };

      let ytdlpErr = "";
      let ffmpegErr = "";
      let spawnError = "";
      ytdlp.stderr.on("data", (chunk) => (ytdlpErr += chunk));
      ffmpeg.stderr.on("data", (chunk) => (ffmpegErr += chunk));
      ytdlp.on("error", (e) => {
        spawnError = `yt-dlp failed to start: ${e.message}`;
        stopPipeline?.();
      });
      ffmpeg.on("error", (e) => {
        spawnError = `ffmpeg failed to start: ${e.message}`;
        stopPipeline?.();
      });
      // If ffmpeg exits first, yt-dlp's remaining writes hit a closed pipe
      // (EPIPE). That's expected — but unhandled, the error would crash the server.
      ffmpeg.stdin.on("error", () => {});

      ytdlp.stdout.pipe(ffmpeg.stdin);
      ffmpeg.stdout.pipe(res, { end: false });

      ytdlp.on("close", (code) => {
        // ffmpeg sees end-of-input and finishes on its own; just record why.
        if (code !== 0 && !clientGone) {
          console.error(`yt-dlp exited with code ${code}: ${lastLine(ytdlpErr)}`);
        }
      });

      ffmpeg.on("close", (code) => {
        stopPipeline?.(); // make sure yt-dlp isn't left running
        if (clientGone) return;

        if (res.headersSent) {
          // Audio was already flowing. On a mid-stream failure the file is cut
          // short — there's no way to signal an error once a 200 has been sent.
          if (code !== 0) console.error(`ffmpeg exited with code ${code}: ${lastLine(ffmpegErr)}`);
          res.end();
          return;
        }

        // Failed before producing any audio (e.g. YouTube refused the stream).
        const reason =
          spawnError ||
          lastLine(ytdlpErr) ||
          lastLine(ffmpegErr) ||
          `ffmpeg exited with code ${code}`;
        console.error(`Download failed before any audio was sent: ${reason}`);
        res.removeHeader("Content-Disposition");
        res.status(502).type("text/plain").send(`Couldn't download the audio: ${reason}`);
      });
    } catch (err) {
      console.error(err);
      stopPipeline?.();
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        res
          .status(500)
          .type("text/plain")
          .send(err instanceof Error ? err.message : "Failed to download video");
      } else {
        res.end();
      }
    }
  });

  return httpServer;
}
