import type { Express, Request, Response } from "express";
import { type Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { extractVideoId } from "./youtube-url";
import { SearchFailed, searchSongs, searchSoundCloudOnly, type SongSearchOptions } from "./search";
import { audioLinkOf } from "@shared/soundcloud-link";
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
  fetchVideoInfo,
  prepareAudioOutput,
  startAudioPipeline,
  ytDlpFailure,
  type PreparedOutput,
} from "./audio";
import { audioEnded, lookUpAudio, sourceName } from "./audio-source";
import { coverFor } from "./cover";
import { lateDetails, lookUpDownload } from "./download-details";
import { settings } from "./settings";
import { cpuCores } from "./cpu-cores";
import { isLocalRequest, localOnly, sameOriginOnly } from "./local-only";
import { LyricsError, findLyrics } from "./lyrics";
import {
  FolderError,
  assertWritableFolder,
  createFolder,
  defaultFolder,
  listFolders,
  placesToSave,
} from "./folders";
import { saveIntoFolder } from "./save";
import { YouTubePlaylistError, fetchYouTubePlaylist } from "./youtube-playlist";
import { readTags, songsInFolder, type AudioFile } from "./library";
import { writePlaylistFile } from "./playlist-file";
import { CatalogueError } from "./catalogues";
import {
  convertedForBrowser,
  deleteMusicFile,
  findMusicFile,
  fixSongName,
  listMusic,
  readCover,
  toMusicTrack,
} from "./music";
import { lookUpDetails, SongDetailsError, writeSongDetails } from "./song-details";
import { binName, NoBinError } from "./trash";
import { readWaveform, trimSong, undoTrim } from "./trim";
import { YouTubeRefused, sendRefused, videoCacheKey, youtubeGuard } from "./youtube-limits";
import { sourceHealth } from "./source-health";

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
 * undefined, having replied why not. A file that isn't audio by its content
 * (file-kind.ts) is never played, converted or read: only deleted
 * (`anyFile`). One that's another kind of audio than its name says comes
 * with that kind (`realType`).
 */
async function songFor(
  req: Request,
  res: Response,
  { anyFile = false } = {},
): Promise<(AudioFile & { realType?: string }) | undefined> {
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
  if (!file) {
    res.status(404).json({ message: SONG_GONE });
    return undefined;
  }
  const { notAudio, realType } = await readTags(file);
  if (notAudio && !anyFile) {
    res
      .status(415)
      .json({ message: `That isn't a song: it's ${notAudio}, whatever its name says.` });
    return undefined;
  }
  return { ...file, realType };
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
      const body: SaveSettings = {
        saveFolder: local ? saveFolder : null,
        canSaveToFolder: local,
        cpuCores: cpuCores(),
      };
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
      const body: SaveSettings = { saveFolder, canSaveToFolder: true, cpuCores: cpuCores() };
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

  // Writes a playlist's songs that are in the "Save to" folder into it as an
  // .m3u8 file (see playlist-file.ts). The page sends songs, never a path.
  app.post(api.folders.playlistFile.path, localOnly(), async (req, res) => {
    const input = api.folders.playlistFile.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      const { saveFolder } = await settings.get();
      if (!saveFolder) return res.status(409).json({ message: NO_FOLDER });
      res.status(201).json(await writePlaylistFile(saveFolder, input.data.name, input.data.songs));
    } catch (err) {
      sendFolderError(res, err, "Couldn't save the playlist file");
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
          // Sent as what it really is, if its name says otherwise.
          audioTypeOf(file.realType ?? file.relative)?.mime ?? "application/octet-stream",
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

  // Fill in details: what a song lacks and what the music catalogues have for
  // it (nothing written), then writing just that into the file.
  app.get(api.music.lookUpDetails.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    try {
      const file = await songFor(req, res);
      if (file) res.json(await lookUpDetails(file));
    } catch (err) {
      if (err instanceof CatalogueError) return res.status(502).json({ message: err.message });
      sendFolderError(res, err, "Couldn't look that song up");
    }
  });

  app.post(api.music.writeDetails.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const details = api.music.writeDetails.input.safeParse(req.body);
    if (!details.success) return res.status(400).json(validationError(details.error));
    try {
      const file = await songFor(req, res);
      if (!file) return;
      const added = await writeSongDetails(file, details.data);
      const { saveFolder } = await settings.get();
      const now = await findMusicFile(saveFolder!, String(req.params.id));
      if (!now) return res.status(404).json({ message: SONG_GONE });
      res.json({ added, track: toMusicTrack(saveFolder!, now, await readTags(now)) });
    } catch (err) {
      if (err instanceof SongDetailsError)
        return res.status(err.status).json({ message: err.message });
      if (err instanceof FolderError) return sendFolderError(res, err, "");
      console.error("Writing a song's details failed:", err);
      res.status(500).json({
        message: `Couldn't write that song's details: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  // Trimming a song: its waveform (to see the dead air), cutting a part out,
  // and Undo. The song's original is kept in the backup folder (see trim.ts).
  app.get(api.music.waveform.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const file = await songFor(req, res);
      if (!file) return;
      const waveform = await readWaveform(file, controller.signal);
      res.set("Cache-Control", "no-store").json(waveform);
    } catch (err) {
      if (controller.signal.aborted || res.headersSent) return;
      if (err instanceof FolderError) return sendFolderError(res, err, "");
      console.error("Reading a song's waveform failed:", err);
      res.status(500).json({
        message: `Couldn't read that song: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  app.post(api.music.trim.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const input = api.music.trim.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      const file = await songFor(req, res);
      if (!file) return;
      const { saveFolder } = await settings.get();
      res.json(await trimSong(saveFolder!, file, input.data));
    } catch (err) {
      sendFolderError(res, err, "Couldn't trim that song");
    }
  });

  app.post(api.music.undoTrim.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const input = api.music.undoTrim.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      const { saveFolder } = await settings.get();
      if (!saveFolder) return res.status(409).json({ message: NO_FOLDER });
      res.json(await undoTrim(saveFolder, input.data.undo));
    } catch (err) {
      sendFolderError(res, err, "Couldn't put the original back");
    }
  });

  // Deleting a song from the folder (the player's "Delete from folder"): to
  // the Recycle Bin / Trash, or for good only when the page says so — after
  // asking, because its drive has no bin.
  app.delete(api.music.remove.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const input = api.music.remove.input.safeParse(req.body ?? {});
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      const file = await songFor(req, res, { anyFile: true });
      if (!file) return;
      const permanently = input.data.permanently === true;
      await deleteMusicFile(file, { permanently });
      res.json({ trashed: !permanently, bin: binName() });
    } catch (err) {
      if (err instanceof NoBinError) {
        return res.status(409).json({ message: err.message, bin: binName(), noBin: true });
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      sendFolderError(res, err, "Couldn't delete that song");
    }
  });

  // Fix name: a song whose content is another kind of audio than its name
  // says gets the extension it should have.
  app.post(api.music.fixName.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    try {
      const file = await songFor(req, res);
      if (!file) return;
      if (!file.realType) return res.status(409).json({ message: "Its name is right already." });
      const { saveFolder } = await settings.get();
      res.json(await fixSongName(saveFolder!, file, file.realType));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      sendFolderError(res, err, "Couldn't rename that song");
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

  // Managing the history (Recent Extractions): any device using the app may,
  // as long as it's the app's own page asking. The downloaded files stay.
  app.delete(api.downloads.remove.path, sameOriginOnly(), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ message: "No such download" });
    try {
      const removed = await storage.removeDownload(id);
      if (!removed) return res.status(404).json({ message: "That download isn't in the history." });
      res.json(removed);
    } catch {
      res.status(500).json({ message: "Couldn't change the history" });
    }
  });

  app.delete(api.downloads.clear.path, sameOriginOnly(), async (_req, res) => {
    try {
      res.json(await storage.clearDownloads());
    } catch {
      res.status(500).json({ message: "Couldn't clear the history" });
    }
  });

  app.post(api.downloads.restore.path, sameOriginOnly(), async (req, res) => {
    const input = api.downloads.restore.input.safeParse(req.body);
    if (!input.success) {
      const [issue] = input.error.issues;
      return res.status(400).json({ message: issue.message, field: issue.path.join(".") });
    }
    try {
      res.json(await storage.restoreDownloads(input.data.entries));
    } catch {
      res.status(500).json({ message: "Couldn't put the downloads back" });
    }
  });

  // A song's lyrics for the music player, from LRCLIB. Only the title, artist
  // and length are sent there; the song itself never leaves its device.
  app.get(api.lyrics.get.path, async (req, res) => {
    const query = api.lyrics.get.query.safeParse(req.query);
    if (!query.success) {
      const [issue] = query.error.issues;
      return res.status(400).json({ message: issue.message, field: issue.path.join(".") });
    }
    try {
      res.json({ lyrics: await findLyrics(query.data) });
    } catch (err) {
      if (!(err instanceof LyricsError)) console.error("Looking up lyrics failed:", err);
      res.status(502).json({
        message: err instanceof LyricsError ? err.message : "Couldn't look up the lyrics.",
      });
    }
  });

  // How YouTube, SoundCloud and Spotify have been answering lately (see source-health.ts).
  // Nothing in it is about this computer: no paths, no secrets.
  app.get(api.health.sources.path, (_req, res) => {
    res.set("Cache-Control", "no-store").json(sourceHealth.report());
  });

  // The yt-dlp calls below go through youtubeGuard (youtube-limits.ts): a
  // recent answer comes from its cache, and when YouTube refuses (it's
  // limiting this computer) the answer is a 502 that says so, straight away.
  app.post(api.video.info.path, async (req, res) => {
    try {
      const input = api.video.info.input.parse(req.body);

      const videoId = extractVideoId(input.url);
      if (!videoId) {
        return res.status(400).json({ message: "Invalid YouTube URL" });
      }

      const canonical = `https://www.youtube.com/watch?v=${videoId}`;

      const video = await youtubeGuard.run({
        key: videoCacheKey(videoId),
        attempt: () => fetchVideoInfo(canonical),
      });

      res.status(200).json({ ...video, url: input.url });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.issues[0].message,
          field: err.issues[0].path.join("."),
        });
      }
      if (err instanceof YouTubeRefused) return sendRefused(res);
      res.status(500).json({ message: ytDlpFailure(err) });
    }
  });

  // Song search: top results for a text query, official uploads first. A
  // Spotify song link searches for that song, preferring same-length uploads.
  // YouTube's results, or SoundCloud's when YouTube's search fails or finds
  // nothing — SoundCloud is asked at the same time while YouTube has been
  // refusing this computer (searchSongs()). `source=soundcloud` asks
  // SoundCloud alone: for a song YouTube refused to hand over.
  app.get(api.video.search.path, async (req, res) => {
    const query = api.video.search.query.safeParse(req.query);
    if (!query.success) {
      const [issue] = query.error.issues;
      return res.status(400).json({ message: issue.message, field: issue.path.join(".") || "q" });
    }
    const { q, source } = query.data;
    const search = (text: string, options: SongSearchOptions = {}) =>
      source === "soundcloud"
        ? searchSoundCloudOnly(options.soundCloudQuery ?? text, options)
        : searchSongs(text, options);
    try {
      const spotifyLink = await readSpotifyLink(q);
      if (!spotifyLink) return res.json(await search(q));
      if (spotifyLink.kind !== "track") {
        return res.status(400).json({ message: spotifyLinkError(spotifyLink), field: "q" });
      }
      const spotify = await fetchSpotifyTrack(spotifyLink.id);
      const answer = await search(spotifySearchQuery(spotify), {
        targetDuration: spotify.duration,
        soundCloudQuery: spotifySearchQuery(spotify, "soundcloud"),
      });
      res.json({ ...answer, spotify });
    } catch (err) {
      if (err instanceof SpotifyError) {
        return res.status(err.status).json({ message: err.message });
      }
      if (err instanceof SearchFailed) {
        return res
          .status(err.status)
          .json(
            err.limited
              ? { message: err.message, source: "youtube", limited: true }
              : { message: err.message },
          );
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

  // The videos in a public YouTube playlist, for the playlist panel. Picking
  // one opens it like a pasted link; "Download" saves the ticked ones as they are.
  app.get(api.youtube.playlist.path, async (req, res) => {
    const query = api.youtube.playlist.query.safeParse(req.query);
    if (!query.success) return res.status(400).json(validationError(query.error));
    try {
      res.json(await fetchYouTubePlaylist(query.data.link));
    } catch (err) {
      if (err instanceof YouTubePlaylistError) {
        return res.status(err.status).json({ message: err.message });
      }
      if (err instanceof YouTubeRefused) return sendRefused(res);
      console.error("Reading the YouTube playlist failed:", err);
      res.status(500).json({ message: err instanceof Error ? err.message : "Couldn't read it" });
    }
  });

  // Streams a video's audio as a download: yt-dlp → ffmpeg → response. `url`
  // is a YouTube video, or a SoundCloud track (a SoundCloud search result).
  // `?format=mp3` (default) converts to MP3; `?format=original` keeps the
  // source's own stream untouched. See server/audio.ts for the details.
  app.get(api.video.download.path, async (req, res) => {
    // Watch for the browser going away (download cancelled, tab closed) from the
    // very start — the metadata lookup below can take 10–20s, and a cancel during
    // it must stop us from starting processes that would then block forever.
    let clientGone = false;
    let stopPipeline: (() => void) | undefined;
    // The cover files made for this download, deleted once it's over.
    let output: PreparedOutput | undefined;
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
      // Only a YouTube video or a SoundCloud track, and only its canonical link
      // goes to yt-dlp.
      const link = audioLinkOf(url);
      if (!link) {
        return res.status(400).send("Invalid or missing YouTube or SoundCloud link");
      }

      // A Spotify song is tagged with Spotify's title and artists (looked up
      // while the source is asked about the audio).
      const songTags = spotifyId ? spotifySongTags(spotifyId) : undefined;
      // And its cover: Spotify's album cover, or the video's thumbnail — looked up
      // meanwhile — or a SoundCloud track's artwork, once the look-up has found it.
      const videoCover =
        link.source === "youtube"
          ? coverFor({ kind: "youtube", videoId: link.videoId }, songTags)
          : undefined;

      // Metadata first, so audio that can't be downloaded fails with a clean
      // error before a streaming response is opened. (A refusal from YouTube
      // is answered at once with a 502 that says so.)
      const info = await lookUpAudio(link);
      const tags = { ...info, ...(await songTags), spotifyId };
      // Its genre (and for a song without an album, its album) from the music
      // catalogues, looked up meanwhile. It never fails or holds the download up.
      const lookedUp = lookUpDownload(tags, info.duration);

      // Cancelled while we were looking up the video: don't start any work.
      if (clientGone) return;

      // These only go out with the first chunk of audio, so a failure before
      // then can still be turned into a proper error response (see below).
      const cover =
        videoCover ??
        coverFor(info.artwork ? { kind: "soundcloud", url: info.artwork } : undefined, songTags);
      const ownCover = await cover;
      output = await prepareAudioOutput(
        format,
        tags,
        info.acodec,
        ownCover,
        lateDetails(lookedUp, ownCover !== undefined),
      );
      if (clientGone) return;
      // Saved as the name chosen on the page, or the video's title. res.attachment
      // writes both a plain filename and a UTF-8 one (filename*), so accents and
      // non-Latin titles survive.
      res.attachment(`${safeFileName(name || info.title)}.${output.ext}`);
      res.header("Content-Type", output.contentType);

      // yt-dlp is pinned to the stream the metadata pass picked, so the container
      // chosen for "original" always matches the audio that arrives.
      const pipeline = startAudioPipeline(
        link.url,
        info.formatId,
        output.ffmpegArgs,
        output.prefix,
      );
      stopPipeline = pipeline.stop;
      pipeline.audio.pipe(res, { end: false });

      const { ok, reason } = await pipeline.finished;
      if (clientGone) return;
      // Recorded for the source-health report; YouTube may have refused it.
      const refused = audioEnded(link, ok, reason);

      if (!res.headersSent) {
        // Failed before producing any audio (e.g. YouTube refused the stream).
        res.removeHeader("Content-Disposition");
        if (refused) {
          console.error(`Download refused by YouTube before any audio was sent: ${reason}`);
          return sendRefused(res);
        }
        const why = reason || `${sourceName(link)} sent no audio`;
        console.error(`Download failed before any audio was sent: ${why}`);
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
          .createDownload({ url, title: info.title, spotifyId, source: link.source })
          .catch((err) => console.error("Failed to save download history", err));
      });
      res.end();
    } catch (err) {
      stopPipeline?.();
      if (err instanceof YouTubeRefused && !res.headersSent) {
        res.removeHeader("Content-Disposition");
        return sendRefused(res);
      }
      console.error(err);
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        res
          .status(500)
          .type("text/plain")
          .send(err instanceof Error ? err.message : "Failed to download video");
      } else {
        res.end();
      }
    } finally {
      // ffmpeg has read the cover by now (or never will): it's no longer needed.
      void output?.cleanup();
    }
  });

  return httpServer;
}
