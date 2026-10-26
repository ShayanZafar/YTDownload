/** Trim: a song's waveform, cutting a part out, and Undo. */
import type { Express } from "express";
import { api } from "@shared/routes";
import { settings } from "../settings";
import { localOnly } from "../local-only";
import { FolderError } from "../folders";
import { readWaveform, trimSong, undoTrim } from "../trim";
import { sendFolderError, NO_FOLDER, PLAYER_NOT_LOCAL, songFor, validationError } from "./helpers";

export function registerTrimRoutes(app: Express) {
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
}
