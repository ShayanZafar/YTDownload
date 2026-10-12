---
paths:
  - "vite.config.ts"
  - "server/{vite,index,static,host-check,env}.ts"
  - "tests/unit/{dev-server,host-check}.test.ts"
---

# The server's startup and the dev server (Vite inside Express)

- No `reusePort` in `listen()`: it fails with ENOTSUP on Windows.
- Don't make Vite errors exit the process (the old Replit template did) — a refused request or a
  half-saved file would kill the dev server.
- The dev server sends files by their path (`/@fs/<path>`) to any device that can reach it, so
  `vite.config.ts`'s `server.fs` allows only `client/`, `shared/` and `node_modules/` (Vite's
  pre-bundled packages are in `node_modules/.vite`) and denies dotfiles — never `data/`. Its deny
  list replaces Vite's defaults, so it repeats them. `server/vite.ts` spreads `viteConfig.server`
  into its own options: never replace it. A new folder the page loads files from goes in `allow`
  (`tests/unit/dev-server.test.ts` checks).
