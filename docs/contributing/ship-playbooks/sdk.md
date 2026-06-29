---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-06-29"
---

# SDK / API / credentials playbook

Loaded by `/ship-next` for `area:sdk` and `area:mcp` issues. **Stub — filled in [#655](https://github.com/d-hinders/Haven-AI/issues/655).**

When complete, this playbook will require, by reference: reading `docs/operations/mcp-runtime-compatibility.md` (and `scripts/README.md` for releases); regenerating/verifying generated artifacts when SDK/API behavior changes (`.env` examples, SDK snippets, credential files, demo scripts, skill bundles); keeping the OpenAPI drift test green; and never hand-editing version/dep pins (`scripts/release-bump.mjs` is the source of truth).

Until #655 lands, follow `docs/operations/mcp-runtime-compatibility.md` and `scripts/README.md` directly.
