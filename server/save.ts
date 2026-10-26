import type { Request, Response } from "express";
import { promises as fs, type WriteStream } from "fs";
import path from "path";
import { api } from "@shared/routes";
import { safeFileName } from "@shared/filename";
import type { SaveEvent } from "@shared/schema";
import { audioLinkOf } from "@shared/soundcloud-link";
import { prepareAudioOutput, startAudioPipeline, type PreparedOutput } from "./audio";
import { audioEnded, lookUpAudio, sourceName } from "./audio-source";
import { coverFor } from "./cover";
import { lateDetails, lookUpDownload } from "./download-details";
import { downloadEntry, logDetails } from "./details-log";
import {
  FolderError,
  assertWritableFolder,
  claimNewName,
  createNewFile,
  folderError,
} from "./folders";
import { retryWhenBusy } from "./retry-when-busy";
import { settings } from "./settings";
import { spotifySongTags } from "./spotify";
import { storage } from "./storage";
import { YouTubeRefused, sendRefused } from "./youtube-limits";

/** How often progress is reported while the audio arrives. */
const PROGRESS_EVERY_MS = 250;

/** The source (or yt-dlp/ffmpeg) couldn't deliver the audio — a 502, like a normal download's. */
class DownloadError extends Error {}

/**
 * POST /api/video/save — a download saved by the app itself into the "Save to"
 * folder, instead of by the browser, so it works the same in every browser.
 *
 * It's the same yt-dlp → ffmpeg pipeline as a normal download (of a YouTube
 * video, or of a SoundCloud track a search found there), written to
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

  // The cover files made for this save, deleted once it's over.
  let output: PreparedOutput | undefined;
  // The unfinished file, while there is one to clean up.
  let part: { path: string; stream: WriteStream; closed: Promise<void> } | undefined;
  try {
    const input = api.video.save.input.safeParse(req.body);
    if (!input.success) {
      const [issue] = input.error.issues;
      return res.status(400).json({ message: issue.message, field: issue.path.join(".") });
    }
    const { url, format, name, spotifyId } = input.data;
    // Only a YouTube video or a SoundCloud track, and only its canonical link
    // goes to yt-dlp.
    const link = audioLinkOf(url);
    if (!link) {
      return res
        .status(400)
        .json({ message: "Invalid or missing YouTube or SoundCloud link", field: "url" });
    }

    const { saveFolder } = await settings.get();
    if (!saveFolder) {
      return res.status(409).json({ message: "Choose a folder to save into first." });
    }
    const folder = await assertWritableFolder(saveFolder);

    // A Spotify song is tagged with Spotify's title and artists (looked up
    // while the source is asked about the audio).
    const songTags = spotifyId ? spotifySongTags(spotifyId) : undefined;
    // And its cover: Spotify's album cover, or the video's thumbnail — looked up
    // meanwhile — or a SoundCloud track's artwork, once the look-up has found it.
    const videoCover =
      link.source === "youtube"
        ? coverFor({ kind: "youtube", videoId: link.videoId }, songTags)
        : undefined;
    let info;
    try {
      // A refusal from YouTube is answered at once with a 502 that says so.
      info = await lookUpAudio(link);
    } catch (err) {
      if (err instanceof YouTubeRefused) throw err;
      throw new DownloadError(`Couldn't download the audio: ${(err as Error).message}`, {
        cause: err,
      });
    }
    const tags = { ...info, ...(await songTags), spotifyId };
    // Its genre (and for a song without an album, its album) from the music
    // catalogues, looked up meanwhile. It never fails or holds the download up.
    const lookedUp = lookUpDownload(tags, info.duration);
    // Cancelled while we were looking up the video: don't start any work.
    if (clientGone) return;

    const cover =
      videoCover ??
      coverFor(info.artwork ? { kind: "soundcloud", url: info.artwork } : undefined, songTags);
    const ownCover = await cover;
    const later = lateDetails(lookedUp, ownCover !== undefined);
    // What it got, or why not, goes in the details log.
    void later.then((found) => logDetails(downloadEntry(name || info.title, found)));
    output = await prepareAudioOutput(format, tags, info.acodec, ownCover, later);
    if (clientGone) return;
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

    const pipeline = startAudioPipeline(link.url, info.formatId, output.ffmpegArgs, output.prefix);
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
    // Recorded for the source-health report; YouTube may have refused it.
    const refused = audioEnded(link, ok, reason);
    if (refused) throw refused;
    if (!ok || bytes === 0) {
      throw new DownloadError(
        `Couldn't download the audio: ${reason || `${sourceName(link)} sent no audio`}`,
      );
    }

    // Complete: give it its real name, and add it to the history.
    const saved = await claimName(part.path, folder, fileName);
    part = undefined;
    await storage
      .createDownload({ url, title: info.title, spotifyId, source: link.source })
      .catch((err) => console.error("Failed to save download history", err));
    send(res, { type: "done", fileName: path.basename(saved), folder, path: saved, bytes });
    res.end();
  } catch (err) {
    stop?.();
    if (!clientGone) reportFailure(res, err);
  } finally {
    if (part) await discard(part);
    void output?.cleanup();
  }
}

/**
 * Gives a finished file its name: "<name>.<ext>", or "<name> (1).<ext>"… if
 * that's taken. The name is claimed first (`claimNewName()`: an empty file,
 * made only if nothing has that name yet), then the .part file is renamed
 * over it — so saves finishing together never take the same name or replace
 * a file, and none waits for another.
 */
async function claimName(partPath: string, folder: string, fileName: string): Promise<string> {
  const target = await claimNewName(folder, fileName);
  try {
    await retryWhenBusy(() => fs.rename(partPath, target));
  } catch (err) {
    await fs.rm(target, { force: true }).catch(() => {}); // the empty name it had claimed
    throw err;
  }
  return target;
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
  const status =
    err instanceof FolderError || err instanceof YouTubeRefused
      ? err.status
      : err instanceof DownloadError
        ? 502
        : 500;
  const message = err instanceof Error ? err.message : "Couldn't save the audio.";
  if (status >= 500) console.error(`Saving into the folder failed: ${message}`);
  if (res.writableEnded || res.destroyed) return;
  if (!res.headersSent) {
    if (err instanceof YouTubeRefused) sendRefused(res);
    else res.status(status).json({ message });
    return;
  }
  send(res, { type: "error", message });
  res.end();
}
