/** Fill in details: looking a song up in the music catalogues, its log, and writing what was found. */
import type { Express } from "express";
import { api } from "@shared/routes";
import { settings } from "../settings";
import { localOnly } from "../local-only";
import { FolderError } from "../folders";
import { readTags } from "../library";
import { CatalogueError } from "../catalogues";
import { findMusicFile, folderArtistSongs, toMusicTrack } from "../music";
import { lookUpDetails, SongDetailsError, writeSongDetails } from "../song-details";
import { detailWords, logDetails, lookupEntry, readDetailsLog } from "../details-log";
import { sendFolderError, SONG_GONE, PLAYER_NOT_LOCAL, songFor, validationError } from "./helpers";

export function registerSongDetailsRoutes(app: Express) {
  // Fill in details: what a song lacks and what the music catalogues have for
  // it (nothing written), then writing just that into the file.
  app.get(api.music.lookUpDetails.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    try {
      const file = await songFor(req, res);
      if (!file) return;
      try {
        const { saveFolder } = await settings.get();
        const lookup = await lookUpDetails(file, () => folderArtistSongs(saveFolder!));
        void logDetails(lookupEntry(file.relative, lookup));
        res.json(lookup);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void logDetails({
          kind: "look-up",
          song: file.relative,
          outcome: "failed",
          details: [message],
        });
        throw err;
      }
    } catch (err) {
      if (err instanceof CatalogueError) return res.status(502).json({ message: err.message });
      sendFolderError(res, err, "Couldn't look that song up");
    }
  });

  // The details log's newest lines, for reading in the browser.
  app.get(api.music.detailsLog.path, localOnly(PLAYER_NOT_LOCAL), async (_req, res) => {
    const log = await readDetailsLog();
    res
      .type("text/plain; charset=utf-8")
      .send(log || "Nothing in the details log yet: Fill in details and downloads add to it.");
  });

  app.post(api.music.writeDetails.path, localOnly(PLAYER_NOT_LOCAL), async (req, res) => {
    const details = api.music.writeDetails.input.safeParse(req.body);
    if (!details.success) return res.status(400).json(validationError(details.error));
    try {
      const file = await songFor(req, res);
      if (!file) return;
      const added = await writeSongDetails(file, details.data).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        void logDetails({
          kind: "write",
          song: file.relative,
          outcome: "failed",
          details: [message],
        });
        throw err;
      });
      void logDetails({
        kind: "write",
        song: file.relative,
        outcome: added.length > 0 ? "added" : "nothing to add (it has them all now)",
        details: detailWords(details.data).filter((word) =>
          added.some((field) => word.startsWith(field === "cover" ? "cover" : `${field} `)),
        ),
      });
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
}
