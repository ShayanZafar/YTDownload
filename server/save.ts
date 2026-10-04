import type { Request, Response } from "express";
import { promises as fs, type WriteStream } from "fs";
import path from "path";
import { api } from "@shared/routes";
import { safeFileName } from "@shared/filename";
import type { SaveEvent } from "@shared/schema";
import { audioOutput, fetchAudioInfo, startAudioPipeline } from "./audio";
import {
  FolderError,
  assertWritableFolder,
  availablePath,
  createNewFile,
  folderError,
} from "./folders";
import { retryWhenBusy } from "./retry-when-busy";
import { settings } from "./settings";
import { spotifySongTags } from "./spotify";
import { storage } from "./storage";
import { extractVideoId } from "./youtube-url";

/** How often progress is reported while the audio arrives. */
const PROGRESS_EVERY_MS = 250;

/** YouTube (or yt-dlp/ffmpeg) couldn't deliver the audio — a 502, like a normal download's. */
class DownloadError extends Error {}

/**
 * POST /api/video/save — a download saved by the app itself into the "Save to"
 * folder, instead of by the browser, so it works the same in every browser.
 *
 * It's the same yt-dlp → ffmpeg pipeline as a normal download, written to
 * "<name>.<ext>.part" in the folder and renamed to "<name>.<ext>" once it's
 * complete — or "<name> (1).<ext>" and so on, since an existing file is never
 * replaced. A cancel or a failure removes the .part file and adds nothing to
 * the history.
 *
 * Problems found before any audio arrives get a normal JSON error response.
 * After that, the reply is a stream of JSON lines (saveEventSchema): "progress"
 * while the audio arrives, then "done" or "error". The page going away (Cancel,
 * or the tab closing) cancels the save.
 */
export async function saveIntoFolder(req: Request, res: Response) {
  let clientGone = false;
  let stop: (() => void) | undefined;
  res.on("close", () => {
    if (res.writableFinished) return; // normal completion
    clientGone = true;
    stop?.();
  });

  // The unfinished file, while there is one to clean up.
  let part: { path: string; stream: WriteStream; closed: Promise<void> } | undefined;
  try {
    const input = api.video.save.input.safeParse(req.body);
    if (!input.success) {
      const [issue] = input.error.issues;
      return res.status(400).json({ message: issue.message, field: issue.path.join(".") });
    }
    const { url, format, name, spotifyId } = input.data;
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ message: "Invalid or missing YouTube URL", field: "url" });
    }

    const { saveFolder } = await settings.get();
    if (!saveFolder) {
      return res.status(409).json({ message: "Choose a folder to save into first." });
    }
    const folder = await assertWritableFolder(saveFolder);

    const canonical = `https://www.youtube.com/watch?v=${videoId}`;
    // A Spotify song is tagged with Spotify's title and artists (looked up
    // while YouTube is asked about the video).
    const songTags = spotifyId ? spotifySongTags(spotifyId) : undefined;
    let info;
    try {
      info = await fetchAudioInfo(canonical);
    } catch (err) {
      throw new DownloadError(`Couldn't download the audio: ${(err as Error).message}`, {
        cause: err,
      });
    }
    const tags = { ...info, ...(await songTags), spotifyId };
    // Cancelled while we were looking up the video: don't start any work.
    if (clientGone) return;

    const output = audioOutput(format, tags, info.acodec);
    const fileName = `${safeFileName(name || info.title)}.${output.ext}`;
    const created = await createNewFile(folder, `${fileName}.part`);
    part = {
      ...created,
      closed: new Promise<void>((resolve) => created.stream.once("close", () => resolve())),
    };
    let writeError: unknown;
    part.stream.on("error", (err) => {
      writeError ??= err;
      stop?.();
    });

    const pipeline = startAudioPipeline(canonical, info.formatId, output.ffmpegArgs);
    stop = pipeline.stop;
    if (clientGone) pipeline.stop(); // cancelled while the file was being made

    let bytes = 0;
    let reportedAt = 0;
    pipeline.audio.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (clientGone) return;
      if (!res.headersSent) {
        // The first audio has arrived: from here on, the reply is progress lines.
        res.status(200);
        res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.flushHeaders();
      }
      if (Date.now() - reportedAt >= PROGRESS_EVERY_MS) {
        reportedAt = Date.now();
        send(res, { type: "progress", bytes });
      }
    });
    pipeline.audio.pipe(part.stream);

    const { ok, reason } = await pipeline.finished;
    await part.closed;
    if (clientGone) return; // the .part file is removed below
    if (writeError) throw folderError(writeError, folder, "write");
    if (!ok || bytes === 0) {
      throw new DownloadError(`Couldn't download the audio: ${reason || "YouTube sent no audio"}`);
    }

    // Complete: give it its real name, and add it to the history.
    const saved = await claimName(part.path, folder, fileName);
    part = undefined;
    await storage
      .createDownload({ url, title: info.title, spotifyId })
      .catch((err) => console.error("Failed to save download history", err));
    send(res, { type: "done", fileName: path.basename(saved), folder, path: saved, bytes });
    res.end();
  } catch (err) {
    stop?.();
    if (!clientGone) reportFailure(res, err);
  } finally {
    if (part) await discard(part);
  }
}

// Choosing a free name and renaming onto it happen one save at a time, so two
// saves of the same song finishing together can't both pick "Song.mp3".
let naming: Promise<unknown> = Promise.resolve();

function claimName(partPath: string, folder: string, fileName: string): Promise<string> {
  const run = async () => {
    const target = await availablePath(folder, fileName);
    await retryWhenBusy(() => fs.rename(partPath, target));
    return target;
  };
  const result = naming.then(run, run);
  naming = result.catch(() => {});
  return result;
}

/** Stops writing the unfinished file and deletes it. */
async function discard(part: { path: string; stream: WriteStream; closed: Promise<void> }) {
  part.stream.destroy();
  await part.closed;
  await retryWhenBusy(() => fs.rm(part.path, { force: true })).catch((err) =>
    console.error(`Couldn't remove the unfinished file ${part.path}`, err),
  );
}

function send(res: Response, event: SaveEvent) {
  if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
}

/** A JSON error response if nothing's been sent yet, otherwise an "error" line. */
function reportFailure(res: Response, err: unknown) {
  const status = err instanceof FolderError ? err.status : err instanceof DownloadError ? 502 : 500;
  const message = err instanceof Error ? err.message : "Couldn't save the audio.";
  if (status >= 500) console.error(`Saving into the folder failed: ${message}`);
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    res.status(status).json({ message });
    return;
  }
  send(res, { type: "error", message });
  res.end();
}
