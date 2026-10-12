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
