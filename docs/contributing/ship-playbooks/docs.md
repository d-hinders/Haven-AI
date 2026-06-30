---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-06-30"
---

# Docs playbook

Loaded by `ship-next` for `area:docs` issues. The documentation-quality system ([`docs-quality-system.md`](../docs-quality-system.md)) is the standard — this playbook just points at it.

- **Front-matter.** Every doc under `docs/` (and the root gravity files) carries `owner` / `status` / `covers` / `last-verified`. `npm run docs:check` must pass; add front-matter to any new doc.
- **Coupling gate.** When a PR changes code a doc's `covers:` maps to without touching the doc, the gate posts an advisory comment — confirm-or-update each implicated doc and bump its `last-verified`.
- **haven-doc-reviewer.** Run it when the diff touches `covers:`-mapped code (the standard doc-accuracy step in [Independent Review](../../../.agents/skills/ship-next/SKILL.md#independent-review)).
