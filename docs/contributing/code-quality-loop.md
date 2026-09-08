---
owner: "@d-hinders"
status: archived
covers: []  # redirect stub — the method moved into the quality-scan skill (#2640)
last-verified: "2026-09-08" # #2640: REDUCED TO A REDIRECT STUB. The discovery method moved verbatim to `.agents/skills/quality-scan/references/discovery-method.md`, per this issue's "fold code-quality-loop.md into the quality-scan skill's reference". Nothing was rewritten in the move — the sections (Run a quality pass, Discovery prompts, Coverage summary, Verification baseline) are byte-identical apart from the new header. `covers:` is emptied because a stub makes no claim about code; the moved file carries the claims now. Prior: #2639: EDITED, scope = ONE clause. It named `AGENTS.md` as canonical for the unconditional-reviewer rule; #2639 moved that rule's full statement into `CLAUDE.md` § *How shipping is governed* and left AGENTS.md a pointer, so the attribution follows it. The rule is unchanged. Scope: that ONE clause; nothing else in this file was re-verified. Prior: #2258: the coverage summary now distinguishes retired AllowanceModule work from live delegation-budget enforcement. The old summary presented allowance routing and owner-side allowance writes as current coverage even though the agent rail is retired. The unconditional haven-reviewer rule remains canonical in AGENTS.md. Prior: re-verified for #1251 (MPP seam refusal) — no claim here affected.
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
