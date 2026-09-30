# Technical Documentation & Deployment Guide

This document covers the project's architecture, local development setup, environment configuration, and deployment instructions.

---

## Tech Stack

### Frontend

- **React 18** with TypeScript
- **Vite 7** as the dev server and build tool
- **Wouter** for client-side routing
- **TanStack Query v5** for server-state management and caching
- **Tailwind CSS 3** with shadcn/ui components for styling
- **Framer Motion** for animations
- **Lucide React** for icons

### Backend

- **Node.js** with **Express 5**
- **TypeScript** (executed via `tsx` in development, bundled with `esbuild` in production)
- **youtube-dl-exec** wrapping a bundled **yt-dlp** binary for YouTube video info & audio stream extraction. On Linux/macOS the binary is a Python script and needs Python 3.10+; on Windows it's a standalone `.exe`. yt-dlp is told to use Node (`--js-runtimes node`) as the JavaScript runtime YouTube now requires, so nothing extra needs installing for that.
- **ffmpeg-static** — an ffmpeg binary fetched by `npm install` (any OS, no system install) that converts the audio to MP3 on the fly. Set `FFMPEG_BIN` to use a different ffmpeg.
- **Zod** for request validation

### Database

- **PostgreSQL** (any standard provider, e.g. a local Docker container, Neon, Supabase, RDS)
- **Drizzle ORM** for type-safe database access
- **drizzle-kit** for schema migrations

---

## Project Structure

```
.
├── client/                    # Frontend React application
│   ├── src/
│   │   ├── components/        # UI components (incl. shadcn/ui in components/ui)
│   │   ├── hooks/             # Custom React hooks (e.g. use-youtube)
│   │   ├── lib/               # Helpers (queryClient, utils)
│   │   ├── pages/             # Route pages (Home, NotFound)
│   │   ├── App.tsx            # Top-level app & router
│   │   ├── main.tsx           # React entry point
│   │   └── index.css          # Global styles & theme variables
│   └── index.html
├── server/                    # Backend Express application
│   ├── index.ts               # App bootstrap, middleware, port binding
│   ├── env.ts                 # Loads .env before anything reads settings
│   ├── routes.ts              # API route handlers
│   ├── youtube-url.ts         # Pure URL-parsing / thumbnail helpers
│   ├── storage.ts             # Storage abstraction (IStorage + DatabaseStorage)
│   ├── db.ts                  # Drizzle + pg connection setup
│   ├── vite.ts                # Dev-only Vite middleware integration
│   └── static.ts              # Production static-file serving
├── shared/                    # Code shared between client & server
│   ├── schema.ts              # Drizzle tables, Zod schemas, types
│   └── routes.ts              # Typed API route definitions
├── script/
│   └── build.ts               # Production build script
├── drizzle.config.ts          # Drizzle Kit config (migrations)
├── tailwind.config.ts         # Tailwind theme configuration
├── vite.config.ts             # Vite configuration
├── tests/                     # unit, api (Vitest) and browser (Playwright) tests
├── CLAUDE.md                  # Project notes Claude Code reads automatically
└── package.json
```

---

## Architecture Overview

### Single-port serving

The Express server and the Vite dev server are mounted on a single port (default `5000`). In development, Vite middleware is attached to Express via `server/vite.ts`, so the API and the frontend live on the same origin — no CORS or proxy configuration required. In production, the built client assets are served as static files by `server/static.ts`.

### Data flow

1. The frontend calls `POST /api/video/info` with a YouTube URL.
2. The backend validates the body with Zod, extracts the canonical video ID (`server/youtube-url.ts`), shells out to `yt-dlp` for metadata, and returns `{ title, thumbnail, url }`.
3. When the user clicks **Download Audio**, the browser navigates to `GET /api/video/download?url=...`. The server does a metadata pass (for the filename and ID3 tags), inserts a `downloads` row, then runs a two-process pipeline (`server/audio.ts`): `yt-dlp` writes the best audio stream YouTube serves without an account (usually Opus at ~130 kbps) to stdout → `ffmpeg` reads it on stdin and writes a 320 kbps constant-bitrate MP3 with title/artist tags to stdout → the HTTP response, with `Content-Type: audio/mpeg` and a `Content-Disposition` header. Nothing touches disk, and the browser's download starts as soon as the first frames are encoded. With `?format=original` (the UI's **Original audio** toggle), ffmpeg doesn't re-encode: it copies YouTube's stream into a proper tagged file — Ogg Opus (`.opus`) for Opus, fragmented MP4 (`.m4a`) for AAC, Matroska (`.mka`) for anything else. The metadata pass requests the same `bestaudio` selection and the stream is pinned to the `format_id` it picked, so the container always matches the audio that arrives.
4. The frontend re-fetches `/api/downloads` to refresh the recent-extractions list.

The visual versions of these flows live in [System Design](#system-design) below.

### Storage abstraction

All database access goes through the `IStorage` interface in `server/storage.ts`. Routes never touch the database directly — they call `storage.getDownloads()` or `storage.createDownload(...)`. This makes it easy to swap implementations or add caching later.

### Shared types & routes

`shared/schema.ts` defines the Drizzle table, the `createInsertSchema` Zod validator, and `Download` / `InsertDownload` TypeScript types. Both the client and the server import from `@shared/schema`, guaranteeing the API contract stays in sync.

---

## System Design

This section is the visual companion to the prose above. All diagrams use [Mermaid](https://mermaid.js.org/), which renders natively on GitHub, VS Code, and most editors with a Markdown plugin.

### Component diagram

The whole system is one Node process plus one Postgres database, plus two helper binaries run as subprocesses: `yt-dlp` (which calls out to YouTube) and `ffmpeg` (which converts to MP3).

```mermaid
flowchart LR
  Browser["Browser<br/>(React + Vite client)"]
  Node["Node.js process<br/>(Express + Vite middleware)"]
  YtDlp["yt-dlp subprocess<br/>(spawned per request)"]
  Ffmpeg["ffmpeg subprocess<br/>(spawned per download)"]
  YouTube["YouTube<br/>(public API + CDN)"]
  DB[("PostgreSQL<br/>downloads table")]

  Browser -- "HTTPS<br/>/api/* + static assets" --> Node
  Node -- "spawn" --> YtDlp
  YtDlp -- "audio (stdout → stdin)" --> Ffmpeg
  Ffmpeg -- "MP3 (stdout)" --> Node
  YtDlp -- "HTTPS" --> YouTube
  Node -- "SQL over TLS" --> DB
```

Key things this picture makes obvious:

- **One port, one process.** The client, the API, and (in dev) the Vite dev server all share port 5000. There is no separate API gateway, no reverse proxy in the default setup.
- **`yt-dlp` and `ffmpeg` are subprocesses, not libraries.** Every metadata fetch spawns a fresh `yt-dlp`; every download spawns a `yt-dlp` + `ffmpeg` pair. Those processes are the unit of failure for anything YouTube-related, and the route is responsible for killing both when the download ends or is cancelled.
- **The database is only on the write path of the download flow** — and even there, a DB failure does not block the download (see Failure modes).

### Sequence: video info (`POST /api/video/info`)

The cheap, synchronous path the user hits when they paste a URL.

```mermaid
sequenceDiagram
  autonumber
  participant C as Browser
  participant S as Express handler
  participant U as youtube-url.ts
  participant Y as yt-dlp subprocess
  participant YT as YouTube

  C->>S: POST /api/video/info { url }
  S->>S: api.video.info.input.parse(req.body)  // Zod
  S->>U: extractVideoId(url)
  U-->>S: "jNQXAC9IVRw" | null
  alt videoId is null
    S-->>C: 400 { message: "Invalid YouTube URL" }
  else valid
    S->>Y: youtubedl(canonical, { dumpSingleJson, skipDownload })
    Y->>YT: HTTPS metadata request
    YT-->>Y: JSON metadata
    Y-->>S: { title, thumbnails, ... }
    S->>U: pickThumbnail(info)
    U-->>S: best thumbnail URL
    S-->>C: 200 { title, thumbnail, url }
  end
```

### Sequence: audio download (`GET /api/video/download`)

The streaming path. Response headers are only flushed with the first chunk of MP3, so a failure **before** any audio (e.g. YouTube refusing the stream) still becomes a clean `502`. Once audio is flowing, a failure can only cut the file short.

```mermaid
sequenceDiagram
  autonumber
  participant C as Browser
  participant S as Express handler
  participant DB as PostgreSQL
  participant Y as yt-dlp subprocess
  participant F as ffmpeg subprocess
  participant YT as YouTube

  C->>S: GET /api/video/download?url=...
  S->>S: extractVideoId(url) → validate
  S->>Y: metadata pass (dumpSingleJson)
  Y->>YT: HTTPS
  YT-->>Y: JSON
  Y-->>S: { title, uploader }
  S->>DB: INSERT INTO downloads (url, title)
  Note over S,DB: DB error here is logged but swallowed —<br/>download still proceeds
  S->>F: spawn ffmpeg (stdin → libmp3lame 320k → stdout)
  S->>Y: spawn yt-dlp (bestaudio, output=-)
  Y->>YT: HTTPS audio stream
  loop streaming
    YT-->>Y: WebM/Opus bytes
    Y-->>F: stdout → stdin
    F-->>S: MP3 frames
    S-->>C: 200 + audio/mpeg (headers with first chunk), then chunks
  end
  alt client cancels (at any point, even during the metadata pass)
    C->>S: response "close"
    S->>Y: kill
    S->>F: kill
  else yt-dlp fails before any audio
    F-->>S: exits, no output
    S-->>C: 502 + yt-dlp's error message
  else yt-dlp fails mid-stream
    Y-->>F: end of input
    F-->>S: flushes remaining frames, exits
    S-->>C: end of (shortened) file
  end
```

### Deployment topology

If you ever host it (on a VPS, Render, Fly.io, a Docker container, …), the picture collapses to one server process with a few outbound dependencies.

```mermaid
flowchart LR
  subgraph Host["Host / container"]
    Node2["Node.js (dist/index.cjs)<br/>+ bundled yt-dlp + ffmpeg binaries<br/>+ Python 3 runtime (Linux)"]
  end
  Internet["Internet users"] -- HTTPS --> Node2
  Node2 -- HTTPS --> YouTubeProd["YouTube"]
  Node2 -- "SQL over TLS<br/>(DATABASE_URL secret)" --> Neon[("Hosted Postgres<br/>e.g. Neon / Supabase")]
```

Notes on this topology:

- The container is **stateless** — every restart is clean. All persistent data is in Postgres.
- `yt-dlp` and `ffmpeg` are fetched into `node_modules/` at install time (`youtube-dl-exec/bin/`, `ffmpeg-static/`), so nothing is installed at runtime. On Linux we **do** need Python 3.10+ in the container, because the Linux yt-dlp build is a Python script.
- There's no object storage. Audio is streamed from `yt-dlp` through `ffmpeg` to the client and never touches disk on the server.

### Failure modes

The interesting failures are at the boundaries with `yt-dlp`, YouTube, and Postgres. The table below is the truth as of the code in `server/routes.ts`:

| Failure                              | Where surfaced                  | Behavior                                                                                                        | User sees                                                    |
| ------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Invalid / non-YouTube URL            | `extractVideoId` returns `null` | Short-circuit, no subprocess spawned                                                                            | `400 Invalid YouTube URL`                                    |
| Zod body validation fails (info)     | `api.video.info.input.parse`    | Caught in handler, returns `field` + `message`                                                                  | `400 { message, field }`                                     |
| `yt-dlp` metadata throws             | `youtubedl(...)` rejection      | Caught in handler                                                                                               | `500 { message }` (info) or `500` text (download)            |
| DB insert into `downloads` fails     | `storage.createDownload(...)`   | **Swallowed** — logged via `console.error`, download proceeds                                                   | Nothing — file still downloads, history just won't show it   |
| `yt-dlp` / `ffmpeg` fails to start   | child process `error` event     | Pipeline stopped; no audio was sent yet                                                                         | `502 Couldn't download the audio: … failed to start`         |
| `yt-dlp` fails before any audio      | `ffmpeg` exits with no output   | Headers not sent yet, so the handler can still answer with an error                                             | `502` with yt-dlp's error message (browser: failed download) |
| `yt-dlp` exits non-zero mid-stream   | `ytdlp.on("close")`             | stderr logged; `ffmpeg` sees end-of-input, flushes and exits; response ended                                    | Shorter but valid MP3                                        |
| Client cancels the download          | `res.on("close")`               | Watched from the start of the request: nothing is spawned if it's already gone, otherwise both processes killed | n/a (user already left)                                      |
| Postgres unreachable on `/downloads` | `storage.getDownloads()` throws | Caught in handler                                                                                               | `500 Failed to fetch downloads`, history list shows error    |
| YouTube blocks the request           | `yt-dlp` exits non-zero         | Same as the two rows above — that's why we keep `yt-dlp` itself up to date, not roll our own scraping logic     | `502`, or a shortened file if it happens mid-stream          |

The deliberate design choice worth flagging: **a database outage doesn't break downloads**. The download history is best-effort, the audio extraction is the product. We chose this over the alternative (fail the download if we can't log it), because the user's download is what they came for.

### Scaling considerations

This stack is designed for a small-to-medium audience. Here's where it would crack and what we'd do about it:

| Bottleneck                     | When it bites                                                                                             | First thing to do                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Single Node process            | Sustained concurrent downloads, since each one occupies an event-loop slot for the duration of the stream | Run multiple Node instances behind a load balancer.                                                               |
| Subprocess fan-out             | Each download runs a `yt-dlp` + `ffmpeg` pair; MP3 encoding is the main CPU cost                          | Add a per-instance concurrency cap (e.g., a small `p-limit` queue around the download pipeline).                  |
| Outbound bandwidth from server | Every byte of audio flows server → client                                                                 | Move to a presigned-URL or proxy-and-cache model, where popular videos hit a CDN instead of `yt-dlp` per request. |
| Postgres connection pool       | Many concurrent requests sharing one pool                                                                 | Tune the pool size in `server/db.ts`; for serverless Postgres (Neon), the HTTP driver handles this automatically. |
| `yt-dlp` extractor rot         | YouTube periodically changes its players and `yt-dlp` ships a fix                                         | Bump the `youtube-dl-exec` dependency on a cadence (or pin a specific `yt-dlp` binary release).                   |
| No background job queue        | If a future feature needs work to outlive the request (e.g., batch playlist downloads)                    | Introduce a queue (BullMQ + Redis is the conventional pick) and a worker process.                                 |
| No caching of metadata         | Same URL fetched repeatedly costs a `yt-dlp` spawn each time                                              | Add a short TTL cache (in-memory `lru-cache` or Redis) keyed by canonical video ID.                               |

None of these are problems today. They're listed here so the next person doesn't have to rediscover the ceiling.

---

## Database Schema

A single table tracks every successful download:

```ts
// shared/schema.ts
downloads {
  id            serial PRIMARY KEY,
  url           text   NOT NULL,
  title         text   NOT NULL,
  downloadedAt  timestamp DEFAULT now()
}
```

---

## API Reference

| Method | Path                  | Purpose                                                                                                                                                                                                 |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/downloads`      | Returns the list of recent downloads, newest first.                                                                                                                                                     |
| POST   | `/api/video/info`     | Body: `{ url }`. Returns `{ title, thumbnail, url }`.                                                                                                                                                   |
| GET    | `/api/video/download` | Query: `?url=...&format=mp3\|original` (`mp3` is the default). Streams a 320 kbps MP3, or YouTube's original audio unconverted (`.opus` / `.m4a` / `.mka`), as a download. `400` for an unknown format. |

All JSON errors follow the shape `{ message: string, field?: string }`.

---

## Environment Variables

| Variable       | Required | Description                                                                  |
| -------------- | -------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL` | Yes      | PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/dbname`). |
| `NODE_ENV`     | No       | `development` (default) or `production`. Controls Vite vs static serving.    |
| `PORT`         | No       | Port to bind (default `5000`).                                               |
| `HOST`         | No       | Interface to listen on (default `127.0.0.1`; use `0.0.0.0` in a container).  |

Put these in a `.env` file in the project root (copy `.env.example`); `server/env.ts` loads it on startup. Variables already set in your shell or hosting platform take priority over the file.

---

## Local Development Setup

### Prerequisites

- **Node.js 20** or newer
- **npm** (bundled with Node)
- **Python 3.10+** on `PATH` (Linux/macOS only — Windows uses the standalone `yt-dlp.exe`) — required by `yt-dlp`, which the download endpoint shells out to. Without it, `/api/video/download` will fail at runtime with `python3: No such file or directory`.
  - macOS: `brew install python@3.11`
  - Debian/Ubuntu: `sudo apt install python3`
  - Fedora/RHEL: `sudo dnf install python3`
  - Verify with `python3 --version` (should be 3.10+).
- A reachable **PostgreSQL** instance — see the next section for how to get one.

### Get a PostgreSQL instance

You have three reasonable options; pick whichever is least friction for you.

**Option 1 — Hosted (fastest, zero install).** Sign up for a free Postgres at [Neon](https://neon.tech/), [Supabase](https://supabase.com/), or [Render](https://render.com/), copy the connection string they give you, and use it as `DATABASE_URL`. No local install, no port conflicts.

**Option 2 — Docker (one command).** If you have Docker installed:

```bash
docker run -d --name yt-mp3-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=youtube_audio \
  -p 5432:5432 \
  postgres:16
```

Then use `DATABASE_URL=postgres://postgres:postgres@localhost:5432/youtube_audio`.

**Option 3 — Local install.**

- macOS: `brew install postgresql@16 && brew services start postgresql@16`
- Debian/Ubuntu: `sudo apt install postgresql && sudo systemctl start postgresql`
- Then: `createdb youtube_audio` and use `DATABASE_URL=postgres://$USER@localhost:5432/youtube_audio`.

### Steps

1. **Clone the repository**

   ```bash
   git clone <your-repo-url>
   cd <project-directory>
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment variables**
   Copy the example file and fill in your real `DATABASE_URL`:

   ```bash
   cp .env.example .env
   # then edit .env in your editor
   ```

   `.env` is git-ignored, so credentials never leave your machine.

4. **Push the database schema**
   This creates the `downloads` table from `shared/schema.ts`:

   ```bash
   npm run db:push
   ```

5. **Start the dev server**
   ```bash
   npm run dev
   ```
   The app is available at `http://localhost:5000`. The frontend hot-reloads via Vite, and changes to server files restart automatically through `tsx`.

---

## Local Development on Windows

The app runs natively on Windows — no WSL or Git Bash needed. The npm scripts are cross-platform (`cross-env`), the server reads `.env` itself, and the Windows build of yt-dlp is a standalone `.exe`, so **Python is not required**.

### Prerequisites — install once

```powershell
winget install -e --id OpenJS.NodeJS.LTS         # Node 20+ and npm
winget install -e --id Docker.DockerDesktop      # OPTIONAL — easiest way to run Postgres locally
```

Close and reopen your terminal so the new programs are on `PATH`, then check `node --version` (v20.x or newer).

> **PowerShell tip:** if `npm` fails with "npm.ps1 cannot be loaded because running scripts is disabled", either type `npm.cmd` instead of `npm`, or allow local scripts once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

### Get a PostgreSQL database

Pick one:

- **Docker Desktop** (start it first):
  ```powershell
  docker run -d --name yt-mp3-db --restart unless-stopped -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=youtube_audio -p 5432:5432 postgres:16
  ```
  Connection string: `postgres://postgres:postgres@localhost:5432/youtube_audio`. The container starts automatically whenever Docker Desktop is running; if it's ever stopped, `docker start yt-mp3-db`.
- **Hosted** (Neon, Supabase, …): copy the connection string they give you.
- **Native install:** `winget install -e --id PostgreSQL.PostgreSQL.16`, then create a `youtube_audio` database.

### Install, configure, run

```powershell
$env:YOUTUBE_DL_SKIP_PYTHON_CHECK = "1"   # see note below
npm install
Copy-Item .env.example .env      # then set DATABASE_URL in .env
npm run db:push                  # creates the downloads table
npm run dev                      # http://localhost:5000
```

`youtube-dl-exec`'s installer refuses to run unless it finds Python 3.9+, even though the Windows `yt-dlp.exe` doesn't use Python. Setting `YOUTUBE_DL_SKIP_PYTHON_CHECK` skips that check; to make it permanent, run `setx YOUTUBE_DL_SKIP_PYTHON_CHECK 1` once and reopen the terminal.

Works the same in PowerShell, `cmd.exe`, Git Bash, or WSL. Variables already set in your shell (e.g. `$env:DATABASE_URL = "..."`) take priority over `.env`.

### Production build on Windows

```powershell
npm run build
npm start                        # serves dist/ on http://localhost:5000
```

### Common Windows gotchas

- **Port 5000 is in use.** Set `PORT=5001` (or any free port) in `.env`. Find what's holding 5000 with `Get-NetTCPConnection -LocalPort 5000`.
- **Reaching it from your phone or another PC.** The server only listens on this computer by default. Set `HOST=0.0.0.0` in `.env` (Windows Firewall will ask to allow Node).
- **Downloads stop working after a while.** YouTube changes things regularly; run `npm rebuild youtube-dl-exec` to fetch the latest yt-dlp (with `YOUTUBE_DL_SKIP_PYTHON_CHECK` set, as above).
- **`npm install` skips dev dependencies** (e.g. `'drizzle-kit' is not recognized`). `NODE_ENV=production` is set in that terminal — clear it (`Remove-Item Env:NODE_ENV`) and reinstall.
- **Long file paths in `node_modules`.** If `npm install` fails with `ENAMETOOLONG`, enable Windows long-path support: `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force` (elevated PowerShell, then reboot).
- **Keep the project path free of spaces** (e.g. `C:\Code\...`, not `C:\My Projects\...`). The yt-dlp wrapper falls back to running through a shell when its path contains spaces, which is more fragile.
- **CRLF vs. LF line endings.** Git on Windows usually checks files out with CRLF; `.prettierrc` uses `"endOfLine": "auto"`, so Prettier accepts either and keeps what's there.

---

## Commands

### Wired-up npm scripts

| Script            | What it does                                                                      |
| ----------------- | --------------------------------------------------------------------------------- |
| `npm run dev`     | Starts the dev server (Express + Vite middleware) via `tsx`, in development mode. |
| `npm run build`   | Runs `script/build.ts` to bundle the client (Vite) and the server (esbuild).      |
| `npm start`       | Runs the production build from `dist/index.cjs` (production mode is baked in).    |
| `npm run check`   | Type-checks the entire project with `tsc`.                                        |
| `npm run db:push` | Syncs your Drizzle schema to the database (no migration files needed).            |

### Tests, linting, and formatting

These tools are installed and configured but have no shortcut script in `package.json` yet — invoke them directly. If you want the short forms (`npm test`, `npm run lint`, etc.) you can add them yourself; suggested entries are listed in the last column.

| Long form                   | What it does                                                       | Suggested script entry                 |
| --------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| `npx vitest run`            | Runs the entire Vitest suite (unit + API) once.                    | `"test": "vitest run"`                 |
| `npx vitest`                | Runs Vitest in watch mode for fast TDD.                            | `"test:watch": "vitest"`               |
| `npx vitest run tests/unit` | Runs only the unit tests (pure helpers, no network, milliseconds). | `"test:unit": "vitest run tests/unit"` |
| `npx vitest run tests/api`  | Runs only the API end-to-end tests (real HTTP, real YouTube).      | `"test:api": "vitest run tests/api"`   |
| `npx playwright test`       | Runs the Playwright browser end-to-end tests.                      | `"test:e2e": "playwright test"`        |
| `npx eslint .`              | Lints the codebase. Currently: 0 errors, 3 minor warnings.         | `"lint": "eslint ."`                   |
| `npx eslint . --fix`        | Auto-fixes any lint issues that ESLint can fix safely.             | `"lint:fix": "eslint . --fix"`         |
| `npx prettier --check .`    | Verifies all source files are formatted (use in CI).               | `"format:check": "prettier --check ."` |
| `npx prettier --write .`    | Reformats all source files to the project Prettier style.          | `"format": "prettier --write ."`       |

---

## Testing

The project ships with two end-to-end test suites that exercise the real app against a real YouTube video — no mocks. They share small helpers that inspect a downloaded file's bytes: `tests/utils/mp3.ts` checks for a real MP3 (an optional ID3v2 tag followed by an MPEG Layer III frame header — a WebM or M4A renamed to `.mp3` fails it), and `tests/utils/original-audio.ts` checks that an original-audio download really is Ogg Opus / MP4 / Matroska as its extension says. Fast, offline unit tests in `tests/unit/` cover URL parsing and the yt-dlp/ffmpeg arguments.

### Layout

```
tests/
├── api/
│   └── video.e2e.test.ts        # Vitest + Supertest, hits Express directly
├── browser/
│   └── download.spec.ts         # Playwright, drives the real UI in Chromium
├── unit/
│   ├── youtube-url.test.ts      # URL parsing + thumbnail picking
│   └── audio.test.ts            # yt-dlp / ffmpeg argument builders
└── utils/
    ├── mp3.ts                    # MP3 validator
    └── original-audio.ts         # .opus / .m4a / .mka validator
```

Configuration files: `vitest.config.ts` and `playwright.config.ts`.

### API end-to-end (Vitest + Supertest)

Boots the real Express app in-process (no Vite, no port binding) and exercises `/api/video/info`, `/api/video/download`, and `/api/downloads` against a stable test video — the very first YouTube upload, "Me at the zoo" (`jNQXAC9IVRw`).

What it checks:

1. An invalid URL returns HTTP 400 with a message.
2. A real YouTube URL returns title + thumbnail metadata.
3. The download endpoint streams `audio/mpeg` content with a `.mp3` `Content-Disposition`, the bytes are written to disk, and the file is verified to be a real MP3 (ID3 tag + MPEG frame), not just an audio file with an `.mp3` name.
4. `?format=original` returns YouTube's audio unconverted, with a matching extension and content type, and the file is what its extension says.
5. An unknown `format` is rejected with `400`.
6. The completed download is recorded in the `downloads` table and surfaces through `/api/downloads`.

Run it:

```bash
DATABASE_URL=... npx vitest run tests/api
```

`DATABASE_URL` is required because the test exercises the storage layer end-to-end. It's read from `.env`, the same as the app.

### Browser end-to-end (Playwright)

Drives Chromium against the live app (using the `webServer` block in `playwright.config.ts`, which reuses your dev server if it's already running on port 5000, or starts `npm run dev` itself otherwise).

What it checks:

1. The hero loads, the URL input accepts the test video URL, and clicking **Extract** renders a preview card with the title, thumbnail, and a download link.
2. Clicking **Download Audio** triggers a browser download whose suggested filename ends in `.mp3` and whose saved bytes pass the MP3-header check.
3. Turning on **Original audio** switches the link to `format=original`, and the download is a valid `.opus` (or `.m4a`/`.mka`) file.
4. Submitting an invalid URL surfaces a friendly error (toast or inline) instead of crashing.

One-time browser install (already done if you've run the suite before):

```bash
npx playwright install chromium
```

Run it:

```bash
npx playwright test
```

Open the HTML report after a run:

```bash
npx playwright show-report
```

### Known flakiness — YouTube anti-scraping

Both suites depend on `yt-dlp` (invoked via the `youtube-dl-exec` wrapper) being able to talk to YouTube's API. YouTube actively changes its internals — signed/encrypted stream URLs, PoToken (proof-of-origin token) requirements, format reshuffling — so any extractor can break between releases. yt-dlp is the most aggressively maintained option in this space, but you should still expect periodic breakage.

- The negative tests (invalid URLs → 400) keep passing regardless — they prove the wiring still works.
- The metadata test (`/api/video/info`) and the download test (`/api/video/download`) both depend on yt-dlp successfully reaching YouTube. If they start failing, first reinstall to get the latest bundled binary:

  ```bash
  # via the package manager — do not edit package.json directly
  # this re-runs youtube-dl-exec's postinstall, which downloads the
  # current yt-dlp release from GitHub
  npm rebuild youtube-dl-exec
  ```

- On Linux/macOS, yt-dlp is a Python script: the host (or container) must have `python3` (3.10+) on `$PATH`. Make sure your image installs it. On Windows, yt-dlp is a standalone `.exe` and needs no Python.
- yt-dlp needs a JavaScript runtime for YouTube. The server passes `--js-runtimes node`, so it uses the same Node that runs the app (Node 20+).

### Test-only dependencies

The following packages were added solely to support the test suites: `vitest`, `supertest`, `@types/supertest`, `@playwright/test`. They are not loaded by the production build.

---

## Production Build & Deployment

### Build artifacts

Running `npm run build` produces:

- A client bundle (HTML/JS/CSS) inside `dist/public/`.
- A single bundled server file at `dist/index.cjs`.

### Running in production

```bash
NODE_ENV=production DATABASE_URL=... PORT=5000 npm start
```

The Express server serves the static client from `dist/public` and the API from the same port.

### Deploying

The app is a standard Node.js + PostgreSQL service and runs on any provider that supports long-running Node processes (Railway, Render, Fly.io, a VPS, Docker, etc.).

A typical flow:

1. Provision a PostgreSQL database and copy the connection string.
2. Set environment variables on the host: `DATABASE_URL`, `NODE_ENV=production`, and `PORT` (if the platform requires a specific port).
3. Build the project: `npm ci && npm run build`.
4. Run schema migrations: `npm run db:push`.
5. Start the server: `npm start`.
6. Point your domain / load balancer at the host's exposed port.

> Serverless platforms (e.g. Vercel, Netlify Functions) are **not recommended** because the audio download endpoint streams long-lived responses, which conflicts with most serverless function time limits.

---

## Security Notes

- Dependencies were audited and updated: `rollup` was upgraded to a patched version (≥ 4.59.0) to fix a high-severity Path Traversal advisory (GHSA-mw96-cpmx-2vgc), and `tsx` was reinstalled after the audit reset `node_modules`.
- To re-run the audit at any time: `npm audit`.
- The download endpoint accepts only validated YouTube URLs (`ytdl.validateURL`) and sanitises the filename before sending it back in `Content-Disposition`.
- All request bodies on JSON endpoints are validated through Zod schemas before reaching the storage layer.
- `DATABASE_URL` and any other secrets must never be committed to source control. Use the host's environment-variable manager.

---

## Troubleshooting

| Symptom                                         | Likely cause / fix                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tsx: not found` when running `npm run dev`     | `node_modules` is incomplete. Run `npm install` again.                                            |
| `DATABASE_URL must be set...` thrown on startup | Set `DATABASE_URL` in `.env` (or your shell) and make sure Postgres is running.                   |
| `Invalid YouTube URL` on the info endpoint      | The submitted URL did not pass `ytdl.validateURL`. Try a standard `youtube.com/watch?v=...` link. |
| Download starts but the file is empty / 0 bytes | The video may be age-restricted, region-locked, or removed. Try a different URL.                  |
| Port `5000` already in use                      | Set `PORT=<other-port>` in the environment, then restart.                                         |
| Schema changes don't appear in the database     | Run `npm run db:push` to sync the latest Drizzle schema.                                          |

---

## Further Reading

- User-facing overview: [README.md](./README.md)
- Drizzle ORM docs: <https://orm.drizzle.team/>
- TanStack Query docs: <https://tanstack.com/query/latest>
- Wouter docs: <https://github.com/molefrog/wouter>
- shadcn/ui: <https://ui.shadcn.com/>
