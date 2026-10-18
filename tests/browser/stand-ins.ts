import { spawn } from "child_process";
import { promises as fs } from "fs";
import http from "http";
import net, { type AddressInfo } from "net";
import os from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import type { Page, Route } from "@playwright/test";

/**
 * Stand-ins for the browser tests that don't talk to YouTube, Spotify or SoundCloud: the app's
 * answers that would need them (a video's details, a search, the audio itself) come from the
 * test, as songs ffmpeg makes, and anything the page asks of another site is turned away. The
 * rest is the real app: its page, and its own routes for settings, folders and the history.
 * The tests tagged @live are the ones that use the real services (see playwright.config.ts).
 */

/** A thumbnail that needs no network. */
export const THUMBNAIL =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

/** A short MP3 of a tone, as ffmpeg makes it (what a download sends the browser). */
export async function makeSong(seconds = 3): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-e2e-song-"));
  const file = path.join(dir, "song.mp3");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        ffmpegPath!,
        [
          ...["-hide_banner", "-loglevel", "error", "-y"],
          ...["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`],
          ...["-c:a", "libmp3lame", "-b:a", "128k", file],
        ],
        { windowsHide: true },
      );
      let err = "";
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
    });
    return await fs.readFile(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Turns away every request the page makes to another site (a thumbnail, YouTube's player), so a
 * test can't pass by reaching the real services. Returns the addresses it turned away.
 */
export async function stayOffline(page: Page): Promise<string[]> {
  const turnedAway: string[] = [];
  const local = new URL(process.env.E2E_BASE_URL ?? "http://localhost").hostname;
  await page.context().route(
    (url) =>
      /^(https?|wss?):$/.test(url.protocol) &&
      !["localhost", "127.0.0.1", "[::1]", local].includes(url.hostname),
    (route) => {
      turnedAway.push(route.request().url());
      return route.abort("blockedbyclient");
    },
  );
  return turnedAway;
}

/** The query parameters of a request the page made. */
export const queryOf = (route: Route) => new URL(route.request().url()).searchParams;

/**
 * The headers the app answers a download with (`GET /api/video/download`): an MP3, under the
 * name it was asked to save it as, written as `res.attachment()` writes it — a plain name, and a
 * UTF-8 one (`filename*`) only when the name isn't plain ASCII.
 */
export function downloadHeaders(fileName: string) {
  const plain = fileName.replace(/[^\x20-\x7e]/g, "?").replace(/["\\]/g, "\\$&");
  const utf8 = !/[^\x20-\x7e]/.test(fileName)
    ? ""
    : `; filename*=UTF-8''${encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  return {
    "Content-Type": "audio/mpeg",
    "Content-Disposition": `attachment; filename="${plain}"${utf8}`,
  };
}

/** Answers one of the app's routes in its place (see `startFront()`). */
export type FrontAnswer = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
) => void | Promise<void>;

export type Front = {
  /** Where the page is opened: the app, through the front. */
  url: string;
  /** Answers requests for `pathname` with `answer` instead of passing them to the app. */
  answer: (pathname: string, answer: FrontAnswer) => void;
  close: () => Promise<void>;
};

/**
 * A stand-in in front of the app, for what a test can't answer with `page.route()`: a file the
 * browser downloads (a link with `download`, which Playwright's routing doesn't see in Chrome).
 * The page is opened through it, and every request it isn't told to answer (the page, the
 * app's other routes, the dev server's live-reload socket) goes on to the app unchanged, from
 * this computer, so the app treats the page as its own.
 */
export async function startFront(appUrl: string): Promise<Front> {
  const app = new URL(appUrl);
  const port = Number(app.port || 80);
  const answers = new Map<string, FrontAnswer>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://front");
    const answer = answers.get(url.pathname);
    if (answer) {
      Promise.resolve(answer(req, res, url)).catch((err: unknown) => res.destroy(err as Error));
      return;
    }
    const upstream = http.request(
      { hostname: app.hostname, port, path: req.url, method: req.method, headers: req.headers },
      (answered) => {
        res.writeHead(answered.statusCode ?? 502, answered.headers);
        answered.pipe(res);
      },
    );
    upstream.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
    // A request the browser gives up on (Cancel) is given up on at the app too.
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    const upstream = net.connect(port, app.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    keep(upstream);
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  // Closing ends every connection, the live-reload socket's too (once upgraded, the server
  // no longer counts it as its own).
  const sockets = new Set<net.Socket>();
  const keep = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  server.on("connection", keep);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port: frontPort } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${frontPort}`,
    answer: (pathname, answer) => answers.set(pathname, answer),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/**
 * The download history (`GET /api/downloads`) as the app would answer it: `entries()` at the
 * time of asking, newest first. Lets a test add what a stand-in download "finished".
 */
export async function answerHistory(
  page: Page,
  entries: () => { url: string; title: string; source?: "soundcloud"; spotifyId?: string }[],
) {
  const start = Date.now();
  await page.route("**/api/downloads", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          json: entries()
            .map((entry, i) => ({
              id: i + 1,
              downloadedAt: new Date(start + i * 1000).toISOString(),
              ...entry,
            }))
            .reverse(),
        })
      : route.continue(),
  );
}
