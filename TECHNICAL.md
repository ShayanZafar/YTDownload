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
- **youtube-dl-exec** wrapping a bundled **yt-dlp** binary for YouTube video info & audio stream extraction (yt-dlp itself requires Python 3 to be installed on the host)
- **Zod** for request validation

### Database

- **PostgreSQL** (any standard provider, e.g. Neon, Replit DB, Supabase, RDS)
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
│   ├── routes.ts              # API route handlers
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
└── package.json
```

---

## Architecture Overview

### Single-port serving

The Express server and the Vite dev server are mounted on a single port (default `5000`). In development, Vite middleware is attached to Express via `server/vite.ts`, so the API and the frontend live on the same origin — no CORS or proxy configuration required. In production, the built client assets are served as static files by `server/static.ts`.

### Data flow

1. The frontend calls `POST /api/video/info` with a YouTube URL.
2. The backend validates the body with Zod, extracts the canonical video ID (`server/youtube-url.ts`), shells out to `yt-dlp` for metadata, and returns `{ title, thumbnail, url }`.
3. When the user clicks **Download Audio**, the browser navigates to `GET /api/video/download?url=...`. The server does a metadata pass (for the filename), inserts a `downloads` row, then spawns a `yt-dlp` subprocess with `format: "bestaudio"` and pipes its stdout straight into the HTTP response with `Content-Type: audio/mpeg` and a `Content-Disposition` header.
4. The frontend re-fetches `/api/downloads` to refresh the recent-extractions list.

The visual versions of these flows live in [System Design](#system-design) below.

### Storage abstraction

All database access goes through the `IStorage` interface in `server/storage.ts`. Routes never touch the database directly — they call `storage.getDownloads()` or `storage.createDownload(...)`. This makes it easy to swap implementations or add caching later.

### Shared types & routes

`shared/schema.ts` defines the Drizzle table, the `createInsertSchema` Zod validator, and `Download` / `InsertDownload` TypeScript types. Both the client and the server import from `@shared/schema`, guaranteeing the API contract stays in sync.

---

## System Design

This section is the visual companion to the prose above. All diagrams use [Mermaid](https://mermaid.js.org/), which renders natively on GitHub, Replit's markdown preview, and most editors with a Markdown plugin.

### Component diagram

The whole system is one Node process plus one Postgres database plus one external dependency (`yt-dlp`, invoked as a subprocess that calls out to YouTube).

```mermaid
flowchart LR
  Browser["Browser<br/>(React + Vite client)"]
  Node["Node.js process<br/>(Express + Vite middleware)"]
  YtDlp["yt-dlp subprocess<br/>(spawned per request)"]
  YouTube["YouTube<br/>(public API + CDN)"]
  DB[("PostgreSQL<br/>downloads table")]

  Browser -- "HTTPS<br/>/api/* + static assets" --> Node
  Node -- "spawn (stdin/stdout pipe)" --> YtDlp
  YtDlp -- "HTTPS" --> YouTube
  Node -- "SQL over TLS" --> DB
```

Key things this picture makes obvious:

- **One port, one process.** The client, the API, and (in dev) the Vite dev server all share port 5000. There is no separate API gateway, no reverse proxy in the default setup.
- **`yt-dlp` is a subprocess, not a library.** Every metadata fetch and every download spawns a fresh `yt-dlp` process. That's the unit of failure for anything YouTube-related.
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

The streaming path. The interesting part is that the server starts writing bytes to the HTTP response **before** the subprocess has finished — so once headers are sent we can no longer respond with a clean error code.

```mermaid
sequenceDiagram
  autonumber
  participant C as Browser
  participant S as Express handler
  participant DB as PostgreSQL
  participant Y as yt-dlp subprocess
  participant YT as YouTube

  C->>S: GET /api/video/download?url=...
  S->>S: extractVideoId(url) → validate
  S->>Y: metadata pass (dumpSingleJson)
  Y->>YT: HTTPS
  YT-->>Y: JSON
  Y-->>S: { title }
  S->>DB: INSERT INTO downloads (url, title)
  Note over S,DB: DB error here is logged but swallowed —<br/>download still proceeds
  DB-->>S: ok / error
  S-->>C: 200 + Content-Disposition + Content-Type: audio/mpeg
  S->>Y: spawn yt-dlp (format=bestaudio, output=-)
  Y->>YT: HTTPS audio stream
  loop streaming
    YT-->>Y: audio bytes
    Y-->>S: stdout chunk
    S-->>C: response chunk
  end
  alt client aborts
    C->>S: req "close" event
    S->>Y: SIGTERM
  else yt-dlp exits non-zero
    Y-->>S: stderr + exit code
    S->>S: log stderr, end response
  end
```

### Deployment topology

In Replit Autoscale (the production target), the picture collapses to one container with a few outbound dependencies.

```mermaid
flowchart LR
  subgraph Replit["Replit Autoscale Container"]
    Node2["Node.js (dist/index.cjs)<br/>+ bundled yt-dlp binary<br/>+ Python 3 runtime"]
  end
  Internet["Internet users"] -- HTTPS --> Node2
  Node2 -- HTTPS --> YouTubeProd["YouTube"]
  Node2 -- "SQL over TLS<br/>(DATABASE_URL secret)" --> Neon[("Hosted Postgres<br/>e.g. Neon / Supabase")]
```

Notes on this topology:

- The container is **stateless** — every restart is clean. All persistent data is in Postgres.
- `yt-dlp` is bundled into `node_modules/youtube-dl-exec/bin/` at build time, so we don't need to install it at runtime. We **do** need Python 3 in the container (the Replit deployment uses the project's Nix module set).
- There's no object storage. Audio files are streamed straight from `yt-dlp` to the client and never touch disk on the server.

### Failure modes

The interesting failures are at the boundaries with `yt-dlp`, YouTube, and Postgres. The table below is the truth as of the code in `server/routes.ts`:

| Failure                              | Where surfaced                  | Behavior                                                                                                          | User sees                                                  |
| ------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Invalid / non-YouTube URL            | `extractVideoId` returns `null` | Short-circuit, no subprocess spawned                                                                              | `400 Invalid YouTube URL`                                  |
| Zod body validation fails (info)     | `api.video.info.input.parse`    | Caught in handler, returns `field` + `message`                                                                    | `400 { message, field }`                                   |
| `yt-dlp` metadata throws             | `youtubedl(...)` rejection      | Caught in handler                                                                                                 | `500 { message }` (info) or `500` text (download)          |
| DB insert into `downloads` fails     | `storage.createDownload(...)`   | **Swallowed** — logged via `console.error`, download proceeds                                                     | Nothing — file still downloads, history just won't show it |
| `yt-dlp` subprocess fails to spawn   | `subprocess.stdout` is `null`   | Throws → caught in handler                                                                                        | `500 Failed to spawn yt-dlp subprocess`                    |
| `yt-dlp` exits non-zero mid-stream   | `subprocess.on("close")`        | stderr logged, response ended; if headers already sent, browser sees a truncated download                         | Partial / broken file                                      |
| Client cancels the download          | `req.on("close")`               | Subprocess killed with `SIGTERM`                                                                                  | n/a (user already left)                                    |
| Postgres unreachable on `/downloads` | `storage.getDownloads()` throws | Caught in handler                                                                                                 | `500 Failed to fetch downloads`, history list shows error  |
| YouTube blocks the request           | `yt-dlp` exits non-zero         | Same as the "exits non-zero" row — that's why we keep `yt-dlp` itself up to date, not roll our own scraping logic | Partial / broken file                                      |

The deliberate design choice worth flagging: **a database outage doesn't break downloads**. The download history is best-effort, the audio extraction is the product. We chose this over the alternative (fail the download if we can't log it), because the user's download is what they came for.

### Scaling considerations

This stack is designed for a small-to-medium audience. Here's where it would crack and what we'd do about it:

| Bottleneck                     | When it bites                                                                                             | First thing to do                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Single Node process            | Sustained concurrent downloads, since each one occupies an event-loop slot for the duration of the stream | Run multiple Node instances behind a load balancer (Replit Autoscale already scales horizontally on request count). |
| `yt-dlp` subprocess fan-out    | Lots of simultaneous downloads → many Python processes → CPU + memory pressure                            | Add a per-instance concurrency cap (e.g., a small `p-limit` queue around `youtubedl.exec`).                         |
| Outbound bandwidth from server | Every byte of audio flows server → client                                                                 | Move to a presigned-URL or proxy-and-cache model, where popular videos hit a CDN instead of `yt-dlp` per request.   |
| Postgres connection pool       | Many concurrent requests sharing one pool                                                                 | Tune the pool size in `server/db.ts`; for serverless Postgres (Neon), the HTTP driver handles this automatically.   |
| `yt-dlp` extractor rot         | YouTube periodically changes its players and `yt-dlp` ships a fix                                         | Bump the `youtube-dl-exec` dependency on a cadence (or pin a specific `yt-dlp` binary release).                     |
| No background job queue        | If a future feature needs work to outlive the request (e.g., transcoding to real MP3)                     | Introduce a queue (BullMQ + Redis is the conventional pick) and a worker process.                                   |
| No caching of metadata         | Same URL fetched repeatedly costs a `yt-dlp` spawn each time                                              | Add a short TTL cache (in-memory `lru-cache` or Redis) keyed by canonical video ID.                                 |

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

| Method | Path                  | Purpose                                                           |
| ------ | --------------------- | ----------------------------------------------------------------- |
| GET    | `/api/downloads`      | Returns the list of recent downloads, newest first.               |
| POST   | `/api/video/info`     | Body: `{ url }`. Returns `{ title, thumbnail, url }`.             |
| GET    | `/api/video/download` | Query: `?url=...`. Streams the extracted MP3 audio as a download. |

All JSON errors follow the shape `{ message: string, field?: string }`.

---

## Environment Variables

| Variable       | Required | Description                                                                  |
| -------------- | -------- | ---------------------------------------------------------------------------- |
| `DATABASE_URL` | Yes      | PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/dbname`). |
| `NODE_ENV`     | No       | `development` (default) or `production`. Controls Vite vs static serving.    |
| `PORT`         | No       | Port to bind (default `5000`).                                               |

In Replit, `DATABASE_URL` is provisioned automatically when a database is added to the project. For other environments, set it in your shell or hosting platform's environment-variable UI.

---

## Local Development Setup

### Prerequisites

- **Node.js 20** or newer
- **npm** (bundled with Node)
- **Python 3** on `PATH` — required by `yt-dlp`, which the download endpoint shells out to. Without it, `/api/video/download` will fail at runtime with `python3: No such file or directory`.
  - macOS: pre-installed, or `brew install python@3.11`
  - Debian/Ubuntu: `sudo apt install python3`
  - Fedora/RHEL: `sudo dnf install python3`
  - Verify with `python3 --version` (should be 3.8+).
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

The steps above assume a Unix-like shell (macOS / Linux / WSL / Git Bash). Native Windows shells (PowerShell, `cmd.exe`) need a few different commands. Pick **one** of the three paths below.

### Prerequisites — install once

Run these in an **elevated PowerShell** (right-click → "Run as Administrator"):

```powershell
winget install -e --id OpenJS.NodeJS.LTS         # Node 20+ and npm
winget install -e --id Python.Python.3.11        # Python 3 (required by yt-dlp)
winget install -e --id Git.Git                   # Git
winget install -e --id PostgreSQL.PostgreSQL.16  # OPTIONAL — skip if using a hosted DB
```

Close and reopen PowerShell so the new programs are on `PATH`. Verify:

```powershell
node --version      # v20.x or newer
npm --version       # 10.x or newer
python --version    # 3.11.x
git --version
```

If `python --version` doesn't work, the yt-dlp download endpoint will fail at runtime with `python3: No such file or directory` — fix `PATH` before continuing.

### Get a PostgreSQL connection string

Either install PostgreSQL locally (above) and use a URL like
`postgres://postgres:<password>@localhost:5432/youtube_audio`, or use a free hosted Postgres (Neon, Supabase, etc.) and copy the connection string they give you. The latter is faster.

### Clone and install

```powershell
git clone <your-repo-url>
cd <project-directory>
npm install
```

### Pick one of three ways to run

#### Path A — WSL (Ubuntu) **— recommended, simplest**

If you have WSL installed (`wsl --install` in elevated PowerShell, then reboot), open an Ubuntu terminal and follow the regular Linux/macOS steps above verbatim. Everything works as documented because you're now in a real Unix shell.

#### Path B — Git Bash

Install [Git for Windows](https://git-scm.com/download/win) (or `winget install -e --id Git.Git` from above), then open the **Git Bash** shell. The standard Linux/macOS commands work here too, including `export DATABASE_URL=...` and `npm run dev`.

#### Path C — Native PowerShell

Works, but requires using PowerShell's environment-variable syntax and bypassing the npm `dev`/`start` scripts (which use a Unix-style `NODE_ENV=development tsx ...` prefix that PowerShell and `cmd.exe` don't understand).

```powershell
# Set the database URL for this shell session
$env:DATABASE_URL = "postgres://postgres:<password>@localhost:5432/youtube_audio"

# Push the schema (this script is portable — no NODE_ENV prefix)
npm run db:push

# Start the dev server (replicate `npm run dev` manually)
$env:NODE_ENV = "development"
npx tsx server/index.ts
```

To make the database URL persist across shells, use `setx` once:

```powershell
setx DATABASE_URL "postgres://postgres:<password>@localhost:5432/youtube_audio"
```

(Then close and reopen PowerShell — `setx` only takes effect in new sessions.)

### Verify the production build on Windows

To confirm the production pipeline works end-to-end on your Windows box (after `npm install` and `DATABASE_URL` are set):

```powershell
npm run build                          # bundles client (Vite) + server (esbuild) → dist/
$env:NODE_ENV = "production"
node dist/index.cjs                    # equivalent to `npm start` on Unix
```

If you see `Server listening on port 5000` and `http://localhost:5000` loads the homepage, the build pipeline is working on Windows.

### Common Windows gotchas

- **Port 5000 is in use.** Windows sometimes binds port 5000 (older versions, third-party services). Identify the process with `Get-NetTCPConnection -LocalPort 5000` and stop it, or change the port in `server/index.ts`.
- **`'NODE_ENV' is not recognized as an internal or external command.`** You're in `cmd.exe` and ran `npm run dev`. Use Path A, B, or C above.
- **`python3: No such file or directory` from yt-dlp.** Python isn't on `PATH`. Reinstall with the "Add Python to PATH" option, or fix `PATH` manually.
- **Long file paths in `node_modules`.** If `npm install` fails with `ENAMETOOLONG`, enable Windows long-path support: `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force` (elevated PowerShell, then reboot).
- **CRLF vs. LF line endings.** This repo's `.prettierrc` enforces `lf`. Configure Git once per machine: `git config --global core.autocrlf input`.

---

## Commands

### Wired-up npm scripts

| Script            | What it does                                                                 |
| ----------------- | ---------------------------------------------------------------------------- |
| `npm run dev`     | Starts the dev server (Express + Vite middleware) via `tsx`.                 |
| `npm run build`   | Runs `script/build.ts` to bundle the client (Vite) and the server (esbuild). |
| `npm start`       | Runs the production build from `dist/index.cjs` with `NODE_ENV=production`.  |
| `npm run check`   | Type-checks the entire project with `tsc`.                                   |
| `npm run db:push` | Syncs your Drizzle schema to the database (no migration files needed).       |

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

The project ships with two end-to-end test suites that exercise the real app against a real YouTube video — no mocks. They share a small helper (`tests/utils/mp3.ts`) that verifies a downloaded file is a real MP3 by inspecting its header bytes (ID3v2 tag or MPEG sync word).

### Layout

```
tests/
├── api/
│   └── video.e2e.test.ts        # Vitest + Supertest, hits Express directly
├── browser/
│   └── download.spec.ts         # Playwright, drives the real UI in Chromium
└── utils/
    └── mp3.ts                    # Shared MP3-header validator
```

Configuration files: `vitest.config.ts` and `playwright.config.ts`.

### API end-to-end (Vitest + Supertest)

Boots the real Express app in-process (no Vite, no port binding) and exercises `/api/video/info`, `/api/video/download`, and `/api/downloads` against a stable test video — the very first YouTube upload, "Me at the zoo" (`jNQXAC9IVRw`).

What it checks:

1. An invalid URL returns HTTP 400 with a message.
2. A real YouTube URL returns title + thumbnail metadata.
3. The download endpoint streams `audio/mpeg` content with a `.mp3` `Content-Disposition`, the bytes are written to disk, and the file's header is verified as a valid MP3.
4. The completed download is recorded in the `downloads` table and surfaces through `/api/downloads`.

Run it:

```bash
DATABASE_URL=... npx vitest run tests/api
```

`DATABASE_URL` is required because the test exercises the storage layer end-to-end. In Replit this is already exported.

### Browser end-to-end (Playwright)

Drives Chromium against the live app (using the `webServer` block in `playwright.config.ts`, which reuses your dev server if it's already running on port 5000, or starts `npm run dev` itself otherwise).

What it checks:

1. The hero loads, the URL input accepts the test video URL, and clicking **Extract** renders a preview card with the title, thumbnail, and a download link.
2. Clicking **Download Audio** triggers a browser download whose suggested filename ends in `.mp3` and whose saved bytes pass the MP3-header check.
3. Submitting an invalid URL surfaces a friendly error (toast or inline) instead of crashing.

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

- yt-dlp is a Python 3 script. The host (or container) must have `python3` available on `$PATH`. In the Replit environment Python 3.11 is provisioned as a module; in your own deployment make sure your image installs it.

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

### Deploying on Replit (recommended)

1. Open the project in Replit.
2. Confirm a PostgreSQL database is attached so `DATABASE_URL` is set.
3. From the Replit interface, click **Deploy** (or **Publish**). Replit handles building, hosting, TLS certificates, health checks, and a public `.replit.app` domain automatically.
4. After publishing, every subsequent push or change can be redeployed from the same panel.

### Deploying on other platforms

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
| `DATABASE_URL must be set...` thrown on startup | Export `DATABASE_URL` or attach a database in Replit before starting.                             |
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
