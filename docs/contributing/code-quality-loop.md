---
owner: "@d-hinders"
status: archived
covers: []  # redirect stub — the method moved into the quality-scan skill (#2640)
last-verified: "2026-09-08" # #2640: REDUCED TO A REDIRECT STUB. The discovery method moved verbatim to `.agents/skills/quality-scan/references/discovery-method.md`, per this issue's "fold code-quality-loop.md into the quality-scan skill's reference". Nothing was rewritten in the move — the sections (Run a quality pass, Discovery prompts, Coverage summary, Verification baseline) are byte-identical apart from the new header and two relative link targets rewritten for the new depth (`x402-mpp-consolidation.md` in *Coverage summary*, `ai-agent-workflow.md` in *Verification baseline*) — corrected on review, which measured the difference the first draft of this note claimed away. One intro sentence did not survive the header rewrite ("the old `docs/backlogs/*.yml` tracks are retired"); it is carried by [`docs/backlogs/README.md`](../backlogs/README.md) § *The retired tracks all completed*, so it is relocated, not lost. `covers:` is emptied because a stub makes no claim about code, and the 10 paths it listed were checked one by one rather than assumed: the six code/prompt targets all keep 2-4 other coverers, `.claude/agents/haven-reviewer.md` is covered by the `.claude/agents/**` glob in `ai-agent-workflow.md`, `AGENTS.md` and `CLAUDE.md`, and only the three doc-to-doc entries (`docs/backlogs/README.md`, `loop-engineering.md`, `loop-harness-index.md`) lose their last coverer — accepted, since doc-covers-doc drives no gate. A review pass read `haven-reviewer.md` as orphaned by counting EXACT `covers:` entries and not globs; recorded because the same false positive is available to the next reader. The moved file carries no front-matter, so it could not have taken any coupling over. Prior: #2639: EDITED, scope = ONE clause. It named `AGENTS.md` as canonical for the unconditional-reviewer rule; #2639 moved that rule's full statement into `CLAUDE.md` § *How shipping is governed* and left AGENTS.md a pointer, so the attribution follows it. The rule is unchanged. Scope: that ONE clause; nothing else in this file was re-verified. Prior: #2258: the coverage summary now distinguishes retired AllowanceModule work from live delegation-budget enforcement. The old summary presented allowance routing and owner-side allowance writes as current coverage even though the agent rail is retired. The unconditional haven-reviewer rule remains canonical in AGENTS.md. Prior: re-verified for #1251 (MPP seam refusal) — no claim here affected.
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
