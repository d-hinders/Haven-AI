---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-08-04"
---

# Docs playbook

Loaded by `ship-next` for `area:docs` issues, and for any diff touching code that some doc's `covers:` maps to. The documentation-quality system ([`docs-quality-system.md`](../docs-quality-system.md)) is the standard — this playbook just points at it.

- **Front-matter.** Every doc under `docs/` (and the root gravity files) carries `owner` / `status` / `covers` / `last-verified`. `npm run docs:check` must pass; add front-matter to any new doc.
- **Acceptance gate (hard).** Any diff touching Markdown, `docs/`, `scripts/docs/`, or a gravity file must pass `npm run docs:check` and `npm run docs:test` locally before the PR opens — same standing as tests and type checks (see [Acceptance Gate](../../../.agents/skills/ship-next/SKILL.md#acceptance-gate)).
- **Coupling gate.** When a PR changes code a doc's `covers:` maps to without touching the doc, the gate flags it. Run `npm run docs:coupling` — the strict, CI-equivalent form; the bare `node scripts/docs/coupling-gate.mjs` is advisory-only and always exits 0, so it will not tell you what CI says. A doc marked `contract: true` is **blocking** and must be resolved in the same PR; the rest are advisory — confirm-or-update each and bump its `last-verified`. Only bump the date when you actually re-read the doc: a rubber-stamped `last-verified` is worse than a stale one, because the weekly staleness audit ranks on it.
- **haven-doc-reviewer (hard step).** When the diff touches `covers:`-mapped code, running it is a definition-of-done step, not optional: review and update the implicated docs in the same PR before opening it (see [Independent Review](../../../.agents/skills/ship-next/SKILL.md#independent-review)).
