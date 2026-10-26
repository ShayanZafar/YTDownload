/** The Save to folder: settings, the folder browser, saving into it, and what's in it. */
import type { Express } from "express";
import { api } from "@shared/routes";
import type { SaveSettings } from "@shared/schema";
import { settings, type Settings } from "../settings";
import { cpuCores } from "../cpu-cores";
import { isLocalRequest, localOnly } from "../local-only";
import {
  assertWritableFolder,
  createFolder,
  defaultFolder,
  listFolders,
  placesToSave,
} from "../folders";
import { saveIntoFolder } from "../save";
import { songsInFolder } from "../library";
import { writePlaylistFile } from "../playlist-file";
import { sendFolderError, NO_FOLDER, validationError } from "./helpers";

export function registerFolderRoutes(app: Express) {
  // --- "Save to" folder ------------------------------------------------------
  // The page can't reach the disk, so the app does the saving: these routes
  // pick the folder and write downloads into it. Only a browser on this
  // computer gets to use them (localOnly), which is why they work in any browser
  // there — and never for another device or another website.

  app.get(api.settings.get.path, async (req, res) => {
    const local = isLocalRequest(req);
    try {
      const { saveFolder, qualityBar } = await settings.get();
      const body: SaveSettings = {
        saveFolder: local ? saveFolder : null,
        canSaveToFolder: local,
        cpuCores: cpuCores(),
        qualityBar,
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
      const patch: Partial<Settings> = {};
      if (input.data.saveFolder !== undefined) {
        patch.saveFolder =
          input.data.saveFolder === null
            ? null
            : await assertWritableFolder(input.data.saveFolder, { tryWriting: true });
      }
      if (input.data.qualityBar) patch.qualityBar = input.data.qualityBar;
      const { saveFolder, qualityBar } = await settings.update(patch);
      const body: SaveSettings = {
        saveFolder,
        canSaveToFolder: true,
        cpuCores: cpuCores(),
        qualityBar,
      };
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
}
