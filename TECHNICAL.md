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
- **@distube/ytdl-core** for YouTube video info & audio stream extraction
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
1. The frontend calls `/api/video/info` with a YouTube URL.
2. The backend validates the URL with `ytdl.validateURL`, fetches metadata via `ytdl.getInfo`, and returns `{ title, thumbnail, url }`.
3. When the user clicks **Download Audio**, the browser navigates to `/api/video/download?url=...`. The server streams the audio (`filter: 'audioonly'`, `quality: 'highestaudio'`) directly to the response with `Content-Type: audio/mpeg` and a `Content-Disposition` header.
4. Each successful download is logged to PostgreSQL via the `DatabaseStorage` class.
5. The frontend re-fetches `/api/downloads` to refresh the recent-extractions list.

### Storage abstraction
All database access goes through the `IStorage` interface in `server/storage.ts`. Routes never touch the database directly — they call `storage.getDownloads()` or `storage.createDownload(...)`. This makes it easy to swap implementations or add caching later.

### Shared types & routes
`shared/schema.ts` defines the Drizzle table, the `createInsertSchema` Zod validator, and `Download` / `InsertDownload` TypeScript types. Both the client and the server import from `@shared/schema`, guaranteeing the API contract stays in sync.

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

| Method | Path                  | Purpose                                                          |
| ------ | --------------------- | ---------------------------------------------------------------- |
| GET    | `/api/downloads`      | Returns the list of recent downloads, newest first.              |
| POST   | `/api/video/info`     | Body: `{ url }`. Returns `{ title, thumbnail, url }`.            |
| GET    | `/api/video/download` | Query: `?url=...`. Streams the extracted MP3 audio as a download. |

All JSON errors follow the shape `{ message: string, field?: string }`.

---

## Environment Variables

| Variable        | Required | Description                                                                   |
| --------------- | -------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`  | Yes      | PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/dbname`).  |
| `NODE_ENV`      | No       | `development` (default) or `production`. Controls Vite vs static serving.     |
| `PORT`          | No       | Port to bind (default `5000`).                                                |

In Replit, `DATABASE_URL` is provisioned automatically when a database is added to the project. For other environments, set it in your shell or hosting platform's environment-variable UI.

---

## Local Development Setup

### Prerequisites
- **Node.js 20** or newer
- **npm** (bundled with Node)
- A reachable **PostgreSQL** instance

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
   Create a `.env` file (or export the variables in your shell):
   ```bash
   DATABASE_URL=postgres://user:password@localhost:5432/youtube_audio
   ```

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

## Available npm Scripts

| Script           | What it does                                                                 |
| ---------------- | ---------------------------------------------------------------------------- |
| `npm run dev`    | Starts the dev server (Express + Vite middleware) via `tsx`.                 |
| `npm run build`  | Runs `script/build.ts` to bundle the client (Vite) and the server (esbuild). |
| `npm start`      | Runs the production build from `dist/index.cjs` with `NODE_ENV=production`.  |
| `npm run check`  | Type-checks the entire project with `tsc`.                                   |
| `npm run db:push`| Syncs your Drizzle schema to the database (no migration files needed).       |

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

### Known flakiness — YouTube + ytdl-core

Both suites depend on `@distube/ytdl-core` being able to talk to YouTube's API. YouTube periodically changes its internals, which can cause ytdl-core to return errors like `Failed to find any playable formats` until a new version of the library is released. When that happens:

- The negative tests (invalid URLs, 400 errors) keep passing — they prove the wiring still works.
- The fetch / download tests fail with HTTP 500.

If you see this, first check `npm outdated @distube/ytdl-core` for an upstream fix before treating it as a regression in this project.

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

| Symptom                                                  | Likely cause / fix                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tsx: not found` when running `npm run dev`              | `node_modules` is incomplete. Run `npm install` again.                                                   |
| `DATABASE_URL must be set...` thrown on startup          | Export `DATABASE_URL` or attach a database in Replit before starting.                                    |
| `Invalid YouTube URL` on the info endpoint               | The submitted URL did not pass `ytdl.validateURL`. Try a standard `youtube.com/watch?v=...` link.        |
| Download starts but the file is empty / 0 bytes          | The video may be age-restricted, region-locked, or removed. Try a different URL.                         |
| Port `5000` already in use                               | Set `PORT=<other-port>` in the environment, then restart.                                                |
| Schema changes don't appear in the database              | Run `npm run db:push` to sync the latest Drizzle schema.                                                 |

---

## Further Reading

- User-facing overview: [README.md](./README.md)
- Drizzle ORM docs: <https://orm.drizzle.team/>
- TanStack Query docs: <https://tanstack.com/query/latest>
- Wouter docs: <https://github.com/molefrog/wouter>
- shadcn/ui: <https://ui.shadcn.com/>
