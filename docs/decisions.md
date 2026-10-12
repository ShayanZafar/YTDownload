# Decisions

Choices the owner made, or that took their default after 7 days without an answer, newest first, one line each: the date, the decision, why, and its issue. Decisions still waiting are GitHub issues labelled `decision`; debt is labelled `debt` (the `backlog` skill says how to file and close both). A decision that is a standing rule also goes into the `.claude/rules/` file for its area, or into CLAUDE.md if it holds everywhere. Never ask again about something recorded here.

Decisions made before Oct 12, 2026 are recorded inline, with their dates, in CLAUDE.md and `.claude/rules/`.

<!-- Format: - YYYY-MM-DD — <decision>. Why: <reason>. (#n) -->

- 2026-10-12 — A source that has refused the app (an HTTP 429 with `Retry-After`) for more than another hour counts as unreliable, however few the attempts. Why: while refused, the app asks it about once per refusal, so a 15-hour refusal from the Spotify Web API never reached the 5 attempts `unreliable` needs, and the session-start hook never prompted the search for another source. (spec `docs/specs/spotify-playlist-past-100.md`, question 2)
- 2026-10-12 — When the rest of a Spotify playlist fails with no `Retry-After` to go by (a 5xx, no connection, a 429 without one), the page asks again by itself a minute later while the panel is open; with a `Retry-After`, at that time. Why: songs past 100 have no other source, and the owner's rule is to wait on our own rather than make someone reopen the playlist. (spec `docs/specs/spotify-playlist-past-100.md`, question 1)
- 2026-10-12 — Delete the stray branch `cursor/paste-link-from-message` (done; its tip was e4418d7). Why: `main` shipped the same Paste feature another way (36a5d07) and has its own ignore rules, so the branch was superseded. (#16)
