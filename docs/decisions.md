# Decisions

Choices the owner made, or that took their default after 7 days without an answer, newest first, one line each: the date, the decision, why, and its issue. Decisions still waiting are GitHub issues labelled `decision`; debt is labelled `debt` (the `backlog` skill says how to file and close both). A decision that is a standing rule also goes into CLAUDE.md. Never ask again about something recorded here.

Decisions made before Oct 12, 2026 are recorded inline, with their dates, in CLAUDE.md and in TECHNICAL.md's Conventions and gotchas.

<!-- Format: - YYYY-MM-DD — <decision>. Why: <reason>. (#n) -->

- 2026-10-12 — Delete the stray branch `cursor/paste-link-from-message` (done; its tip was e4418d7). Why: `main` shipped the same Paste feature another way (36a5d07) and has its own ignore rules, so the branch was superseded. (#16)
