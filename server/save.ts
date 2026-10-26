import type { Request, Response } from "express";
import { promises as fs, type WriteStream } from "fs";
import path from "path";
import { api } from "@shared/routes";
import { clock } from "@shared/clock";
import { safeFileName } from "@shared/filename";
import { fileNameOf, songOfVideo } from "@shared/song-name";
import { SAME_LENGTH_SECONDS, type SaveEvent } from "@shared/schema";
import { audioLinkOf } from "@shared/soundcloud-link";
import { prepareAudioOutput, startAudioPipeline, type PreparedOutput } from "./audio";
import { audioEnded, lookUpAudio, sourceName } from "./audio-source";
import { coverFor } from "./cover";
import { lateDetails, lookUpDownload } from "./download-details";
import { downloadEntry, logDetails } from "./details-log";
import { kindProblem, sniffFile } from "./file-kind";
import {
  FolderError,
  assertWritableFolder,
  claimNewName,
  createNewFile,
  folderError,
} from "./folders";
import { folderArtistSongs } from "./music";
import { retryWhenBusy } from "./retry-when-busy";
import { parseFile, oggDuration } from "./library";
import { settings, settingsFilePath } from "./settings";
import { spotifySongTags } from "./spotify";
import { storage } from "./storage";
import { YouTubeRefused, sendRefused } from "./youtube-limits";

/** How often progress is reported while the audio arrives. */
const PROGRESS_EVERY_MS = 250;

/**
 * A save whose stream stalls (no audio for `stallMs`: the source stopped
 * sending), breaks off part-way, or ends well short of the video's length is
 * tried again at once, from the start — up to `attempts` times in all — and
 * then fails, saying why. (A stream can't pick up where it broke off: it's
 * converted as it arrives.) Tests shorten `stallMs`.
 */
export const saveRetry = { stallMs: 60_000, attempts: 2 };

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
 * the history. A stream that stalls, breaks off or comes up short is tried
 * again (`saveRetry`); the .part files of saves an app closed part-way left
 * behind go when it starts again (`removeLeftoverSaves()`).
 *
 * Problems found before any audio arrives get a normal JSON error response.
 * After that, the reply is a stream of JSON lines (saveEventSchema): "progress"
 * while the audio arrives, then "done" or "error". The page going away (Cancel,
 * or the tab closing) cancels the save.
 */
// The .part files saves are writing now, which Housekeeping never lists.
const saving = new Set<string>();

/**
 * Where the .part files being written are noted (unfinished-saves.json next to
 * the settings: data/, or wherever UNFINISHED_SAVES_FILE points), so that ones
 * an app closed part-way through a save left behind are deleted when it starts
 * again (`removeLeftoverSaves()`).
 */
export const unfinishedSavesFile = () =>
  path.resolve(
    process.env.UNFINISHED_SAVES_FILE ||
      path.join(path.dirname(settingsFilePath()), "unfinished-saves.json"),
  );

// Each write of the list waits for the one before it.
let noted: Promise<unknown> = Promise.resolve();
function noteSaving() {
  const write = async () => {
    const file = unfinishedSavesFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify([...saving], null, 2)}\n`, "utf8");
    await retryWhenBusy(() => fs.rename(tmp, file));
  };
  noted = noted
    .then(write)
    .catch((err) => console.error("Couldn't note the saves in progress", err));
  return noted;
}

/** Is a save writing this file now? */
export const isBeingSaved = (file: string) => saving.has(path.resolve(file));

/** Notes that a save is writing this file now, until the function it returns is called. */
export function markBeingSaved(file: string): () => void {
  const writing = path.resolve(file);
  saving.add(writing);
  void noteSaving();
  return () => {
    if (saving.delete(writing)) void noteSaving();
  };
}

/**
 * When the app starts: deletes the .part files saves were writing when it was
 * last closed (or crashed, or the PC went off) — they'd never be finished —
 * and the note of them. Only files the note lists, so nothing else is touched.
 */
export async function removeLeftoverSaves(file = unfinishedSavesFile()): Promise<string[]> {
  let listed: unknown;
  try {
    listed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return []; // none noted (or a damaged note: nothing to go on)
  }
  const removed: string[] = [];
  for (const part of Array.isArray(listed) ? listed : []) {
    if (typeof part !== "string" || !part.endsWith(".part") || saving.has(part)) continue;
    try {
      await retryWhenBusy(() => fs.rm(part));
      removed.push(part);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Couldn't remove the unfinished file ${part}`, err);
      }
    }
  }
  if (removed.length > 0) {
    console.log(`Removed ${removed.length} unfinished save(s) left from when the app was closed.`);
  }
  await noteSaving();
  return removed;
}

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
  let doneSaving: (() => void) | undefined;
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
    // Its artist and title as a player shows them — the artist the video's title names, not
    // the channel that uploaded it, without "(Official Video)", "HQ"… — unless Spotify names it.
    const song = songOfVideo(info.title, info.artist);
    const tags = {
      ...info,
      title: song.title,
      artist: song.artist ?? undefined,
      ...(await songTags),
      spotifyId,
    };
    // Its genre (and for a song without an album, its album) from the music
    // catalogues, looked up meanwhile — or its artist's genre, from the folder's
    // other songs by them first. It never fails or holds the download up.
    const lookedUp = lookUpDownload(tags, info.duration, {
      folderSongs: () => folderArtistSongs(folder),
    });
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
    // The name chosen on the page, or "Artist - Title" (fileNameOf: made safe too).
    const fileName = `${name ? safeFileName(name) : fileNameOf(song)}.${output.ext}`;
    let bytes = 0;
    for (let attempt = 1; ; attempt++) {
      const created = await createNewFile(folder, `${fileName}.part`);
      doneSaving = markBeingSaved(created.path);
      part = {
        ...created,
        closed: new Promise<void>((resolve) => created.stream.once("close", () => resolve())),
      };
      let writeError: unknown;
      part.stream.on("error", (err) => {
        writeError ??= err;
        stop?.();
      });

      const pipeline = startAudioPipeline(
        link.url,
        info.formatId,
        output.ffmpegArgs,
        output.prefix,
      );
      stop = pipeline.stop;
      if (clientGone) pipeline.stop(); // cancelled while the file was being made

      bytes = 0;
      let reportedAt = 0;
      let audioAt = Date.now();
      let stalled = false;
      // Nothing for stallMs: the source has stopped sending, though it hasn't hung up.
      const watch = setInterval(
        () => {
          if (Date.now() - audioAt < saveRetry.stallMs) return;
          stalled = true;
          pipeline.stop();
        },
        Math.min(5_000, saveRetry.stallMs / 4),
      );
      pipeline.audio.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        audioAt = Date.now();
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

      const { ok, reason } = await pipeline.finished.finally(() => clearInterval(watch));
      await part.closed;
      if (clientGone) return; // the .part file is removed below
      if (writeError) throw folderError(writeError, folder, "write");
      // Recorded for the source-health report; YouTube may have refused it.
      const refused = audioEnded(link, ok, reason);
      if (refused) throw refused;

      const problem = stalled
        ? `${sourceName(link)} stopped sending the audio (nothing for ${Math.round(saveRetry.stallMs / 1000)} s)`
        : !ok || bytes === 0
          ? reason || `${sourceName(link)} sent no audio`
          : await cutShort(part.path, info.duration);
      if (!problem) break;
      // Worth another go when the stream got going (or stalled): it broke off on the way.
      if ((!stalled && bytes === 0) || attempt >= saveRetry.attempts) {
        throw new DownloadError(
          `Couldn't download the audio: ${problem}${attempt > 1 ? ` (tried ${attempt} times)` : ""}`,
        );
      }
      console.warn(`Saving “${fileName}”: ${problem} — trying again.`);
      const unfinished = part;
      part = undefined;
      await discard(unfinished);
      doneSaving();
      doneSaving = undefined;
    }

    // Complete: check it's the audio it should be (file-kind.ts), give it its
    // real name, and add it to the history.
    const { notAudio, realType } = kindProblem(
      fileName,
      await sniffFile(part.path).catch(() => undefined),
    );
    if (notAudio) {
      throw new DownloadError(`Couldn't download the audio: what came was ${notAudio}, not audio`);
    }
    const saved = await claimName(
      part.path,
      folder,
      realType ? `${fileName.slice(0, -path.extname(fileName).length)}${realType}` : fileName,
    );
    part = undefined;
    await storage
      .createDownload({
        url,
        title: info.title,
        spotifyId,
        source: link.source,
        fileName: path.basename(saved),
      })
      .catch((err) => console.error("Failed to save download history", err));
    send(res, { type: "done", fileName: path.basename(saved), folder, path: saved, bytes });
    res.end();
  } catch (err) {
    stop?.();
    if (!clientGone) reportFailure(res, err);
  } finally {
    if (part) await discard(part);
    doneSaving?.();
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

/**
 * Why a finished file isn't the whole song, or undefined if it is (or its length can't be
 * read): it plays for well under the video's length — the stream ended early.
 */
async function cutShort(file: string, videoSeconds: number | undefined) {
  if (!videoSeconds) return undefined;
  const seconds = await audioSeconds(file).catch(() => undefined);
  if (seconds === undefined) return undefined;
  const allowed = Math.max(SAME_LENGTH_SECONDS, videoSeconds * 0.03);
  if (seconds >= videoSeconds - allowed) return undefined;
  return `it stopped at ${clock(seconds)} of ${clock(videoSeconds)}`;
}

/** How long a file plays, as its header (or an Ogg file's last page) says. */
async function audioSeconds(file: string): Promise<number | undefined> {
  const { format } = await parseFile(file, { duration: false, skipCovers: true });
  if (format.duration) return format.duration;
  if (!/ogg/i.test(format.container ?? "")) return undefined;
  // Opus counts in 48 kHz samples, whatever the audio's rate (as in library.ts).
  const rate = /opus/i.test(format.codec ?? "") ? 48_000 : format.sampleRate;
  return rate ? oggDuration(file, rate) : undefined;
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
