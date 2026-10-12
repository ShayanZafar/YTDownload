<!-- Keep it short. The reviewer (human or Claude) reads this first. -->

## What changed and why

<!-- One or two sentences. Link the spec, issue or discussion if there is one. -->

## How it was checked

- [ ] The verify check passes locally (formatting, lint, types, tests)
- [ ] Tests describe the new behaviour and were written before the code that makes them pass
- [ ] A changed or new core flow has unit, integration and UI tests named in docs/core-flows.md
- [ ] `/code-review` was run and its findings were addressed
- [ ] `/security-review` was run if this touches auth, files, network, shell commands or user input
- [ ] No unrelated changes are mixed in
- [ ] Debt found outside this change and decisions it needs are filed as issues (labels `debt`, `decision`); decisions it made are in `docs/decisions.md`

## Anything the reviewer should look at closely

<!-- A risky spot, a judgment call, a part you're unsure about. "Nothing" is a fine answer. -->
