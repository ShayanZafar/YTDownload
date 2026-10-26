/** Housekeeping: checking songs, better copies, and the folder's other files. */
import type { Express } from "express";
import { api } from "@shared/routes";
import { SearchFailed } from "../search";
import { musicIdSchema } from "@shared/schema";
import { settings } from "../settings";
import { localOnly } from "../local-only";
import { FolderError } from "../folders";
import { readTags } from "../library";
import { checkSong, deleteOtherFile, otherFiles } from "../housekeeping";
import { BetterCopyError, findBetterCopy, replaceWithBetterCopy } from "../better-copy";
import { findMusicFile, toMusicTrack } from "../music";
import { binName, NoBinError } from "../trash";
import { YouTubeRefused, sendRefused } from "../youtube-limits";
import {
  sendFolderError,
  NO_FOLDER,
  SONG_GONE,
  FILE_GONE,
  PLAYER_NOT_LOCAL,
  songFor,
  validationError,
} from "./helpers";

export function registerHousekeepingRoutes(app: Express) {
  // Housekeeping: a song read all the way through, and what's wrong with it.
  app.get(api.music.check.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    try {
      const file = await songFor(req, res, { anyFile: true });
      if (!file) return;
      res.json(await checkSong(file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      sendFolderError(res, err, "Couldn't check that song");
    }
  });

  // Housekeeping's better copies: the same song online at a higher bitrate,
  // and replacing the song with it (the old one to the bin: better-copy.ts).
  app.get(api.music.findBetterCopy.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    try {
      const file = await songFor(req, res);
      if (!file) return;
      res.json(await findBetterCopy(file));
    } catch (err) {
      if (err instanceof YouTubeRefused) return sendRefused(res);
      if (err instanceof SearchFailed) {
        return res
          .status(err.status)
          .json(
            err.limited
              ? { message: err.message, source: "youtube", limited: true }
              : { message: err.message },
          );
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      if (err instanceof FolderError) return sendFolderError(res, err, "");
      res.status(502).json({
        message: `Couldn't look for a better copy: ${err instanceof Error ? err.message : err}`,
      });
    }
  });

  app.post(api.music.replaceWithBetterCopy.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const input = api.music.replaceWithBetterCopy.input.safeParse(req.body);
    if (!input.success) return res.status(400).json(validationError(input.error));
    try {
      const file = await songFor(req, res);
      if (!file) return;
      if (file.realType) {
        return res.status(409).json({
          message: `It's really ${file.realType} audio, whatever its name says: fix its name first.`,
        });
      }
      const check = await replaceWithBetterCopy(file, input.data.url);
      const { saveFolder } = await settings.get();
      const now = await findMusicFile(saveFolder!, String(req.params.id));
      if (!now) return res.status(404).json({ message: SONG_GONE });
      res.json({
        track: toMusicTrack(saveFolder!, now, await readTags(now)),
        check,
        bin: binName(),
      });
    } catch (err) {
      if (err instanceof BetterCopyError)
        return res.status(err.status).json({ message: err.message });
      if (err instanceof YouTubeRefused) return sendRefused(res);
      if (err instanceof NoBinError) {
        return res.status(409).json({
          message: `Its drive has no ${binName()} for the old song to go to, so it was left as it was.`,
          bin: binName(),
          noBin: true,
        });
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: SONG_GONE });
      }
      sendFolderError(res, err, "Couldn't replace that song");
    }
  });

  // Housekeeping: the folder's files that aren't songs, and deleting one.
  app.get(api.music.otherFiles.path, localOnly(PLAYER_NOT_LOCAL), async (_req, res) => {
    try {
      const { saveFolder } = await settings.get();
      if (!saveFolder) return res.status(409).json({ message: NO_FOLDER });
      res.json({ files: (await otherFiles(saveFolder)).files });
    } catch (err) {
      sendFolderError(res, err, "Couldn't look through the folder");
    }
  });

  app.delete(api.music.removeOtherFile.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const input = api.music.removeOtherFile.input.safeParse(req.body ?? {});
    const id = musicIdSchema.safeParse(req.params.id);
    if (!input.success) return res.status(400).json(validationError(input.error));
    if (!id.success) return res.status(400).json({ message: id.error.issues[0].message });
    try {
      const { saveFolder } = await settings.get();
      if (!saveFolder) return res.status(409).json({ message: NO_FOLDER });
      const permanently = input.data.permanently === true;
      if (!(await deleteOtherFile(saveFolder, id.data, { permanently }))) {
        return res.status(404).json({ message: FILE_GONE });
      }
      res.json({ trashed: !permanently, bin: binName() });
    } catch (err) {
      if (err instanceof NoBinError) {
        return res.status(409).json({ message: err.message, bin: binName(), noBin: true });
      }
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return res.status(404).json({ message: FILE_GONE });
      }
      sendFolderError(res, err, "Couldn't delete that file");
    }
  });
}
