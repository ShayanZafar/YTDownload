import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { api } from "../../shared/routes";

// The routes that set this computer to work (a download, a search, a video,
// playlist or Spotify look-up, lyrics) answer only this app's own page: another
// website's link or picture pointing at the app is refused before any work
// starts. No network: each request is turned away, or fails its own checks.

let server: Server;
let base: string;

beforeAll(async () => {
  const { registerRoutes } = await import("../../server/routes");
  const app = express();
  app.use(express.json());
  server = createServer(app);
  await registerRoutes(server, app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// Each with no input at all, so a request that gets past the guard stops at its own checks.
const routes: { method: "GET" | "POST"; path: string }[] = [
  api.video.download,
  api.video.search,
  api.video.info,
  api.youtube.playlist,
  api.spotify.link,
  api.spotify.playlist,
  api.lyrics.get,
];

const ask = (route: { method: string; path: string }, site: string) =>
  fetch(`${base}${route.path}`, {
    method: route.method,
    headers: {
      "Sec-Fetch-Site": site,
      ...(route.method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: route.method === "POST" ? "{}" : undefined,
  });

describe("routes that start work", () => {
  it.each(routes)("$method $path refuses another website", async (route) => {
    const res = await ask(route, "cross-site");
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe("Only this app's own page can do that.");
  });

  it.each(routes)("$method $path still answers the app's own page", async (route) => {
    const res = await ask(route, "same-origin");
    // Past the guard: turned down for having no link, query or song.
    expect(res.status).toBe(400);
  });
});
