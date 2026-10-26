/** The download history (Recent Extractions). */
import type { Express } from "express";
import { storage } from "../storage";
import { api } from "@shared/routes";
import { settings } from "../settings";
import { localOnly, sameOriginOnly } from "../local-only";
import { historyInFolder } from "../music";
import { sendFolderError } from "./helpers";

export function registerHistoryRoutes(app: Express) {
  app.get(api.downloads.list.path, async (_req, res) => {
    try {
      const allDownloads = await storage.getDownloads();
      res.status(200).json(allDownloads);
    } catch {
      res.status(500).json({ message: "Failed to fetch downloads" });
    }
  });

  // Which downloads in the history are in the "Save to" folder still, to play
  // from it: only on this computer, and only ever the chosen folder.
  app.get(api.downloads.inFolder.path, localOnly(), async (_req, res) => {
    try {
      const { saveFolder } = await settings.get();
      if (!saveFolder) {
        return res.status(409).json({ message: "Choose a folder to save into first." });
      }
      res.json(await historyInFolder(saveFolder, await storage.getDownloads()));
    } catch (err) {
      sendFolderError(res, err, "Couldn't look through the folder");
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
}
