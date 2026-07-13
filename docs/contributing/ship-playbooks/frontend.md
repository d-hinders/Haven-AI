---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-07-13"
---

# Frontend playbook

Loaded by `ship-next` for `area:frontend` issues. The goal: a UI issue is shipped on Haven's UX standards without the contributor having to name them. This playbook **links** the standards; it does not restate them.

## 1. Required reading (before implementing)

Read, in order — these are `AGENTS.md` → "Required Reading For UI Work":

1. [`product/README.md`](../../product/README.md) — product doctrine, IA, money-movement clarity, accessibility, and closeout checks.
2. [`product/design-system.md`](../../product/design-system.md) — tokens, typography, cards, buttons, motion, surface hierarchy.
3. [`product/copy-guidelines.md`](../../product/copy-guidelines.md) — user-facing wording and banned technical terms.
4. [`product/screen-recipes.md`](../../product/screen-recipes.md) — repeatable screen structures.
5. [`product/design-review.md`](../../product/design-review.md) — the finishing checklist (also used in §5).

If a `/design-system` route exists, inspect it before editing UX.

## 2. Reuse first

Inspect `packages/frontend/src/components/ui` (primitives) and `packages/frontend/src/components/haven` (domain components) before adding UI. Prefer composition; do **not** invent new card styles, spacing, shadows, radius, or typography unless the existing system genuinely can't express the need. Use the v2 tokens in `globals.css` and the Tailwind aliases.

**Absorb a pattern on its 2nd occurrence, not its 12th ([#901](https://github.com/d-hinders/Haven-AI/issues/901)).** If this diff writes the same markup shape a second time — a header band, badge, row, empty-state, inline `<svg>`, address slice — or re-creates something a primitive already covers, extract it into a `ui/`/`haven/` primitive **and** document it on `/design-system`, in this same PR. This is the Captain Self-Check Preflight's **Pattern Absorption** item; it's the mechanism that prevents the debt clusters epic #859 had to clean retroactively. Only skip it if the two uses will genuinely diverge — and say so.

**A new primitive must land on `/design-system` in the same PR ([#898](https://github.com/d-hinders/Haven-AI/issues/898)).** The design-system coupling gate flags any exported component added under `components/ui/**` or `components/haven/**` whose symbol never appears on `app/(authenticated)/design-system/page.tsx` — posting an advisory PR comment for everyone, and (see §6) a **hard definition-of-done step under ship-next**. Add a showcase entry (usage + variants) alongside the primitive, or — for a genuinely internal export, not a reusable primitive — mark the export line `// design-system-exempt: <reason>`. Check locally with `node packages/frontend/scripts/design-system-coupling.mjs` (add `--strict` to mirror the ship-next gate's exit code).

## 3. Captain Self-Check Preflight

Run the matching items from the **Captain Self-Check Preflight** in [`../ai-agent-workflow.md`](../ai-agent-workflow.md) for the traps the diff touches — e.g. numeric formatters, counter/summary buckets, conditional copy predicates, async hook generations, signer-readiness gates, animation discipline, inline-gate placement, cross-surface display drift, loading-state inference. Each is one grep or one quick read. Do this **before** review so the reviewer finds fewer issues.

## 4. Verification

Verify the change in the **browser**, or — when the browser path is unavailable/flaky — add a **named headless equivalent** (vitest) that covers the skipped animation, layout, routing, loading, or interaction risk. Include empty, loading, error, and success states when the screen can enter them; check mobile and desktop.

**Rendered-screen evidence is REQUIRED** for any diff that touches a rendered route or a shared UI primitive (`components/ui/*`, `components/haven/*`). Run `npm run screenshot -w packages/frontend -- <routes>` (see [#896](https://github.com/d-hinders/Haven-AI/issues/896)); it captures desktop (1280) + mobile (390) PNGs of `/design-system` plus the routes you pass, using a known auth/data fixture and the pre-installed browser. The fixture serves a deterministic **populated** dataset (a funded account, agents on both rails, transactions, a pending approval, contacts) so lists, tables and amounts render realistically — set `SCREENSHOT_FIXTURE=empty` when you specifically want empty states. The script also summarises any **console errors** per route; a red console means a fixture-shape gap or a real client bug — fix it before trusting the PNGs. **Attach the PNGs to the PR, or reference them in the Browser Verification section** — "browser or headless equivalent" is no longer sufficient on its own for a visual surface. A primitive change means shooting `/design-system` (where it's documented) *and* a route that consumes it. Screenshots live in the gitignored `.screenshots/`; the fixture is documented at the top of `scripts/screenshot.mjs`.

**Visual regression (blocking CI, #897).** `/design-system` is pixel-compared against committed Linux baselines on every frontend PR (the *Design visual regression* job). An unintended pixel change in a shared primitive fails the PR with a downloadable diff artifact (`visual-regression-diffs`). **Updating baselines for an intended change — in the SAME PR:** dispatch the **Update visual baselines** workflow on your PR branch (Actions → Update visual baselines → Run workflow → pick the branch) — it regenerates the Linux-rendered baselines and commits them to the branch, where they appear as a reviewable image diff. Caveat: without the `BASELINE_PUSH_TOKEN` secret (a PAT with contents:write), the bot pushes with `GITHUB_TOKEN`, whose commits do **not** trigger PR workflows — on an already-open PR the new head gets zero check runs and every required check waits forever; the workflow warns about this, and the fix is a manual empty commit (`git commit --allow-empty && git push`) or setting the secret. Any PR that intentionally changes what `/design-system` renders (including its prose) without carrying new baselines leaves the job red for every PR after it. Never commit locally-rendered (macOS) baselines; fonts differ and CI will reject them. Run the spec locally only inside a Linux container with `VISUAL_REGRESSION=1`. Note: the job gates auto-merge only while it's listed in the "Haven automerge rules" ruleset's required checks — see [`autonomous-pr-loop.md`](../autonomous-pr-loop.md) §One-time setup. **Before reporting a frontend PR shipped, confirm this job's conclusion on the head SHA** — merged-state alone doesn't prove it ran green.

## 5. Review (two passes: code + rendered)

An `area:frontend` diff gets **both** reviews, because a code-only reviewer is only as good as one that never sees the screen:

1. **`haven-reviewer`** (code) with UI context, checking the diff against [`product/design-review.md`](../../product/design-review.md) and [`copy-guidelines.md`](../../product/copy-guidelines.md).
2. **`haven-design-reviewer`** (rendered) — a dedicated visual/UX/design-system pass keyed off the [#896](https://github.com/d-hinders/Haven-AI/issues/896) screenshots (desktop + mobile) rather than the diff: visual weight, spacing rhythm, alignment, state coverage (empty/loading/error), touch targets, focus-visible, and design-system adherence that only shows up rendered ([#900](https://github.com/d-hinders/Haven-AI/issues/900)). Its canonical role is [`design-reviewer.md`](../../../.agents/skills/haven-agent-workflow/references/design-reviewer.md). Give it the `.screenshots/` PNGs; if a rendered surface has none, that's its first finding.

A finding from **either** pass — even nit-level — trips the §6 pause-on-UI-finding gate. Two automated aids back this up: the Vale terminology rule (`.vale.ini`, scoped to `docs/product`) for docs copy — advisory — and **`npm run lint:copy`** (`scripts/frontend-copy-lint.mjs`), which flags banned multi-word terms in user-facing frontend copy (`app/` + `components/`). The copy lint is a **blocking CI job** ([#902](https://github.com/d-hinders/Haven-AI/issues/902)): it fails the PR on any new banned term beyond the shrink-only `packages/frontend/copy-lint-baseline.json`. For anything it can't catch (it's conservative — multi-word phrases only), check changed strings against `copy-guidelines.md` by hand. Use `// copy-lint-ignore` for a legitimate advanced/developer-facing surface; after cleaning existing debt run `npm run lint:copy:update` to tighten the ratchet.

## 6. Merge policy (UI)

A non-money frontend PR **auto-merges** on green CI + verification **unless** either §5 pass — `haven-reviewer` (code) or `haven-design-reviewer` (rendered) — flags a UX, copy, or design-system issue (**even a nit-level one**) — then **pause and ask the user** (UX is subjective; a flagged finding is a human call). This is the `area:frontend` case of the canonical skill's [Merge Gate](../../../.agents/skills/ship-next/SKILL.md#merge-gate). Money-path UI still follows the `money.md` human gate.

**Hard definition-of-done for a diff that adds a primitive ([#898](https://github.com/d-hinders/Haven-AI/issues/898)):** before opening the PR, run `node packages/frontend/scripts/design-system-coupling.mjs --strict`. A non-zero exit (a new `ui/`/`haven/` export missing from `/design-system` and not `// design-system-exempt`-marked) blocks the merge exactly like a failing test — document the primitive on the reference page first. The plain (advisory) run posts the same finding as a PR comment for human authors.
