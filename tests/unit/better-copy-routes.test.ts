import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { REFUSED_MESSAGE, youtubeGuard } from "../../server/youtube-limits";
import { soundCloudCache } from "../../server/search";
import { FFMPEG_PATH } from "../../server/audio";
import { binName } from "../../server/trash";
import {
  betterCopyLookupSchema,
  musicLibrarySchema,
  replacedSongSchema,
  songCheckSchema,
} from "../../shared/schema";

// Housekeeping's better copies through the real routes, against a real song
// in a temporary "Save to" folder: yt-dlp is played by stand-ins (its search
// and look-up answers are fakes, its audio stream a Node process sending an
// ffmpeg-made file), and the bin is the tests' own. No network.

const fake = vi.hoisted(() => ({
  audioInfo: vi.fn(),
  runJson: vi.fn(),
  /** The file the stand-in yt-dlp sends. */
  stream: "",
}));

vi.mock("../../server/audio", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../server/audio")>();
  return {
    ...real,
    fetchAudioInfo: fake.audioInfo,
    runYtDlpJson: fake.runJson,
  };
});

// The bin: the tests' own (TRASH_DIR), unless a test says the drive has none.
const moveToTrash = vi.hoisted(() => vi.fn());
vi.mock("../../server/trash", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../server/trash")>();
  moveToTrash.mockImplementation(real.moveToTrash);
  return { ...real, moveToTrash };
});

// The stand-in yt-dlp: the real pipeline, with a Node process sending `fake.stream`.
vi.mock("../../server/better-copy", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../server/better-copy")>();
  return {
    ...real,
    replaceWithBetterCopy: (...[file, url, deps]: Parameters<typeof real.replaceWithBetterCopy>) =>
      real.replaceWithBetterCopy(file, url, {
        ...deps,
        spawnSource: () =>
          spawn(
            process.execPath,
            [
              "-e",
              "require('fs').createReadStream(process.argv[1]).pipe(process.stdout)",
              fake.stream,
            ],
            { windowsHide: true },
          ),
      }),
  };
});

const BOT_CHECK = "Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies";

let app: express.Express;
let dir: string;
let folder: string;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH!, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg: ${err}`))));
  });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-audio-better-copy-api-"));
  process.env.HISTORY_FILE = path.join(dir, "history.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.PLAYER_CACHE_DIR = path.join(dir, "cache");
  process.env.TRASH_DIR = path.join(dir, "trash");
  folder = path.join(dir, "Music");
  await fs.mkdir(folder);
  // A 64 kbps song, tagged, and what "YouTube" has: the same 20 s as Opus.
  await ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=20"],
    ...["-c:a", "libmp3lame", "-b:a", "64k", "-id3v2_version", "3"],
    ...[
      "-metadata",
      "title=Low Tone",
      "-metadata",
      "artist=Sine Wave",
      "-metadata",
      "genre=Electronic",
    ],
    path.join(folder, "Sine Wave - Low Tone.mp3"),
  ]);
  fake.stream = path.join(dir, "youtube.webm");
  await ffmpeg([
    ...["-f", "lavfi", "-i", "sine=frequency=440:duration=20"],
    ...["-c:a", "libopus", "-b:a", "128k", fake.stream],
  ]);

  const { registerRoutes } = await import("../../server/routes");
  app = express();
  app.use(express.json());
  await registerRoutes(createServer(app), app);
  await request(app).put("/api/settings").send({ saveFolder: folder }).expect(200);
});

afterEach(() => {
  vi.restoreAllMocks();
  youtubeGuard.reset();
  soundCloudCache.clear();
});

afterAll(async () => {
  for (const name of ["HISTORY_FILE", "SETTINGS_FILE", "PLAYER_CACHE_DIR", "TRASH_DIR"]) {
    delete process.env[name];
  }
  await fs.rm(dir, { recursive: true, force: true });
});

/** YouTube's search: an upload of the song at its length, and a live one. */
function youtubeHasIt() {
  fake.runJson.mockResolvedValue({
    entries: [
      { id: "aaaaaaaaaaa", title: "Sine Wave - Low Tone (Live)", duration: 20 },
      { id: "ddddddddddd", title: "Sine Wave - Low Tone", duration: 20, channel: "Sine Wave" },
    ],
  });
  fake.audioInfo.mockResolvedValue({
    title: "Low Tone",
    formatId: "251",
    acodec: "opus",
    abr: 130,
  });
}

describe("Better copies (API)", () => {
  it("finds a better copy, keeps the song when its drive has no bin, then replaces it", async () => {
    youtubeHasIt();
    const [song] = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    const found = betterCopyLookupSchema.parse(
      (await request(app).get(`/api/music/${song.id}/better-copy`).expect(200)).body,
    );
    expect(found).toEqual({
      kbps: 64,
      copy: {
        url: "https://www.youtube.com/watch?v=ddddddddddd",
        title: "Sine Wave - Low Tone",
        channel: "Sine Wave",
        source: "youtube",
        seconds: 20,
        kbps: 130,
        codec: "Opus",
      },
      reason: null,
    });
    expect(fake.runJson.mock.calls[0][0].at(-1)).toBe("ytsearch12:Sine Wave Low Tone audio");
    // Never for another device.
    const away = await request(app)
      .post(`/api/music/${song.id}/better-copy`)
      .set("X-Forwarded-For", "192.168.1.20")
      .send({ url: found.copy!.url });
    expect(away.status).toBe(403);

    // A drive with no bin: the song is left as it was.
    const before = await fs.readFile(path.join(folder, "Sine Wave - Low Tone.mp3"));
    const { NoBinError } = await import("../../server/trash");
    moveToTrash.mockRejectedValueOnce(new NoBinError("no bin"));
    const noBin = await request(app)
      .post(`/api/music/${song.id}/better-copy`)
      .send({ url: found.copy!.url });
    expect(noBin.status).toBe(409);
    expect(noBin.body).toMatchObject({ noBin: true, bin: binName() });
    expect(noBin.body.message).toMatch(/left as it was/);
    expect(await fs.readdir(folder)).toEqual(["Sine Wave - Low Tone.mp3"]);
    expect((await fs.readFile(path.join(folder, "Sine Wave - Low Tone.mp3"))).equals(before)).toBe(
      true,
    );

    const replaced = replacedSongSchema.parse(
      (await request(app).post(`/api/music/${song.id}/better-copy`).send({ url: found.copy!.url }))
        .body,
    );
    expect(replaced).toMatchObject({
      track: { id: song.id, title: "Low Tone", artist: "Sine Wave", genres: ["Electronic"] },
      check: { kbps: 320, damaged: null, cutShort: null },
      bin: binName(),
    });
    expect(await fs.readdir(folder)).toEqual(["Sine Wave - Low Tone.mp3"]);
    const binned = await fs.readFile(
      path.join(process.env.TRASH_DIR!, "files", "Sine Wave - Low Tone.mp3"),
    );
    expect(binned.equals(before)).toBe(true);
    // Housekeeping's own check sees the new copy.
    const check = songCheckSchema.parse(
      (await request(app).get(`/api/music/${song.id}/check`).expect(200)).body,
    );
    expect(check.kbps).toBe(320);
    // Now nothing online is better.
    const again = betterCopyLookupSchema.parse(
      (await request(app).get(`/api/music/${song.id}/better-copy`).expect(200)).body,
    );
    expect(again).toMatchObject({ kbps: 320, copy: null });
    expect(again.reason).toMatch(/no better than this one's 320 kbps/);
  });

  it("answers a refusal from YouTube at once, and refuses a link that isn't a song's", async () => {
    youtubeHasIt();
    // A refusal starts a background update of yt-dlp: never a real one here.
    vi.spyOn(youtubeGuard.updater, "update").mockResolvedValue(false);
    fake.audioInfo.mockRejectedValue(new Error(`ERROR: [youtube] ddddddddddd: ${BOT_CHECK}`));
    const [song] = musicLibrarySchema.parse((await request(app).get("/api/music")).body).tracks;
    const refused = await request(app).get(`/api/music/${song.id}/better-copy`);
    expect(refused.status).toBe(502);
    expect(refused.body).toEqual({ message: REFUSED_MESSAGE, source: "youtube", limited: true });

    const notASong = await request(app)
      .post(`/api/music/${song.id}/better-copy`)
      .send({ url: "https://example.com/song.mp3" });
    expect(notASong.status).toBe(400);
    expect(notASong.body.message).toBe("That isn't a YouTube video or a SoundCloud track.");
    expect((await request(app).get("/api/music/nope/better-copy")).status).toBe(400);
  });
});
