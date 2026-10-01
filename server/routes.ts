import type { Express, Response } from "express";
import { type Server } from "http";
import youtubedl from "youtube-dl-exec";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { extractVideoId, pickThumbnail, type ThumbnailLike } from "./youtube-url";
import { searchYouTube } from "./search";
import { safeFileName } from "@shared/filename";
import type { SaveSettings } from "@shared/schema";
import {
  SpotifyError,
  fetchSpotifyPlaylist,
  fetchSpotifyTrack,
  parseSpotifyLink,
  playlistLinkError,
  spotifyLinkError,
  spotifySearchQuery,
} from "./spotify";
import {
  YT_DLP_BASE_FLAGS,
  audioOutput,
  fetchAudioInfo,
  startAudioPipeline,
  ytDlpFailure,
} from "./audio";
import { settings } from "./settings";
import { isLocalRequest, localOnly } from "./local-only";
import {
  FolderError,
  assertWritableFolder,
  createFolder,
  defaultFolder,
  listFolders,
  placesToSave,
} from "./folders";
import { saveIntoFolder } from "./save";

type YtDlpInfo = ThumbnailLike & { title?: string };

/** Replies with a folder problem's own status and message, or a 500 for anything else. */
function sendFolderError(res: Response, err: unknown, fallback: string) {
  if (err instanceof FolderError) return res.status(err.status).json({ message: err.message });
  console.error(fallback, err);
  return res.status(500).json({ message: err instanceof Error ? err.message : fallback });
}

/** The first problem zod found, as `{ message, field }`. */
function validationError(error: z.ZodError) {
  const [issue] = error.errors;
  return { message: issue.message, field: issue.path.join(".") };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // --- "Save to" folder ------------------------------------------------------
  // The page can't reach the disk, so the app does the saving: these routes
  // pick the folder and write downloads into it. Only a browser on this
  // computer gets to use them (localOnly), which is why they work in any browser
  // there — and never for another device or another website.

  app.get(api.settings.get.path, async (req, res) => {
    const local = isLocalRequest(req);
    try {
      const { saveFolder } = await settings.get();
      const body: SaveSettings = { saveFolder: local ? saveFolder : null, canSaveToFolder: local };
      res.json(body);
    } catch (err) {
      sendFolderError(res, err, "Couldn't read the settings");
    }
  });

  app.put(api.settings.update.path, localOnly(), async (req, res) => {
    const input = api.settings.update.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      // Checked by actually writing there, so a folder the app can't use is
      // refused now rather than at the first download.
      const saveFolder =
        input.data.saveFolder === null
          ? null
          : await assertWritableFolder(input.data.saveFolder, { tryWriting: true });
      await settings.update({ saveFolder });
      const body: SaveSettings = { saveFolder, canSaveToFolder: true };
      res.json(body);
    } catch (err) {
      sendFolderError(res, err, "Couldn't save the setting");
    }
  });

  // The folder browser: one folder's subfolders, plus quick links.
  app.get(api.folders.list.path, localOnly(), async (req, res) => {
    const query = api.folders.list.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    try {
      let listing;
      if (query.data.path) {
        listing = await listFolders(query.data.path);
      } else {
        // Open where downloads go now; if that folder's gone, somewhere sensible.
        const { saveFolder } = await settings.get();
        listing = saveFolder
          ? await listFolders(saveFolder).catch(async () => listFolders(await defaultFolder()))
          : await listFolders(await defaultFolder());
      }
      res.json({ ...listing, places: await placesToSave() });
    } catch (err) {
      sendFolderError(res, err, "Couldn't open that folder");
    }
  });

  app.post(api.folders.create.path, localOnly(), async (req, res) => {
    const input = api.folders.create.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      res.status(201).json(await createFolder(input.data.parent, input.data.name));
    } catch (err) {
      sendFolderError(res, err, "Couldn't make the folder");
    }
  });

  // Downloads a video's audio straight into the "Save to" folder (see save.ts).
  app.post(api.video.save.path, localOnly(), saveIntoFolder);

  // --- Everything else ----------------------------------------------------------

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
      res.status(500).json({ message: ytDlpFailure(err) });
    }
  });

  // Song search: top YouTube results for a text query, official uploads first.
  // A Spotify song link searches for that song, preferring same-length uploads.
  app.get(api.video.search.path, async (req, res) => {
    const query = api.video.search.query.safeParse(req.query);
    if (!query.success) {
      return res.status(400).json({ message: query.error.errors[0].message, field: "q" });
    }
    const { q } = query.data;
    try {
      const spotifyLink = parseSpotifyLink(q);
      if (!spotifyLink) {
        return res.json({ results: await searchYouTube(q) });
      }
      if (spotifyLink.kind !== "track") {
        return res.status(400).json({ message: spotifyLinkError(spotifyLink), field: "q" });
      }
      const spotify = await fetchSpotifyTrack(spotifyLink.id);
      const results = await searchYouTube(spotifySearchQuery(spotify), {
        targetDuration: spotify.duration,
      });
      res.json({ results, spotify });
    } catch (err) {
      if (err instanceof SpotifyError) {
        return res.status(err.status).json({ message: err.message });
      }
      console.error("Search failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Search failed" });
    }
  });

  // The songs in a public Spotify playlist or album, for the playlist panel.
  // Picking one searches for its song link like any other (above).
  app.get(api.spotify.playlist.path, async (req, res) => {
    const query = api.spotify.playlist.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    const link = parseSpotifyLink(query.data.link);
    if (link?.kind !== "playlist" && link?.kind !== "album") {
      return res.status(400).json({ message: playlistLinkError(link), field: "link" });
    }
    try {
      res.json(await fetchSpotifyPlaylist(link.kind, link.id));
    } catch (err) {
      if (err instanceof SpotifyError) {
        return res.status(err.status).json({ message: err.message });
      }
      console.error("Reading the Spotify playlist failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Couldn't read it" });
    }
  });

  // Streams a video's audio as a download: yt-dlp → ffmpeg → response.
  // `?format=mp3` (default) converts to MP3; `?format=original` keeps YouTube's
  // own stream untouched. See server/audio.ts for the details.
  app.get(api.video.download.path, async (req, res) => {
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
      const query = api.video.download.query.safeParse(req.query);
      if (!query.success) {
        return res.status(400).send(query.error.errors[0].message);
      }
      const { url, format, name, spotifyId } = query.data;
      const videoId = extractVideoId(url);
      if (!videoId) {
        return res.status(400).send("Invalid or missing YouTube URL");
      }

      const canonical = `https://www.youtube.com/watch?v=${videoId}`;

      // Metadata first, so a video that can't be downloaded fails with a clean
      // error before a streaming response is opened.
      const info = await fetchAudioInfo(canonical);

      // Cancelled while we were looking up the video: don't start any work.
      if (clientGone) return;

      // These only go out with the first chunk of audio, so a failure before
      // then can still be turned into a proper error response (see below).
      const output = audioOutput(format, info, info.acodec);
      // Saved as the name chosen on the page, or the video's title. res.attachment
      // writes both a plain filename and a UTF-8 one (filename*), so accents and
      // non-Latin titles survive.
      res.attachment(`${safeFileName(name || info.title)}.${output.ext}`);
      res.header("Content-Type", output.contentType);

      // yt-dlp is pinned to the stream the metadata pass picked, so the container
      // chosen for "original" always matches the audio that arrives.
      const pipeline = startAudioPipeline(canonical, info.formatId, output.ffmpegArgs);
      stopPipeline = pipeline.stop;
      pipeline.audio.pipe(res, { end: false });

      const { ok, reason } = await pipeline.finished;
      if (clientGone) return;

      if (!res.headersSent) {
        // Failed before producing any audio (e.g. YouTube refused the stream).
        const why = reason || "YouTube sent no audio";
        console.error(`Download failed before any audio was sent: ${why}`);
        res.removeHeader("Content-Disposition");
        return res.status(502).type("text/plain").send(`Couldn't download the audio: ${why}`);
      }

      // Audio was already flowing. On a mid-stream failure the file is cut
      // short — there's no way to signal an error once a 200 has been sent.
      if (!ok) console.error(`Download cut short: ${reason}`);

      // Download history: only record a download that fully succeeded — both
      // processes exited cleanly and the whole file was handed to the browser.
      // A cancel or a failure part-way through leaves no entry.
      res.once("finish", () => {
        if (!ok || clientGone) return;
        storage
          .createDownload({ url, title: info.title, spotifyId })
          .catch((err) => console.error("Failed to save download history", err));
      });
      res.end();
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
