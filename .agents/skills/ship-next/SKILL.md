---
name: ship-next
description: Ship one ready Haven GitHub issue end to end through implementation, verification, independent review, documentation checks, a pull request to dev, and the correct merge gate. Use when a user asks to ship the next queued issue, ship a specified ready issue, or run the autonomous Haven issue-to-PR workflow.
---

# Ship Next

Ship exactly one ready issue, then stop. GitHub issue and pull-request state is the workflow state.

## Select The Work

Accept one source:

- no argument or `label=<name>`: choose the lowest-numbered open issue with the label, defaulting to `code-quality`;
- `epic=#<n>`: choose the lowest-numbered open sub-issue;
- a specified ready issue: ship that issue;
- a quoted freeform task: first use [new-task](../new-task/SKILL.md), add `code-quality`, then ship the created issue.

**Respect dependencies before number order.** An issue is BLOCKED — skip it and take the next candidate — when any of these hold:

- a `Depends on` / `depends: #N` reference in its body points at an issue that is still open;
- a build-order comment on the epic sequences it after something still open;
- its scope presupposes code that does not exist yet (verify with a quick grep — an
  acceptance gate for a subsystem cannot ship before the subsystem).

If every remaining candidate is blocked, stop and report the dependency chain instead
of forcing the lowest number.

Before selecting new work, find any open pull request linked with `Closes #<issue>`.

- If it is waiting on CI or has a fixable failure, finish that pull request.
- If it is waiting on a user decision, migration review, or UX decision, stop and report the blocker.
- Start new work only when the selected source has no in-flight pull request.

**Collision check — don't double-build parallel work.** The `Closes #<issue>`
lookup only catches PRs bound to the *same* issue. A parallel session can be
mid-flight on the same surface under a different issue (the demo-merchant half
of #452 was built twice before this was caught). Before implementing, glance
for overlap:

- `gh pr list --state open` — any open PR on the candidate's `area:*` surface or
  touching the files this issue implies;
- recently pushed branches (`git ls-remote --heads origin` or `gh api` recent
  branch activity) whose name references this issue or surface.

On a real overlap, **report it and pause** rather than build a second copy —
coordinate or pick the next candidate.

Stop and ask the user if scope or acceptance is unsafe to infer. Never guess on money movement, authentication, authorization, or schema.

## Prepare

1. Fetch `origin/dev`.
2. Protect unrelated local changes. Use an isolated worktree when the current tree is dirty or conflicted.
3. Create a fresh issue branch from `origin/dev` using the client-required branch prefix and the issue number.
4. Classify all affected surfaces from labels and likely files.
5. Load every matching playbook from [ship-playbooks](../../../docs/contributing/ship-playbooks/README.md):
   - `area:frontend` → `frontend.md`
   - `area:backend` → `backend.md`
   - `area:sdk` or `area:mcp` → `sdk.md`
   - `area:docs` → `docs.md`, and also whenever the diff touches code that some doc's `covers:` maps to — the coupling gate fires on **code** changes, so routing its playbook by `area:docs` alone loads it exactly when it is not needed
   - `money-path` → `money.md`
6. For non-trivial work, use the coordinator and explorer roles from [haven-agent-workflow](../haven-agent-workflow/SKILL.md).

## Implement

1. Implement only the issue scope and preserve surrounding conventions.
2. Keep shared and gravity files with the captain.
3. When changing existing money-path behavior, write characterization tests before changing behavior.
4. Reuse canonical docs and playbooks by reference; do not copy their policy into this skill.

## Acceptance Gate

Run checks proportionate to every changed surface:

- package tests and type checks for package changes;
- full `npm run quality` for cross-package behavior;
- browser verification or the required headless equivalent for UI changes.

Run the **repository's own required checks** locally before pushing, for fast feedback:

- `npm run docs:check` and `npm run docs:test` when the diff touches any Markdown file, anything under `docs/` or `scripts/docs/`, or a root gravity file (`CLAUDE.md`, `README.md`, `AGENTS.md`, `ABOUT_HAVEN.md`);
- `npm run docs:coupling` when the diff touches **any source file** — this one is keyed on code, not Markdown, so the Markdown-keyed line above never fires for the pure-code PR that needs it (the #1076 failure). It is the strict, CI-equivalent form; the bare `node scripts/docs/coupling-gate.mjs` always exits 0 and will not tell you what CI says. Run it from the worktree holding the candidate change — it reads uncommitted work, so it is valid before the commit;
- `npm run design:lint -w packages/frontend` and `node packages/frontend/scripts/design-system-coupling.mjs --strict` when the diff touches frontend surfaces or adds an exported component under `components/ui/**` or `components/haven/**`. Add the showcase entry to `app/(authenticated)/design-system/page.tsx`, or mark a genuinely internal export `// design-system-exempt: <reason>`.

These are **CI required checks** (#1023), not gates this skill owns — every PR gets them however it was opened. Running them here only saves a round trip. Do not restate their rules in this file: the workflow comments and `docs/contributing/docs-quality-system.md` are the definition, and a second copy drifts.

Fix failures before pushing. Never open or update a pull request with a known red local gate.

Run the matching **Captain Self-Check Preflight** in [the agent workflow](../../../docs/contributing/ai-agent-workflow.md).

## Independent Review

1. Review the complete candidate change against `origin/dev`, including staged changes, unstaged tracked changes, and untracked files. If review happens after committing, inspect `git diff origin/dev...HEAD` and separately inspect any later working-tree changes. Never use a committed range that omits the current candidate diff. Use the reviewer role from [haven-agent-workflow](../haven-agent-workflow/SKILL.md); delegate to an independent reviewer when supported, otherwise perform a distinct findings-first review pass. **For `area:frontend` diffs, run a second, rendered pass** with the [design-reviewer role](../haven-agent-workflow/references/design-reviewer.md) (`haven-design-reviewer`) over the #896 screenshots — code review and visual review are complementary, and a finding from either trips the frontend merge gate (see [`frontend.md`](../../../docs/contributing/ship-playbooks/frontend.md) §5–6).
2. Apply clear, scoped blocking and should-fix findings, then rerun affected checks.
3. Ask the user before applying ambiguous architectural, product, security, money-movement, authorization, or schema findings.
4. Record applied and deferred findings with reasons.
5. Run `npm run docs:coupling`. Two kinds of finding, and they are not the same obligation:
   - **⚠️ contract doc → blocking.** The strict gate exits 1 and so will CI. Resolve it in *this* pull request: update the stale claims, or genuinely re-verify the doc and bump `last-verified`. Never push with this red.
   - **Everything else → advisory.** Run the doc-reviewer role over the implicated docs; this is a **hard definition-of-done step**, not optional. Update what the diff actually made stale. Bump `last-verified` only on a doc you really re-read — a rubber-stamped date is worse than a stale one, because the weekly staleness audit ranks on it, so leaving a doc untouched and saying why is a legitimate outcome.

   Do not open the pull request while a `covers:`-mapped doc is left unreviewed. Report what the gate actually printed — "no covered docs implicated" is only evidence when the gate saw the candidate diff, which is why it now refuses to call an empty file set a pass.

## Commit And Pull Request

1. Review the final diff and run `git diff --check`.
2. Commit conventionally using any attribution required by the active client or repository policy.
3. Push the issue branch.
4. Open a pull request with base `dev`, never `main`, using the available GitHub integration or authenticated `gh`.
5. Fill the applicable sections of [the pull-request template](../../../.github/pull_request_template.md), including:
   - changed surfaces and workflow used;
   - local checks and browser/headless verification;
   - intentionally excluded work;
   - generated-artifact and handoff impact;
   - CASP/MiCA status when applicable;
   - review findings and resolution;
   - merge readiness: CI, local checks, review status, risk, why safe, residual risk, and merge order.
6. Include `Closes #<issue>`.
7. Monitor pull-request activity when the client supports it.

## Merge Gate

Classify a change as money-path when **either** the issue carries the `money-path`
label **or** the diff touches any of:

- `routes/x402.ts`, `routes/x402-resources.ts`, `routes/payments.ts`, or `routes/machine-payments.ts`;
- `lib/machine-payments.ts`, `lib/payment-coverage.ts`, or `lib/allowance-module.ts`;
- `lib/execution-rail.ts` (the rail seam);
- `lib/delegation-*.ts`, `lib/hybrid-provisioning.ts`, `lib/hybrid-account-config.ts`, or `routes/agent-delegations.ts`
  (the delegation rail);
- `lib/sweep.ts`, `lib/relayer.ts`, or `lib/mainnet-gate.ts` (funds recovery, gas
  payment, and the mainnet authority floor — added by #1045; the review found them
  missing while they literally move or gate money);
- `routes/safe-exec.ts`, `routes/approvals.ts`, or `routes/hybrid-accounts.ts`
  (user-signed execution, the approval queue, account provisioning);
- `packages/sdk/src/signer.ts` (signing schemes are spend authority);
- `middleware/agentAuth.ts`;
- `db/migrations/`;
- `scripts/release-bump.mjs` or `.github/workflows/publish.yml`.

The label matters because money-sensitive changes do not always touch listed files
(a new signing scheme, a new rail); the file list matters because a diff can be
money-sensitive without the issue being labeled. Union, never intersection.
A comment-only diff in a listed file may be treated as non-money-path when the
review confirms zero behavioral change — say so explicitly in the PR.

Classification drives the **playbook and the testing bar**, not a merge pause. A money-path diff still loads `money.md`, still needs characterization tests before existing behavior changes, and still states its classification in the pull-request body.

Route the merge:

- **Migration:** leave the pull request for independent code-owner approval and merge (`.github/CODEOWNERS`). The author's own approval does not satisfy it.
- **Frontend UI:** if either review pass flags a UX, copy, or design-system concern, ask the user before enabling auto-merge.
- **Everything else, money-path included:** after local gates pass and independent review has no blocking or should-fix findings, enable squash auto-merge — `gh pr merge <pr> --auto --squash --delete-branch` right after opening. GitHub then updates the branch and merges when required checks go green; do not sit in a poll loop waiting.

> **Why money-path does not pause here (#1024).** The in-session approval applied only to pull requests opened through this skill — a hand-written money-path pull request merged on green CI alone. That made the canonical workflow more expensive than bypassing it while protecting nothing on the bypass path, and the approver was usually the author. What protects the money path is automatic and tool-independent: `CODEOWNERS` for irreversible schema changes, and the `qa-freshness` gate that refuses a `dev → main` promotion without a recent green money-flow QA run on `dev` (partial — time-based, not SHA-bound, and blind to `hotfix/*`). See [`autonomous-pr-loop.md`](../../../docs/contributing/autonomous-pr-loop.md) → "Money-path safety model".

Never bypass required checks. Diagnose CI failures, fix them, push, and re-arm auto-merge only when appropriate.

**Merged ≠ all green.** Auto-merge waits only for the checks the rulesets *require*; a workflow-blocking job outside that list (see the ruleset inventory in [autonomous-pr-loop.md](../../../docs/contributing/autonomous-pr-loop.md)) can still be running — or red — when the merge lands. Before reporting the PR shipped, confirm the blocking jobs' conclusions on the **head SHA** (`gh api repos/<o>/<r>/commits/<sha>/check-runs`), not just the PR's merged state. A red post-merge job is your failure to hand off: fix or revert before taking new work.

### Waiting on CI — mechanics

Do not burn fixed-timeout `sleep` loops against `gh pr checks`.

- **Auto-merged PRs:** `--auto` (above) means there is nothing to wait for — GitHub merges when green. Move on; you are re-invoked when the merge lands.
- **When a wait is genuinely needed** (holding a UI PR on a review finding, or confirming a specific run): use `gh pr checks <pr> --watch --fail-fast` (blocks until checks resolve, exits non-zero on failure) rather than a hand-rolled poll, or arm a Monitor if the client supports it.
- **BEHIND** resolves itself under `--auto` (GitHub updates the branch). Only run `gh pr update-branch` manually when not using `--auto` and the branch is genuinely behind.

## Closeout

Leave the issue open until the pull request merges. Report the issue, pull request, gate result, risk, and merge mode, then stop. A caller may invoke the skill again for the next item.

**Acceptance-criteria evidence.** When the issue body has acceptance-criteria
checkboxes, the closing comment ticks each one with a link to its evidence (test
name, PR, tx link, doc section). A criterion without evidence stays unticked and
the issue stays open — never tick on assertion alone.

**Operator-verify mode.** When the definition of done includes steps only a human
operator can run (funded testnet keys, vendor dashboards, live end-to-end runs):

1. Ship the code PR as usual — the merge is not blocked by the live step.
2. Post a numbered, copy-pasteable operator checklist on the issue (exact commands,
   env var names — never secret values — and the expected output of each step).
3. Leave the issue OPEN in this state and say so in the report; do not close on
   "code merged".
4. When the operator confirms (or pastes the output), verify it matches the expected
   evidence, tick the checklist, and close with the evidence links.
