---
owner: "@d-hinders"
status: current
covers: []  # narrative — process playbook
last-verified: "2026-08-22" # #1768: §4 gains the viewport-coverage table — both Playwright projects gate on every PR now, and `*.mobile.spec.ts` is how you write a mobile test. Prior: #1738: full-page captures un-clip the shell and fail on a blank PNG — §4 re-read against the capture scripts
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

**A new primitive must land on `/design-system` in the same PR ([#898](https://github.com/d-hinders/Haven-AI/issues/898)).** The design-system coupling gate flags any exported component added under `components/ui/**` or `components/haven/**` whose symbol never appears on `app/(authenticated)/design-system/page.tsx`. Two CI jobs, on every PR however it was opened ([#1023](https://github.com/d-hinders/Haven-AI/issues/1023)): **Design-system coupling** posts the sticky comment that explains the finding, and **Design-system coupling (strict)** blocks on it. Add a showcase entry (usage + variants) alongside the primitive, or — for a genuinely internal export, not a reusable primitive — mark the export line `// design-system-exempt: <reason>`. Check locally with `node packages/frontend/scripts/design-system-coupling.mjs --strict`.

## 3. Captain Self-Check Preflight

Run the matching items from the **Captain Self-Check Preflight** in [`../ai-agent-workflow.md`](../ai-agent-workflow.md) for the traps the diff touches — e.g. numeric formatters, counter/summary buckets, conditional copy predicates, async hook generations, signer-readiness gates, animation discipline, inline-gate placement, cross-surface display drift, loading-state inference. Each is one grep or one quick read. Do this **before** review so the reviewer finds fewer issues.

## 4. Verification

Verify the change in the **browser**, or — when the browser path is unavailable/flaky — add a **named headless equivalent** (vitest) that covers the skipped animation, layout, routing, loading, or interaction risk. Include empty, loading, error, and success states when the screen can enter them; check mobile and desktop.

**Which viewports actually gate ([#1768](https://github.com/d-hinders/Haven-AI/issues/1768)).** The *Frontend browser smoke* job runs **both** Playwright projects on every frontend PR, with no dispatch required:

| Project | Emulation | Runs | Gates a PR |
|---|---|---|---|
| `chromium-desktop` | Desktop Chrome — 1280×720 viewport, fine pointer, no touch, DSF 1 | every `e2e/*.spec.ts` **except** `*.mobile.spec.ts` | yes |
| `chromium-mobile` | **Pixel 5** — 393×727 viewport, coarse pointer, touch, Android UA, DSF 2.75 | `e2e/*.mobile.spec.ts` only | yes |

(Numbers read off Playwright's own `devices` table at the pinned version, not from memory. Pixel 5's `screen` is 393×851; the **viewport** — what the page actually gets — is 393×727.)

Both projects also inherit `SUITE_IGNORE` (`e2e/live/**`, and `*.visual.spec.ts` unless `VISUAL_REGRESSION=1`). That constant exists because a project-level `testIgnore` **replaces** the config-level one instead of extending it — a project that declares its own must spread `SUITE_IGNORE` back in, or the unmocked live smoke silently rejoins the fast suite.

Plus the separate *Design visual regression* job, which pixel-compares `/design-system` at **1280** and **390** (`scripts/evidence-viewports.mjs`) — but under `chromium-desktop` at DSF 1, by setting the viewport inside the spec. That is a pixel gate, not a device gate: it sees layout, never touch or hit-testing.

Before #1768, `chromium-mobile` existed but only a `workflow_dispatch` with `ui_suite=full` ever ran it — so **no mobile viewport gated anything**, which is a large part of why [#1749](https://github.com/d-hinders/Haven-AI/issues/1749) (primary navigation unopenable below `lg`) shipped. That input is now removed and both projects are unconditional.

**Writing a mobile test:** name the file `*.mobile.spec.ts` and it runs under real Pixel 5 emulation. Do **not** reach for `test.use({ viewport: … })` inside a desktop spec — it narrows the window but leaves `maxTouchPoints` at 0, the pointer fine and the UA desktop, so touch and hit-testing behaviour is not actually covered. Conversely, keep viewport-independent behaviour out of `*.mobile.spec.ts`: the two projects run disjoint spec sets on purpose, and duplicating a spec buys nothing but CI minutes. `e2e/navigation.mobile.spec.ts` is the reference, including the meta-guard that fails if the project ever stops being device-emulated.

**Measure overflow on the scroll box, not the document.** The authenticated shell is `overflow-hidden`, so content wider than the screen is *clipped* rather than growing `documentElement.scrollWidth` — which means the page-level `expectNoHorizontalOverflow` helper **cannot fail** on any authenticated route ([#1771](https://github.com/d-hinders/Haven-AI/issues/1771)). This was found by the #1768 mutation, not by reading. Compare `<main id="main-content">`'s own `scrollWidth` against its `clientWidth`; `navigation.mobile.spec.ts`'s `measureContentOverflow` is the reference. Clipped content on mobile is *unreachable*, not merely ugly, so this is the assertion that matters.

**A known, filed defect is exempted by name, never by deletion.** `navigation.mobile.spec.ts` keeps a `KNOWN_CONTENT_OVERFLOW` map: the route still runs and still asserts rendering and console cleanliness, only the one known-failing assertion is skipped, and only with an issue number and the measured numbers next to it. Dropping the route instead is how a gate quietly stops covering things — which is the defect #1768 exists to close. Delete the entry in the PR that fixes the issue.

Run them locally with `npm run test:e2e:mobile -w packages/frontend`, or both with `npm run test:e2e:gate -w packages/frontend` (exactly what CI runs).

**Rendered-screen evidence is REQUIRED** for any diff that touches a rendered route or a shared UI primitive (`components/ui/*`, `components/haven/*`). Run `npm run screenshot -w packages/frontend -- <routes>` (see [#896](https://github.com/d-hinders/Haven-AI/issues/896)); it captures desktop (1280) + mobile (390) PNGs of `/design-system` plus the routes you pass, using a known auth/data fixture and the pre-installed browser. The fixture serves a deterministic **populated** dataset (a funded account, agents on both rails, transactions, a pending approval, contacts, agent activity and spend stats) so lists, tables and amounts render realistically — set `SCREENSHOT_FIXTURE=empty` when you specifically want empty states. The script also summarises any **console errors** per route; a red console means a fixture-shape gap or a real client bug — fix it before trusting the PNGs. **Attach the PNGs to the PR, or reference them in the Browser Verification section** — "browser or headless equivalent" is no longer sufficient on its own for a visual surface. A primitive change means shooting `/design-system` (where it's documented) *and* a route that consumes it. Screenshots live in the gitignored `.screenshots/`; the fixture is documented at the top of `scripts/screenshot.mjs`.

**Surfaces no URL can reach — use a scenario ([#1409](https://github.com/d-hinders/Haven-AI/issues/1409)).** Route capture cannot see a screen that lives behind a multi-step dialog or a state machine that only advances on a timer; the connect-agent modal is both, which is why [#1399](https://github.com/d-hinders/Haven-AI/issues/1399) shipped with its rendered-evidence criterion unmet and its two review passes disagreeing about a layout question neither could see. A **scenario** drives the UI there and holds it at each state:

```
npm run screenshot -w packages/frontend -- --scenario=connect-agent   # one scenario
npm run screenshot -w packages/frontend -- --scenario=all             # every scenario
```

`connect-agent` captures step 4 at all three connection stages (`starting` → `slow` → `recovery`) at both viewports, writing `connect-agent-waiting-<stage>-<viewport>.png`. It pins the setup at `awaiting_connection` and drives Playwright's virtual clock past the staging bounds, so a three-minute state is reached in milliseconds. A scenario that cannot reach its state **fails the command** rather than writing fewer PNGs — a missing stage is the evidence gap, not a smaller run. Add new scenarios to the `SCENARIOS` registry in `scripts/screenshot.mjs`; their fixture contract is pinned by `src/__tests__/screenshot-fixture.test.ts`.

**Two PNGs when a dialog scrolls.** An element screenshot captures only the visible box, so a dialog that caps its own height drops everything below the fold — and its rounded bottom edge makes the clipped capture look complete, which would have a reviewer judge a screen they have only partly seen. When a capture overflows, the run says so (`⚠ … had content BELOW THE FOLD`, with the pixel shortfall) and writes a second `…-full.png` at a viewport tall enough to show all of it. **Judge the content from the `-full` PNG; judge what is reachable without scrolling from the other** — the fold itself is often the finding.

**A blank capture fails the run ([#1738](https://github.com/d-hinders/Haven-AI/issues/1738)).** The app shell is `h-screen` + `overflow-hidden` with `<main>` as its only scroller, so a naive `fullPage` capture paints one viewport and leaves a very long white tail — the PNG is the right size and looks fine. Route captures therefore un-clip the shell first (`scripts/full-page-capture.mjs`), then read the PNG back: a capture more than a viewport tall with nothing painted below the fold is **deleted** and fails the command, with the measured painted ratio in the message. This is not hypothetical — the committed `/design-system` baselines were 95% (desktop) and 97% (mobile) blank until that fix, so the pixel gate had been comparing white against white below the fold and the design-reviewer pass was reading empty pixels. If you see the failure, the usual cause is a layout change to the shell's overflow; do not work around it by capturing less.

**If Chromium fails to launch** with an error naming a `chromium_headless_shell-<n>` path that does not exist, the cached browser build does not match the pinned Playwright version. Point `PLAYWRIGHT_CHROMIUM_PATH` at the Chromium that *is* installed rather than running `playwright install`:

```
PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
  npm run screenshot -w packages/frontend -- --scenario=connect-agent
```

**Visual regression (blocking CI, #897).** `/design-system` is pixel-compared against committed Linux baselines on every frontend PR (the *Design visual regression* job). An unintended pixel change in a shared primitive fails the PR with a downloadable diff artifact (`visual-regression-diffs`). **Updating baselines for an intended change — in the SAME PR:** dispatch the **Update visual baselines** workflow on your PR branch (Actions → Update visual baselines → Run workflow → pick the branch) — it regenerates the Linux-rendered baselines and commits them to the branch, where they appear as a reviewable image diff. Caveat: without the `BASELINE_PUSH_TOKEN` secret (a PAT with contents:write), the bot pushes with `GITHUB_TOKEN`, whose commits do **not** trigger PR workflows — on an already-open PR the new head gets zero check runs and every required check waits forever; the workflow warns about this, and the fix is a manual empty commit (`git commit --allow-empty && git push`) or setting the secret. Any PR that intentionally changes what `/design-system` renders (including its prose) without carrying new baselines leaves the job red for every PR after it. Never commit locally-rendered (macOS) baselines; fonts differ and CI will reject them. Run the spec locally only inside a Linux container with `VISUAL_REGRESSION=1`. Note: the job gates auto-merge only while it's listed in the "Haven automerge rules" ruleset's required checks — see [`autonomous-pr-loop.md`](../autonomous-pr-loop.md) §One-time setup. **Before reporting a frontend PR shipped, confirm this job's conclusion on the head SHA** — merged-state alone doesn't prove it ran green.

**Wire shapes come from the spec, not from you (#1447).** `npm run lint:wire-types` is a **blocking CI job** on the frontend surface. It counts hand-written types in `hooks/` and `types/` that declare a snake_case property — the API's convention — against a shrink-only baseline (`packages/frontend/wire-type-baseline.json`, frozen at 18 after #1445's migration). If the route is in the spec, import the type instead of restating it:

```
import type { ApiSchema } from '@haven_ai/core'
export type Thing = ApiSchema<'Thing'>
```

If the route is not in the spec yet, document it there first — [#1446](https://github.com/d-hinders/Haven-AI/issues/1446) tracks that backfill, and the 18 baselined shapes are waiting on it. If a type is genuinely UI-side and merely happens to carry a snake_case field, mark it `// ui-local: <reason, at least 20 chars>` on the line above; a bare marker does not exempt. After removing shapes, tighten with `npm run lint:wire-types:update` (it refuses to ratchet upward). The gate reads casing, so it does **not** see a wire shape that uses camelCase, and it cannot see an anonymous inline shape (`useState<{ tx_hash: string }>`) because there is no declaration to find. Both holes are stated in the script's header with live examples; review is the backstop.

## 5. Review (two passes: code + rendered)

An `area:frontend` diff gets **both** reviews, because a code-only reviewer is only as good as one that never sees the screen:

1. **`haven-reviewer`** (code) with UI context, checking the diff against [`product/design-review.md`](../../product/design-review.md) and [`copy-guidelines.md`](../../product/copy-guidelines.md).
2. **`haven-design-reviewer`** (rendered) — a dedicated visual/UX/design-system pass keyed off the [#896](https://github.com/d-hinders/Haven-AI/issues/896) screenshots (desktop + mobile) rather than the diff: visual weight, spacing rhythm, alignment, state coverage (empty/loading/error), touch targets, focus-visible, and design-system adherence that only shows up rendered ([#900](https://github.com/d-hinders/Haven-AI/issues/900)). Its canonical role is [`design-reviewer.md`](../../../.agents/skills/haven-agent-workflow/references/design-reviewer.md). Give it the `.screenshots/` PNGs; if a rendered surface has none, that's its first finding.

A finding from **either** pass — even nit-level — trips the §6 pause-on-UI-finding gate. Two automated aids back this up: the Vale terminology rule (`.vale.ini`, scoped to `docs/product`) for docs copy — advisory — and **`npm run lint:copy`** (`scripts/frontend-copy-lint.mjs`), which flags banned multi-word terms in user-facing frontend copy (`app/` + `components/`). The copy lint is a **blocking CI job** ([#902](https://github.com/d-hinders/Haven-AI/issues/902)): it fails the PR on any new banned term beyond the shrink-only `packages/frontend/copy-lint-baseline.json`. For anything it can't catch (it's conservative — multi-word phrases only), check changed strings against `copy-guidelines.md` by hand. Use `// copy-lint-ignore` for a legitimate advanced/developer-facing surface; after cleaning existing debt run `npm run lint:copy:update` to tighten the ratchet.

## 6. Merge policy (UI)

A non-money frontend PR **auto-merges** on green CI + verification **unless** either §5 pass — `haven-reviewer` (code) or `haven-design-reviewer` (rendered) — flags a UX, copy, or design-system issue (**even a nit-level one**) — then **pause and ask the user** (UX is subjective; a flagged finding is a human call). This is the `area:frontend` case of the canonical skill's [Merge Gate](../../../.agents/skills/ship-next/SKILL.md#merge-gate). Money-path UI still follows the `money.md` bar (characterization tests, CASP guardrails); since #1024 that no longer includes a merge pause.

**Hard definition-of-done for a diff that adds a primitive ([#898](https://github.com/d-hinders/Haven-AI/issues/898)):** run `node packages/frontend/scripts/design-system-coupling.mjs --strict` before opening the PR. A non-zero exit (a new `ui/`/`haven/` export missing from `/design-system` and not `// design-system-exempt`-marked) means the **Design-system coupling (strict)** required check will fail — document the primitive on the reference page first. Running it locally only saves the round trip; the gate itself is in CI ([#1023](https://github.com/d-hinders/Haven-AI/issues/1023)), so it applies to every author.
