---
name: code-quality
description: Run Haven's small-PR code-quality cadence or a structural quality scan. Use when a user asks for code quality, quality hardening, quality scan, cleanup target selection, or the next narrow code-quality PR.
---

# Code Quality

Use this skill for two related workflows:

- **Quality scan:** find one or two structural weaknesses, report evidence, and
  stop for a human decision.
- **Quality hardening pass:** choose one narrow, high-value target and ship it
  through [ship-next](../ship-next/SKILL.md) or a focused manual PR.

Read `docs/contributing/code-quality-loop.md` first. It is the canonical ledger,
selection bar, completed-area map, and current target guidance. Also read
`docs/contributing/loop-harness-index.md` when the candidate surface mirrors or
predicts a source of truth that may need an oracle-grounded differential loop.

## Quality Scan Mode

Use scan mode when the user asks to review code quality, find structural debt,
or identify the next quality theme.

1. Read the current quality-loop doc and collect completed, deferred, and
   out-of-scope areas.
2. Size the requested scope with reproducible commands: package line counts,
   largest files, source-vs-test ratios, mock density, `any` density,
   route-vs-test coverage, and TODO or warning comment clusters as relevant.
3. Filter candidates through this bar:
   - structural pattern, not a defect list;
   - measured evidence;
   - demonstrated cost from incidents, comments, repeated workarounds, or test
     failures;
   - changes how contributors work;
   - splittable into narrow or parallelizable tasks.
4. Report only the top one or two findings with commands that reproduce the
   measurements and a proposed issue or PR slicing.
5. Stop for the user's decision. Do not implement or file issues unless the
   user explicitly asks.

## Quality Hardening Mode

Use hardening mode when the user asks to ship the next code-quality item or to
implement an accepted quality finding.

1. Re-run discovery against today's code before trusting old backlog text.
2. Pick by blast radius and value, not by findability. Money movement, agent
   authority, external financial writes, and shared API contracts outrank
   cosmetic cleanup.
3. Keep the PR small, guarded, and revertable: one surface, one invariant, and
   focused regression coverage.
4. If the surface mirrors a source of truth, consider an oracle-grounded loop
   using `docs/contributing/loop-engineering.md` instead of ordinary example
   tests.
5. Verify independently before marking done: focused tests, typecheck or build
   for the affected package, `git diff --check`, and `haven-reviewer` for risky
   surfaces.
6. Update `docs/contributing/code-quality-loop.md` and any affected loop-harness
   index after the pass.

## Guardrails

- Do not spend quality-loop effort on surfaces the quality-loop doc marks as
  dormant or out of scope unless the task is removal and the user asked for it.
- Do not smuggle behavior changes into a schema-only or cleanup PR.
- Do not mark an area completed on prose alone; leave a machine check or an
  explicit independent review trail.
