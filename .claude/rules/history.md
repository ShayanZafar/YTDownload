---
paths:
  - "server/storage.ts"
  - "server/routes.ts"
  - "server/local-only.ts"
  - "client/src/components/{recent-extractions,history-search}.tsx"
  - "client/src/hooks/use-history-actions.tsx"
  - "client/src/hooks/use-history-in-folder.ts"
  - "client/src/hooks/use-youtube.ts"
  - "client/src/lib/history-filter.ts"
  - "tests/unit/{storage,history-filter}.test.ts"
  - "tests/api/history.e2e.test.ts"
  - "tests/browser/history.spec.ts"
---

# The download history (Recent Extractions)

- History changes (`DELETE /api/downloads[/:id]`, `POST /api/downloads/restore`) are allowed from
  any device using the app, from its own page only (`sameOriginOnly()` in `local-only.ts`): the
  history is shared like the downloads. Removing never touches files. Restore re-ids an entry whose
  id was reused meanwhile (ids are max+1, so they restart after Clear).
- The history search has no API: the page filters what `/api/downloads` returns. Keep that endpoint
  cheap (it's polled while a download runs) — the request log truncates JSON bodies to 200 chars.
- An entry is added only once a download fully succeeds: see `.claude/rules/downloads.md`. It keeps
  the file name it was saved under (`fileName`), which finds it in the folder later.
- Which downloads are in the Save to folder is its own route (`GET /api/downloads/in-folder`,
  behind `localOnly()`, reading only the chosen folder), never part of `/api/downloads`.
