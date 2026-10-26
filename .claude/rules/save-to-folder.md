---
paths:
  - "server/{save,folders,settings,local-only,library,playlist-file,retry-when-busy}.ts"
  - "server/routes/folders.ts"
  - "client/src/lib/save-to-folder.ts"
  - "client/src/hooks/{use-save-settings,use-songs-in-folder}.ts"
  - "client/src/components/{folder-picker,save-to-setting,preview-card}.tsx"
  - "client/src/pages/Home.tsx"
  - "tests/unit/{save-to-folder,folders,settings,local-only,library,playlist-file}.test.ts"
---

# Save to folder

- Download links stay real `<a href download>` elements — `startDownload()` only calls
  `preventDefault()` (and `POST /api/video/save` instead) when a folder is set — so the default path
  and its tests are unchanged.
- A save's lifetime is its connection: aborting the fetch (Cancel, closing the tab) kills the
  pipeline and deletes the `.part` file, so re-test cancel paths after edits here too.
- `music-metadata` is ESM-only and describes `parseFile` only under the "node" exports condition,
  which TypeScript's `bundler` resolution ignores: `library.ts` loads it with `import()` and types it
  by hand.
