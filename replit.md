# YouTube → MP3 audio extractor

A small full-stack app that takes a YouTube URL, fetches the audio track, and serves it back as a downloadable file.

## Stack
- **Frontend:** React + Vite, wouter, TanStack Query, shadcn/ui, Tailwind
- **Backend:** Node.js + Express 5, TypeScript (tsx in dev, esbuild in prod)
- **Database:** PostgreSQL via Drizzle ORM (download history)
- **YouTube extraction:** `youtube-dl-exec` wrapping a bundled `yt-dlp` binary. yt-dlp is a Python script — Python 3.11 is installed as a Replit module.

## Layout
- `client/` — Vite React app
- `server/` — Express API
  - `server/routes.ts` — `/api/video/info`, `/api/video/download`, `/api/downloads`
  - `server/storage.ts` — `IStorage` interface over Drizzle
- `shared/` — schema + API contracts shared between client and server
- `tests/api/` — Vitest + Supertest end-to-end tests
- `tests/browser/` — Playwright browser tests
- `README.md` — user-facing docs
- `TECHNICAL.md` — deploy / architecture / test docs

## Run
- `npm run dev` (workflow `Start application`) — starts Vite + Express on port 5000
- `npx vitest run tests/api` — API e2e tests (4 tests, all passing)
- `npx playwright test` — browser tests

## Environment
- `DATABASE_URL` — Postgres connection string (required)

## Forbidden
- Do **not** edit `package.json` directly. Use the package management tools.
- Do **not** modify `vite.config.ts` or `server/vite.ts` unless absolutely necessary.

## Notes for future agents
- YouTube anti-scraping changes regularly. If extraction breaks, run `npm rebuild youtube-dl-exec` to pull a fresh yt-dlp binary before assuming it's a code bug.
- 5 npm-audit findings remain (path-to-regexp, picomatch, yaml). All are transitives that can only be cleared by their parent libraries publishing fixes.
