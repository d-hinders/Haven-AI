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
- If it is waiting on a user decision, money-path approval, migration review, or UX decision, stop and report the blocker.
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
   - `area:docs` → `docs.md`
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

When the diff touches any Markdown file, anything under `docs/`, anything under `scripts/docs/`, or a root gravity file (`CLAUDE.md`, `README.md`, `AGENTS.md`, `ABOUT_HAVEN.md`), run `npm run docs:check` and `npm run docs:test` as a **hard gate**. Front-matter, agent-skill, coupling, and drift failures block the pull request exactly like a failing test or type check — never open or update a pull request while they are red. This is the loop's own gate; it does not depend on any GitHub required-check configuration.

Fix failures before pushing. Never open or update a pull request with a known red local gate.

Run the matching **Captain Self-Check Preflight** in [the agent workflow](../../../docs/contributing/ai-agent-workflow.md).

## Independent Review

1. Review the complete candidate change against `origin/dev`, including staged changes, unstaged tracked changes, and untracked files. If review happens after committing, inspect `git diff origin/dev...HEAD` and separately inspect any later working-tree changes. Never use a committed range that omits the current candidate diff. Use the reviewer role from [haven-agent-workflow](../haven-agent-workflow/SKILL.md); delegate to an independent reviewer when supported, otherwise perform a distinct findings-first review pass.
2. Apply clear, scoped blocking and should-fix findings, then rerun affected checks.
3. Ask the user before applying ambiguous architectural, product, security, money-movement, authorization, or schema findings.
4. Record applied and deferred findings with reasons.
5. Run `node scripts/docs/coupling-gate.mjs` for the changed paths. When the diff touches code that any doc's `covers:` maps to, running the doc-reviewer role is a **hard definition-of-done step**, not optional: review the implicated docs and, in the same pull request, either update the stale claims or genuinely re-verify them and bump `last-verified`, then rerun the docs checks. Do not open the pull request while a `covers:`-mapped doc is left unreviewed.

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
- `lib/delegation-*.ts`, `lib/hybrid-provisioning.ts`, or `routes/agent-delegations.ts`
  (the delegation rail);
- `packages/sdk/src/signer.ts` (signing schemes are spend authority);
- `middleware/agentAuth.ts`;
- `db/migrations/`;
- `scripts/release-bump.mjs` or `.github/workflows/publish.yml`.

The label matters because money-sensitive changes do not always touch listed files
(a new signing scheme, a new rail); the file list matters because a diff can be
money-sensitive without the issue being labeled. Union, never intersection.
A comment-only diff in a listed file may be treated as non-money-path when the
review confirms zero behavioral change — say so explicitly in the PR.

Route the merge:

- **Non-money-path:** after local gates pass and independent review has no blocking or should-fix findings, enable squash auto-merge — `gh pr merge <pr> --auto --squash --delete-branch` right after opening. GitHub then updates the branch and merges when required checks go green; do not sit in a poll loop waiting.
- **Frontend UI:** if review flags any UX, copy, or design-system concern, ask the user before enabling auto-merge.
- **Money-path, not migration:** present the pull-request link, scope, checks, and reviewer verdict; require in-session user approval before enabling squash auto-merge.
- **Migration:** leave the pull request for independent code-owner approval and merge.

Never bypass required checks. Diagnose CI failures, fix them, push, and re-arm auto-merge only when appropriate.

### Waiting on CI — mechanics

Do not burn fixed-timeout `sleep` loops against `gh pr checks`.

- **Non-money-path:** `--auto` (above) means there is nothing to wait for — GitHub merges when green. Move on; you are re-invoked when the merge lands.
- **When a wait is genuinely needed** (holding a money-path PR for approval, or confirming a specific run): use `gh pr checks <pr> --watch --fail-fast` (blocks until checks resolve, exits non-zero on failure) rather than a hand-rolled poll, or arm a Monitor if the client supports it.
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
