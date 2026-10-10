import type { Express, Request, Response } from "express";
import { type Server } from "http";
import youtubedl from "youtube-dl-exec";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { extractVideoId, pickThumbnail, type ThumbnailLike } from "./youtube-url";
import { searchYouTube } from "./search";
import { safeFileName } from "@shared/filename";
import { audioTypeOf } from "@shared/audio-types";
import { musicIdSchema, type SaveSettings } from "@shared/schema";
import {
  SpotifyError,
  fetchSpotifyPlaylist,
  fetchSpotifyTrack,
  playlistLinkError,
  readSpotifyLink,
  spotifyLinkError,
  spotifySearchQuery,
  spotifySongTags,
  unusableLinkError,
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
import { songsInFolder, type AudioFile } from "./library";
import { convertedForBrowser, findMusicFile, listMusic, readCover } from "./music";

type YtDlpInfo = ThumbnailLike & { title?: string };

/** Replies with a folder problem's own status and message, or a 500 for anything else. */
function sendFolderError(res: Response, err: unknown, fallback: string) {
  if (err instanceof FolderError) return res.status(err.status).json({ message: err.message });
  console.error(fallback, err);
  return res.status(500).json({ message: err instanceof Error ? err.message : fallback });
}

const NO_FOLDER = "Choose a folder to save into first.";
const SONG_GONE = "That song isn't in the folder any more.";
const PLAYER_NOT_LOCAL =
  "The songs in the Save to folder play only in a browser on the computer running the app.";

/**
 * The song a music request names (by id) in the "Save to" folder — or
 * undefined, having replied why not.
 */
async function songFor(req: Request, res: Response): Promise<AudioFile | undefined> {
  const id = musicIdSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ message: id.error.issues[0].message });
    return undefined;
  }
  const { saveFolder } = await settings.get();
  if (!saveFolder) {
    res.status(409).json({ message: NO_FOLDER });
    return undefined;
  }
  const file = await findMusicFile(saveFolder, id.data);
  if (!file) res.status(404).json({ message: SONG_GONE });
  return file;
}

/** Sends an audio file as it is — range requests work, so the player can seek. */
function sendAudioFile(res: Response, file: string, type: string) {
  res.sendFile(
    file,
    { dotfiles: "allow", headers: { "Content-Type": type, "Cache-Control": "no-cache" } },
    (err) => {
      // Sent, or the player hung up part-way (it often does, to jump elsewhere).
      if (!err || res.headersSent) return;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      console.error("Couldn't send a song:", err);
      res.status(500).json({ message: "Couldn't read that song." });
    },
  );
}

/** The first problem zod found, as `{ message, field }`. */
function validationError(error: z.ZodError) {
  const [issue] = error.issues;
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

  // Which of a playlist's songs are already in the "Save to" folder (see library.ts).
  // Only ever the chosen folder: the page sends songs, never a path.
  app.post(api.folders.songs.path, localOnly(), async (req, res) => {
    const input = api.folders.songs.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      const { saveFolder } = await settings.get();
      if (!saveFolder) {
        return res.status(409).json({ message: "Choose a folder to save into first." });
      }
      res.json(await songsInFolder(saveFolder, input.data.songs));
    } catch (err) {
      sendFolderError(res, err, "Couldn't look through the folder");
    }
  });

  // --- Music player ------------------------------------------------------------
  // Plays the songs in the "Save to" folder, in a browser on this computer
  // (localOnly). Songs are asked for by id, never by path, so only files the
  // folder scan found can be played (see music.ts). On a phone the player
  // plays songs stored on the phone, which never reach the app.

  app.get(api.music.list.path, localOnly(PLAYER_NOT_LOCAL), async (_req, res) => {
    try {
      const { saveFolder } = await settings.get();
      if (!saveFolder) return res.status(409).json({ message: NO_FOLDER });
      res.json(await listMusic(saveFolder));
    } catch (err) {
      sendFolderError(res, err, "Couldn't look through the folder");
    }
  });

  // A song's file, untouched.
  app.get(api.music.audio.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    try {
      const file = await songFor(req, res);
      if (file)
        sendAudioFile(
          res,
          file.absolute,
          audioTypeOf(file.relative)?.mime ?? "application/octet-stream",
        );
    } catch (err) {
      sendFolderError(res, err, "Couldn't play that song");
    }
  });

  // A song converted to FLAC — lossless — for a browser that can't play the
  // file itself. Converting takes a few seconds the first time; if the player
  // moves on before then, the conversion stops.
  app.get(api.music.flac.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const file = await songFor(req, res);
      if (!file) return;
      const flac = await convertedForBrowser(file, controller.signal);
      if (!controller.signal.aborted) sendAudioFile(res, flac, "audio/flac");
    } catch (err) {
      if (controller.signal.aborted || res.headersSent) return;
      if (err instanceof FolderError) return sendFolderError(res, err, "");
      console.error("Converting a song failed:", err);
      res.status(500).json({
        message: `Couldn't convert that song: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  // A song's cover picture, from its tags (204 when it has none).
  app.get(api.music.cover.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    try {
      const file = await songFor(req, res);
      if (!file) return;
      const cover = await readCover(file).catch(() => undefined);
      if (!cover) return res.status(204).end();
      res
        .set({ "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" })
        .type(cover.type)
        .send(Buffer.from(cover.data));
    } catch (err) {
      sendFolderError(res, err, "Couldn't read the cover");
    }
  });

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
          message: err.issues[0].message,
          field: err.issues[0].path.join("."),
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
      return res.status(400).json({ message: query.error.issues[0].message, field: "q" });
    }
    const { q } = query.data;
    try {
      const spotifyLink = await readSpotifyLink(q);
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

  // Where a Spotify link leads: the page asks before handling a spotify.link
  // short link, to know whether it's a song (search) or a playlist (the panel).
  app.get(api.spotify.link.path, async (req, res) => {
    const query = api.spotify.link.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    try {
      const link = await readSpotifyLink(query.data.link);
      if (!link) {
        return res.status(400).json({ message: "That isn't a Spotify link.", field: "link" });
      }
      if (link.kind === "other") {
        return res.status(400).json({ message: unusableLinkError(link), field: "link" });
      }
      res.json({ kind: link.kind, url: `https://open.spotify.com/${link.kind}/${link.id}` });
    } catch (err) {
      if (err instanceof SpotifyError) {
        return res.status(err.status).json({ message: err.message });
      }
      console.error("Opening the Spotify link failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Couldn't open it" });
    }
  });

  // The songs in a public Spotify playlist or album, for the playlist panel.
  // Picking one searches for its song link like any other (above).
  app.get(api.spotify.playlist.path, async (req, res) => {
    const query = api.spotify.playlist.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    try {
      const link = await readSpotifyLink(query.data.link);
      if (link?.kind !== "playlist" && link?.kind !== "album") {
        return res.status(400).json({ message: playlistLinkError(link), field: "link" });
      }
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
        return res.status(400).send(query.error.issues[0].message);
      }
      const { url, format, name, spotifyId } = query.data;
      const videoId = extractVideoId(url);
      if (!videoId) {
        return res.status(400).send("Invalid or missing YouTube URL");
      }

      const canonical = `https://www.youtube.com/watch?v=${videoId}`;

      // A Spotify song is tagged with Spotify's title and artists (looked up
      // while YouTube is asked about the video).
      const songTags = spotifyId ? spotifySongTags(spotifyId) : undefined;

      // Metadata first, so a video that can't be downloaded fails with a clean
      // error before a streaming response is opened.
      const info = await fetchAudioInfo(canonical);
      const tags = { ...info, ...(await songTags), spotifyId };

      // Cancelled while we were looking up the video: don't start any work.
      if (clientGone) return;

      // These only go out with the first chunk of audio, so a failure before
      // then can still be turned into a proper error response (see below).
      const output = audioOutput(format, tags, info.acodec);
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
