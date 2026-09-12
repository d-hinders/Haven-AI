---
owner: "@d-hinders"
status: archived
covers: []  # redirect stub — the method moved into the quality-scan skill (#2640)
last-verified: "2026-09-08"
---

# Haven Code Quality Loop — moved

The code-quality discovery method now lives with the skill that runs it:
[`.agents/skills/quality-scan/references/discovery-method.md`](../../.agents/skills/quality-scan/references/discovery-method.md).

Moved by #2640 (epic #2632), which required one canonical statement per fact.
The method was a reference for `quality-scan` and nothing else; keeping it under
`docs/contributing/` meant a second place to look and a second place to drift.

Not moved, and deliberately: the autonomous PR loop
([`autonomous-pr-loop.md`](autonomous-pr-loop.md)) and oracle-grounded
differential campaigns ([`loop-engineering.md`](loop-engineering.md)) are
different concepts, as their own front-matter says.
