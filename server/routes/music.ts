/** The music player: the folder's songs, their audio, covers and lyrics, deleting and renaming them. */
import type { Express } from "express";
import path from "path";
import { api } from "@shared/routes";
import { safeFileName } from "@shared/filename";
import { audioTypeOf, songNameOf } from "@shared/audio-types";
import { settings } from "../settings";
import { localOnly } from "../local-only";
import { LyricsError, findLyrics } from "../lyrics";
import { FolderError } from "../folders";
import { readTags } from "../library";
import {
  convertedForBrowser,
  deleteMusicFile,
  findMusicFile,
  assertNameFree,
  fixSongName,
  renameSong,
  listMusic,
  readCover,
  toMusicTrack,
} from "../music";
import { SongDetailsError, writeSongDetails } from "../song-details";
import { logDetails } from "../details-log";
import { binName, NoBinError } from "../trash";
import {
  sendFolderError,
  NO_FOLDER,
  SONG_GONE,
  PLAYER_NOT_LOCAL,
  songFor,
  sendAudioFile,
  validationError,
} from "./helpers";

export function registerMusicRoutes(app: Express) {
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

  // Rename, and Sanitize Filename: a song gets the file name, title or artist
  // the person typed or ticked — the tags first, then the file's name (but a
  // song that's another kind of audio than its name says gets its right name
  // first: its tags can't be written until then).
  app.post(api.music.rename.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const input = api.music.rename.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    const { name, title, artist } = input.data;
    try {
      let file = await songFor(req, res, { anyFile: name !== undefined && !title && !artist });
      if (!file) return;
      const { saveFolder } = await settings.get();
      // Its extension stays — or, for a song that's another kind of audio than
      // its name says (an M4A named .mp3), becomes the right one, as Fix name's.
      const fileName =
        name === undefined
          ? undefined
          : `${safeFileName(name, songNameOf(file.relative))}${file.realType ?? path.extname(file.relative)}`;
      const renaming = fileName !== undefined && fileName !== path.basename(file.relative);
      const retagging = title !== undefined || artist !== undefined;
      if (!renaming && !retagging) {
        return res.status(409).json({ message: "It has that name already." });
      }
      // A name that's taken is refused before anything is changed.
      if (renaming) await assertNameFree(file, fileName);
      let changed = false;
      let id = String(req.params.id);
      const renameFirst = renaming && !!file.realType;
      if (renameFirst) {
        id = (await renameSong(saveFolder!, file, fileName)).id;
        changed = true;
        file = await findMusicFile(saveFolder!, id);
        if (!file) return res.status(404).json({ message: SONG_GONE });
      }
      if (retagging) {
        const retagged =
          (await writeSongDetails(file, {}, { replace: { title, artist } })).length > 0;
        changed ||= retagged;
        void logDetails({
          kind: "write",
          song: file.relative,
          outcome: retagged ? "renamed" : "nothing to change",
          details: [title && `title ${title}`, artist && `artist ${artist}`].filter(
            (word): word is string => !!word,
          ),
        });
      }
      if (renaming && !renameFirst) {
        id = (await renameSong(saveFolder!, file, fileName)).id;
        changed = true;
      }
      if (!changed) return res.status(409).json({ message: "It has that name already." });
      file = await findMusicFile(saveFolder!, id);
      if (!file) return res.status(404).json({ message: SONG_GONE });
      res.json({ track: toMusicTrack(saveFolder!, file, await readTags(file)) });
    } catch (err) {
      if (err instanceof SongDetailsError)
        return res.status(err.status).json({ message: err.message });
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      sendFolderError(res, err, "Couldn't rename that song");
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
}
