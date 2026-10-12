---
paths:
  - "client/**"
  - "tests/browser/**"
  - "tests/unit/browser-support.test.ts"
  - "playwright.config.ts"
---

# Browsers and the Playwright tests

- Every feature must work in current Chrome, Edge, Firefox and Safari (oldest: Chrome/Edge 111,
  Firefox 128, Safari 16.4 — Vite 8's build target and Tailwind CSS 4's minimum). No browser-only
  APIs, and no `for await` over streams — `tests/unit/browser-support.test.ts` checks.
- Playwright runs every test in Chrome and WebKit, and in Firefox only via `E2E_BROWSERS`: on this
  Windows 10 PC Playwright's Firefox and Chromium builds fail to start (side-by-side configuration
  error), which is also why Chrome is the installed one (`channel: "chrome"`). The installed Firefox
  works over BiDi (`channel: "moz-firefox"`), but BiDi's `fill()` doesn't reach React inputs — type
  with `pressSequentially()` there.
- Playwright's WebKit on Windows draws in software and waits for 5 still frames before each click
  (1 elsewhere), so keep the page still when nothing's happening: a never-ending animation (the
  hero's dot used to pulse) repaints it every frame, and with a `blur(120px)` background glow (now a
  gradient, `.ambient-glow`) each repaint took ~1 s — clicks took ~10 s and long tests timed out. No
  endless decorative animations or big `blur()` areas.
- Slow frames delay network answers too, so a late answer must never undo what the user did
  meanwhile.
