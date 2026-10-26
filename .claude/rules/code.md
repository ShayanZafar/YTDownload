---
paths:
  - "**/*.{ts,tsx}"
  - "client/src/index.css"
  - "components.json"
---

# Code: TypeScript, Zod 4, Tailwind CSS 4

- Regexes with the `u` flag (`\p{L}`) must be built with `new RegExp(...)`: tsc refuses the literal
  at this project's default ES5 target.
- Zod 4: messages go in an `error` option, errors are `.issues`, `z.record()` takes a key schema.
- Tailwind CSS 4: no `tailwind.config.ts` — the theme is `@theme` in `client/src/index.css`, which
  scans `client/` only (`source('..')`); custom classes are `@utility`; animations come from
  `tw-animate-css`; the plugin is `@tailwindcss/vite` (no PostCSS config).

## Shared helpers: use these, don't write another

- A `data/*.json` store: `writeJsonFile()` and `oneAtATime()` (`server/json-file.ts`).
- One ffmpeg run: `ffmpeg()`, `ffmpegFailure()`, `runFfmpeg()` (`server/ffmpeg.ts`); the download
  pipeline stays in `audio.ts`.
- Changing a song's file: `whileBusy()` around it, then `writeOver()`, `swapIn()` or
  `binAndSwapIn()` (`server/song-file.ts`).
- A new route goes in its area's `server/routes/<area>.ts`, with `songFor()`, `sendFolderError()`
  and `validationError()` from `server/routes/helpers.ts`; `tests/unit/routes-registered.test.ts`
  checks every contract route is served once.
- Many songs at once, in the page: `eachAtOnce()` (`client/src/lib/at-once.ts`) with
  `useBatchRun()` for Stop (`client/src/hooks/use-batch-run.ts`); on the server, `mapAtOnce()`
  (`server/cpu-cores.ts`).
- Comparing names: `foldWords()` / `foldSquashed()` (`shared/fold-text.ts`), never a new
  lower-case-and-strip-accents.
