/**
 * Every API route, one module per area: each `register…Routes()` adds its
 * area's routes, and what they share (finding a folder song, sending one,
 * their errors) is in helpers.ts. The paths and their inputs are in
 * shared/routes.ts.
 */
import type { Express } from "express";
import { type Server } from "http";
import { registerDownloadRoutes } from "./download";
import { registerFolderRoutes } from "./folders";
import { registerHistoryRoutes } from "./history";
import { registerHousekeepingRoutes } from "./housekeeping";
import { registerMusicRoutes } from "./music";
import { registerSearchRoutes } from "./search";
import { registerSongDetailsRoutes } from "./song-details";
import { registerSpotifyRoutes } from "./spotify";
import { registerTrimRoutes } from "./trim";

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  registerFolderRoutes(app);
  registerMusicRoutes(app);
  registerSongDetailsRoutes(app);
  registerTrimRoutes(app);
  registerHousekeepingRoutes(app);
  registerHistoryRoutes(app);
  registerSearchRoutes(app);
  registerSpotifyRoutes(app);
  registerDownloadRoutes(app);
  return httpServer;
}
