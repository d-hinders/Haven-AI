---
owner: "@d-hinders"
status: current
covers:
  - .agents/skills/haven-agent-workflow/**
  - .agents/skills/ship-next/**
  - .claude/agents/**
  - .claude/commands/ship-next.md
  - .github/pull_request_template.md
  - AGENTS.md
  - docs/contributing/autonomous-pr-loop.md
  - docs/contributing/ai-review-patterns.md
  - scripts/ci/review-isolation.mjs
last-verified: "2026-08-31" # #2455: added the *Review Isolation* section below and put `scripts/ci/review-isolation.mjs` in `covers:` above, so a later change to the guard implicates this doc. The section records a measured mechanism, not a preference: a git worktree's `.git` is a FILE pointing at the parent gitdir, so `cp -R` of one yields a directory whose files are a frozen snapshot while every `git diff`/`show`/`log`/`status` answers from the live repository — reproduced end to end in `scripts/ci/review-isolation.test.mjs`, where the builder ADDS a line and the copy's diff reports it as `-LIVE EDIT`. Scope: the new section, the `covers:` line and the *Worktree Guidance* section it sits under, all of which were re-read. NOT re-verified: the preflight list, the agent roster, the prompt templates, or any other `covers:` target. Prior: #2313-followup: the shipped #2313 entry below reached `dev` in PR #2336, so it is kept VERBATIM as the historical record and superseded here rather than rewritten in place — this doc's own #2131 -> #2145 precedent, and a haven-doc-reviewer finding against my first attempt, which edited it in place on the false premise that it had not shipped. Two corrections to it. (1) A later pass rephrased the bullet's closing clause to `CLAUDE.md`'s "reverts during gas estimation" — more precise in isolation, but it broke the verbatim parity with `.agents/skills/haven-agent-workflow/references/workflow-coordinator.md:43` that the #2313 entry had just restored, since the sibling was left alone. Reverted to parity. (2) The note justifying that revert then claimed a THREE-file parity including `backend-worker.md`. Measured and false: exact parity is a PAIR — grepping the bullet's closing clause verbatim across `--include='*.md'` returned exactly two FILES, `workflow-coordinator.md:43` and this file's `:62`, and no third. (Stated as a file count deliberately: quoting the search string in full here would have made this note a third line hit and falsified its own measurement — the fourth near-miss of the same kind in this chain.) `backend-worker.md:30` says something different ("declined before any money moves — never held for a human to approve later"), has never carried the parity string at any point in its history, and is correct prose outside this parity. The repo's real three-file convention — `ai-review-patterns.md` + the Captain Self-Check Preflight + the canonical reviewer role, stated at `:69` and `:299` — governs trap-family entries and is a DIFFERENT set of files; do not conflate them. So: if you make that sentence more precise, change BOTH copies of the pair together, or leave it. Third instance in this chain of an evidence sentence outrunning its check, after the "186" and "threshold" miscounts — recorded rather than quietly fixed. Scope: that one bullet's closing clause and this note. NOT re-verified here: the rest of the preflight list, the workflow-selection guidance, or the `covers:` targets. Prior: #2313: the Captain Self-Check Preflight's "approvals and pending actions" bullet listed `notification counts` and `single vs multi-approval behavior` as risk surfaces to review. Both name nothing the app can render: #2055 deleted the queue's routes and dropped `approval_requests`, `pendingApprovals` is a hardcoded 0 kept only for wire compatibility, and `multi-approval`/`multiApproval` appears in NO frontend or backend source — 0 hits from `/usr/bin/grep -rI -i` over `packages/frontend/src packages/backend/src`, against a control of 1479 hits for `approval` in that same scope. (The first version of this note cited a `threshold` control count that was filtered and not reproducible; reviewers caught it.) Re-based on the owner signatures that do exist — budget grant, revoke, re-key — deliberately matching the wording its sibling `.agents/skills/haven-agent-workflow/references/workflow-coordinator.md:43` already carries: the portable role file had been corrected and this canonical bullet had not, although this doc's own closing instruction says the three are maintained together. Scope: that one bullet. NOT re-verified: the rest of the preflight list, the workflow-selection guidance, or the other `covers:` targets. Prior: #1968: the PR-report list's "review status" item now names the per-pass verdict line, matching the PR template's Review Status section. The `haven-reviewer`-on-every-PR rule at §"Captain Self-Check Preflight" was read and is unchanged — this adds where the verdict is recorded, not whether the pass is required. Nothing else in this file re-verified. Prior: the independent reviewer pass is now unconditional and route-independent (owner decision 2026-08-21): "owning an equivalent review yourself" no longer reads as licence to self-review. The no-check-for-workflow property is unchanged — the new gate asks whether review happened, never which route ran.
---

# Haven AI Agent Workflow

This repo uses one main session as the captain and a few narrow subagents as specialists.

The captain is the main interactive session. It owns product judgment, git, shared files, final integration, and the branch or PR. Subagents are useful for isolated discovery, bounded implementation, and review.

> **What is enforced vs. what this document adds ([#1025](https://github.com/d-hinders/Haven-AI/issues/1025)).** The mechanical standards are **CI required checks**, and the migrations gate is a `CODEOWNERS` **review rule** — different mechanisms, same property: they apply to every pull request whoever or whatever opened it. Nothing in this document is needed to make them apply, and no workflow choice skips them. The authoritative list, with its fork and promotion caveats, is the ruleset inventory in [`autonomous-pr-loop.md`](autonomous-pr-loop.md).
>
> Everything below is the layer CI **cannot** check: judgement, review, and the traps a diff walks into. `ship-next` is the default route through it because it is the fastest one, not because it is required. Working differently is fine and stays possible — it means owning the equivalent judgement yourself, and saying so in the pull request. There is deliberately no check for which workflow was used: enforce outcomes, never tooling.
>
> **One item does not vary with the route: the independent reviewer pass runs on every pull request** (owner decision 2026-08-21; see `AGENTS.md` and CLAUDE.md § *How shipping is governed*). "Owning it yourself" means running `haven-reviewer` yourself, not reviewing your own diff — the author is the one person who cannot see the assumption they already made. This stays consistent with *enforce outcomes, never tooling*: `.claude/hooks/ship-next-guard.sh` gates on whether review HAPPENED, never on which workflow ran, and the route stays free.

## Default Delegation Policy

The captain decides whether the agentic flow is useful from the work itself. This document is the user's standing instruction to use subagents, delegated workers, and parallel delivery whenever the captain decides that is the best workflow. The user does not need to explicitly ask for agents, workers, subagents, or parallel delivery on every request.

For non-trivial feature delivery, UX feedback iteration, and bug fixing, use `haven-workflow-coordinator` by default before other agents. If the coordinator recommends explorer, worker, or reviewer agents, apply that plan without asking for another permission step. Inform the user briefly which agents are being used, what stays with the captain, and what checks are expected.

Skip subagents only when the work is trivial, when a tool or environment cannot support them, or when the coordinator decides the captain can deliver faster and safer alone. Do not say agents were skipped because the user did not explicitly ask for parallel agents.

## Recommended Sessions

Use one main Codex or Claude Code session per feature branch. Keep that session as the captain.

Open multiple full sessions only when the work is truly independent, such as separate branches or separate products. For one product feature, prefer one captain session with subagents.

## When To Skip The Agent Workflow

Keep tiny changes in the captain session when they are low risk:

- one file
- roughly fewer than 30 changed lines
- no behavior change
- no money movement or agent authority change
- no shared component, global style, package, lockfile, schema, or API contract change

Examples: copy fixes, small docs edits, a one-line display bug, or a local type cleanup. Even then, use judgment. If the tiny change touches money, permissions, approval states, or shared behavior, use the workflow.

## Review Lessons From Recent PRs

Use `docs/contributing/ai-review-patterns.md` as shared memory for recurring PR review issues that were relevant enough to fix.

Before final review, the captain should do a risk-specific self-check based on the changed surface:

- regulatory perimeter: for payment execution, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP, merchant, fiat/card, swap, yield, treasury, or advice surfaces, apply `docs/regulatory/casp-risk-guardrails.md`
- transactions and feeds: raw vs formatted values, totals, dedupe, pagination, source labels, and cross-surface consistency
- budget grants, revocation and re-key — the owner signatures that DO exist: status transitions, migrations or constraints, expiry, activation and replacement behavior, and post-action copy. Not a per-payment approval queue: an over-budget payment is declined on-chain, never held (#1440/#2055 deleted the queue, its routes and its table; `pendingApprovals` is a hardcoded 0 kept for wire compatibility, so "notification counts" and "single vs multi-approval behavior" name nothing the app can render)
- send, receive, contacts, and other modals: primary action hierarchy, scroll, z-index, close behavior, typing behavior, duplicate handling, and network context
- hooks, APIs, and shared utilities: required vs optional arguments, caller audits, response shape changes, fallback values, and non-happy-path tests
- multi-entrypoint flows: shared verified state, payload shape, and tests across HTTP headers, MCP tool arguments, SDK helpers, direct APIs, and demo surfaces
- credential and setup surfaces: one-time credential visibility, modal reset behavior, in-flight action reset, identifier entropy, and setup-copy consistency
- generated artifacts: credential files, SDK examples, demo scripts, and skill bundles stay aligned with current Haven capabilities, env vars, product language, and regulatory guardrails

After an agent or PR review, if a comment is both relevant and fixed, add the reusable pattern to `docs/contributing/ai-review-patterns.md`, the Captain Self-Check Preflight, and the canonical reviewer role together. Do not add one-off preferences or obsolete implementation details.

Workers can implement narrow slices, but the captain owns cross-surface consistency, shared abstractions, PR shape, final review judgment, and deciding which review comments become durable workflow memory.

## Captain Self-Check Preflight

Before opening or pushing a non-trivial PR, the captain runs this preflight. Each item is one grep or one quick read. The list maps the recurring trap families from `docs/contributing/ai-review-patterns.md` to the smallest check that would have caught each of them on the first push.

Run only the items that match the changed surface. Skip the rest.

- **Numeric Formatters.** If the diff touches `*-format.ts`, or any file using `BigInt`, `toFixed`, `formatUnits`, or `parseUnits`: confirm the file has tests for negative inputs, zero, scientific-notation strings, and both the raw-bigint and already-decimal input shapes.
- **Counter And Summary Buckets.** If the diff adds a counter, summary line, or breakdown (`X received · Y sent · Z failed`): confirm there is a test with at least one row that could plausibly fall into multiple buckets (failed-outbound, failed-inbound).
- **Conditional Copy Predicates.** If the diff adds a string like `"This will replace…"`, `"Update budget"` vs `"Add budget"`, `"Resume"` vs `"Start"`: confirm there are tests for the no-match and exact-match branches of the predicate, and confirm the predicate matches on precise identity (token address or symbol), not on a broadened layout-driven boolean.
- **Async Hook Requests.** If the diff changes a hook that fetches keyed data (address, chain, agent id, filters, or enabled state): confirm late responses from older keys cannot overwrite current state, and add a staggered-resolution test for the smallest risky key change.
- **Signer Readiness Gates.** If the diff changes wallet, passkey, `useActiveSigner`, `useSafeOperationGate`, `OnchainActionGate`, `WalletButton`, or wallet-approval copy: confirm gated actions do not treat `address` or `isConnected` alone as signer readiness. EOA readiness must match the signer hook's `address && walletClient` requirement, and tests should cover address-present / walletClient-missing with a visible recovery action.
- **Animation Discipline.** If the diff adds or moves CSS animations: confirm every animation-bearing class or declaration is gated by `@media (prefers-reduced-motion: no-preference)`, including pre-existing animations moved into a prominent placement. Keyframes may remain at top level. Confirm the animated element's className stack does not toggle one animation class while another remains.
- **Inline Gate Placement.** If the diff renders a separate `<OnchainActionNotice />`: confirm it sits **above** the action row, not inside the `flex-1` wrapper, and use `showNotice={false}` on `OnchainActionGate`. `NetworkGate` intentionally renders its mismatch hint and replacement network action in place; do not force it into the separate-notice pattern. Match the hoisted-notice layout in `EditAgentModal`.
- **Cross-Surface Display Drift.** If the diff changes a value rendered in 2+ surfaces (dashboard preview + detail card + agent page + transactions): confirm there is one shared formatter, that the input carries chain/token context, and that the API response includes the metadata each row needs.
- **Loading-State Inference.** If the diff infers onboarding or completion progress from a paginated preview list: reject and require an explicit `onboardingProgress.*` API field. Gate the dependent UI until **all** prerequisite hooks have resolved, not just the first one.
- **Multi-Entrypoint Parity.** If the diff changes a payment, x402/MPP, MCP, SDK, demo merchant, or hosted/local signing path: confirm every supported entrypoint uses the same validated payment state or has a parity test. Header, tool-argument, SDK helper, and direct API paths must not drift.
- **Credential And Modal Lifecycle.** If the diff changes one-time credentials, API key rotation, setup prompts, or modal actions: confirm plaintext credential state clears on close, in-flight flags reset on reopen, stale generated snippets cannot reappear, and failed actions do not leave a stuck spinner.
- **Identifier Entropy.** If the diff adds or changes a displayed key prefix, setup token prefix, invoice number, nonce, or visual identifier: confirm the displayed prefix has enough entropy for the population it identifies and has collision or duplicate handling where needed.
- **Credential Setup Copy.** If the diff changes setup copy, credential handoffs, signing-key guidance, or done-step instructions: confirm the copy is consistent across surfaces, leads with the user-facing safety property, and does not imply API credentials or Haven backend custody can spend.
- **Browser Or Headless Verification.** If browser verification is skipped for UI or routing changes: name the reason and add a headless equivalent that covers the skipped risk.
- **Green-Gate Evidence.** If you are about to record a gate as passing in the PR body: confirm the run actually saw the candidate diff. A check that reports on a file list can report success on an *empty* one, which reads identically to a clean pass — `node scripts/docs/coupling-gate.mjs` did exactly this when run before the commit, and "no covered docs implicated" went into #1076's Local Checks as evidence while a contract doc sat untouched. Run the strict, CI-equivalent form (`npm run docs:coupling`), and treat a gate that names zero inputs as unrun rather than green.
- **Pattern Absorption.** If the diff writes a markup shape a **second** time — the same header band, badge, row, empty-state, inline `<svg>`, or address-truncation you (or an existing file) already wrote — or re-creates something a `ui/`/`haven/` primitive already covers: extract it into a `ui/`/`haven/` primitive **and** add a `/design-system` entry, in this same PR. The trigger is the 2nd occurrence, not the 12th — this is what would have prevented every debt cluster #859 had to clean retroactively. The new primitive trips the design-system coupling gate (#898) by design, which is how the "add a DS entry" half is machine-checked. If extraction is genuinely premature (the two uses will diverge), say so explicitly rather than silently duplicating.

Run the matching items before invoking `haven-reviewer` so the reviewer finds fewer issues. If the reviewer surfaces a new trap family, add it to `docs/contributing/ai-review-patterns.md`, this preflight, and the reviewer agent's recurring-traps list together — the three should stay in sync.

If browser verification is skipped (preview environment unavailable, slow, flaky), pair the skipped visual check with at least one **headless equivalent** in vitest:

- Animation/style bugs: render assertion that the expected `className` is stable across state transitions.
- Cross-surface display drift: assertion that the same formatter is imported and produces the same output for the fixture.
- Loading-state flashes: assertion that the gated component does not render while any prerequisite hook is loading.

## Task Prompt Shape

When the user is planning work, help turn the request into this shape before implementation:

```text
Goal:
[What outcome should exist when this is done.]

Scope:
[What should be included.]

Out of scope:
[What should not be changed, even if nearby.]

PR shape:
[One PR / two PRs / roadmap first / follow-up PRs.]

Risk:
[Docs only / UI polish / shared behavior / money movement / agent authority / SDK or API contract.]

Workflow:
Use the Haven agent workflow. The captain owns product judgment, shared files, final integration, and merge-readiness judgment. Use subagents if they materially improve discovery, bounded implementation, or review.

Definition of done:
- PR opened
- relevant checks run
- review/risk summary included
- merge-readiness report included
```

Use this prompt shape especially when work could sprawl, when the user asks for a plan, or when multiple small PRs would be better than one broad branch.

## PR Closeout Contract

Every non-trivial PR should end with a concise closeout:

- changed files or surfaces
- workflow used, including agents used or skipped with reason
- checks run
- browser verification or the headless equivalent used when browser verification was skipped
- generated artifact and credential-handoff impact
- CASP/MiCA guardrail status when relevant
- what was intentionally left out
- review status, written as a **named verdict line per pass** — `haven-reviewer: passed |
  skipped because ___`, and the same for `haven-design-reviewer` on `area:frontend`
  ([#1968](https://github.com/d-hinders/Haven-AI/issues/1968)). The rule above binds either
  way; the line is what makes a skip visible, and `ship-next` will not arm auto-merge
  without it
- merge-readiness report

Use this merge-readiness format:

```text
Merge readiness:
- CI: passing / failing / pending
- Local checks: ...
- Review status: self-reviewed / reviewer-agent-reviewed / external reviewed / not reviewed
- Risk level: low / medium / high
- Why safe to merge: ...
- Residual risk: ...
- Recommended merge order: ...
```

When the user asks "is this safe to merge?", answer in this format. Do not treat green CI as the whole review for money movement, agent authority, generated credential artifacts, SDK payment APIs, x402/MPP, or shared contracts.

## Common PR Patterns

For broad cleanup or quality waves, prefer one or two focused PRs and then stop. If larger refactors remain, name them as a separate project rather than letting the cleanup wave expand.

For generated artifacts, pair implementation changes with output review. If SDK/API behavior, credential semantics, x402/MPP behavior, or product language changes, check generated credential files, `.env` examples, SDK snippets, demo scripts, and skill bundles.

## How To Create Or Invoke Agents

Canonical role instructions live in `.agents/skills/haven-agent-workflow/references/`. Every client should use those role contracts even when its delegation mechanism differs.

In Claude Code, `.claude/agents/` contains thin adapters with Claude-specific tool, model, and color metadata. Restart Claude Code after changing the adapters, or use `/agents` to manage them interactively. Invoke a role explicitly with prompts like `Use the haven-explorer agent...`.

In Codex and other clients with delegation support, ask the captain to spawn a read-only explorer, a bounded worker, or a reviewer and point it at the matching canonical role reference. When delegation is unavailable, perform a separate pass using the same role contract.

### Skill discovery verification

Portable project skills live under `.agents/skills/<name>/SKILL.md`. Run
`npm run docs:check` to verify their metadata, references, portable-language
boundary, and client-adapter targets.

Skill catalogs are loaded at session start. After adding or changing a skill:

- start a fresh Codex session rooted at the repository and invoke the skill by
  name with a no-mutation request;
- start a fresh Claude Code session and invoke the matching slash-command
  adapter with a no-mutation request;
- confirm the response follows the canonical skill's default and does not rely
  on workflow text copied into the adapter.

For example, ask `new-task` to report whether its default is backlog-only while
explicitly forbidding issue creation. This checks discovery and argument
forwarding without changing GitHub state.

Example:

```text
Use a read-only explorer agent to map the files and risks for [feature]. Then keep the main session as captain for the implementation plan and shared-file edits.
```

## Agents

### `haven-workflow-coordinator`

Use before any other agent at the start of non-trivial feature, UX iteration, or bug-fix work to choose the workflow, agent plan, file ownership boundaries, and expected checks.

Example:

```text
Use the haven-workflow-coordinator agent to choose the best agent plan for this feature. Return the work that should stay with the captain, proposed worker ownership boundaries, gravity files to avoid in parallel, expected checks, and risks.
```

### `haven-explorer`

Use for read-only mapping before a change.

Example:

```text
Use the haven-explorer agent to inspect the current agent budget UI and API flow. Do not edit files. Return relevant files, reusable components, test commands, and risks.
```

### `haven-ui-worker`

Use for one bounded frontend slice after assigning files.

Example:

```text
Use the haven-ui-worker agent to implement the empty and loading states for the agent budget panel.

Ownership:
- packages/frontend/src/components/haven/AgentBudgetCard.tsx
- packages/frontend/src/components/haven/__tests__/AgentBudgetCard.test.tsx

Create new files only if they are listed above. Do not edit globals.css, Tailwind config, package files, shared UI primitives, or route shells. Report any shared change you need.
```

### `haven-backend-worker`

Use for one bounded backend, SDK, API, policy, or test slice.

Example:

```text
Use the haven-backend-worker agent to add validation for over-allowance payment requests.

Ownership:
- packages/backend/src/routes/payments.ts
- packages/backend/src/routes/__tests__/payments.test.ts

Create new files only if they are listed above. Do not edit package files, lockfiles, or central shared types. Report any shared change you need.
```

### `haven-reviewer`

Use after implementation.

Example:

```text
Use the haven-reviewer agent to review the current diff for Haven product, UX, security, regression, and test risks. Findings first with file and line references.
```

### `haven-doc-reviewer`

Use after implementation when the diff touches code that some doc's `covers:` front-matter maps to (the coupling gate flags these on the PR). It reports specific stale, missing, or broken doc claims so the captain can update them before merge. The agent's findings are read-only suggestions, but **running it and acting on `covers:`-mapped findings is a hard definition-of-done step in the loop, not optional** — the captain must update the implicated docs (or genuinely re-verify and bump `last-verified`) in the same PR before opening it. Advisory here means the **docs↔code** coupling comment does not by itself block auto-merge (contract docs excepted), not that the step can be skipped. The *design-system* coupling gate is a different check and does block — see [`autonomous-pr-loop.md`](autonomous-pr-loop.md).

Example:

```text
Use the haven-doc-reviewer agent to check whether `git diff origin/dev...HEAD` has invalidated any docs that cover the changed code. Findings first with the exact stale claim and the smallest correct update.
```

## Default Feature Loop

The canonical `ship-next` skill follows the narrower autonomous issue-to-PR loop in `docs/contributing/autonomous-pr-loop.md`. Treat it as an explicit specialized exception to the coordinator/explorer sequence below; its gates and closeout contract take precedence when invoked. Claude Code exposes it through the thin `/ship-next` command adapter.

1. Start from a clean branch.
2. Use `haven-workflow-coordinator` for non-trivial work to choose the agent plan and ownership boundaries. This is a default workflow decision, not something that depends on the user explicitly asking for parallel agents.
3. Use `haven-explorer` for terrain mapping unless the change is trivial.
4. Have the captain make or approve the implementation plan.
5. Use at most one or two workers in parallel, only with disjoint ownership.
6. Keep shared files with the captain.
7. Integrate after each meaningful slice.
8. Run relevant build or test checks.
9. Run the **Captain Self-Check Preflight** above for the surfaces the diff touches. Pair any skipped browser verification with a headless equivalent vitest.
10. Ask `haven-reviewer` for a final diff review. Every pull request, unconditionally — the risk list this step used to carry was the licence for skipping it (owner decision 2026-08-21; `AGENTS.md` is canonical).
11. Ask `haven-doc-reviewer` for a doc-accuracy pass when the diff touches code mapped by some doc's `covers:` front-matter (the coupling gate flags these). Update the implicated docs before opening the PR.
12. Let the captain fix final issues, commit, push, and open the PR.
13. Add the PR closeout contract and merge-readiness report before calling the work complete.
14. If external review finds a relevant issue that gets fixed, update the reusable review pattern memory when the issue is likely to recur. Keep `docs/contributing/ai-review-patterns.md`, the Captain Self-Check Preflight, and the reviewer agent's recurring-traps list in sync.

## Files The Captain Should Usually Own

Avoid parallel edits to:

- `package.json`
- lockfiles
- `packages/frontend/src/app/globals.css`
- `packages/frontend/tailwind.config.js`
- shared UI primitives
- route and layout shells
- generated files
- central API clients or central shared types

If a worker needs one of these, it should report the need and let the captain make the change.

## Worktree Guidance

For a single Haven feature, prefer one branch and one captain session. Subagents should usually work inside that branch with narrow file ownership.

Use separate worktrees only when work can ship independently:

- two unrelated feature branches
- a spike that might be thrown away
- a risky refactor separate from product work
- long-running CI/debug work while product implementation continues

Avoid worktrees for multiple agents editing the same feature surface. That usually delays conflicts instead of removing them.

## Review Isolation ([#2455](https://github.com/d-hinders/Haven-AI/issues/2455))

An independent reviewer works from its own copy of the tree, so the builder can keep working without invalidating the verdict. **Make that copy with `git worktree add` or `git clone`. Never `cp -R` a worktree.**

`cp -R` is not a copy of a repository. A linked worktree's `.git` is a **file** containing `gitdir: <parent>/.git/worktrees/<name>`, and copying it copies the pointer — so the copy's HEAD, index and refs are still the builder's. Its **files** are frozen; its **git** is live. In one session that produced a blocking finding reporting a paragraph as reverted when it was untouched, and a caveat reporting assertions as stripped when they had been added — the same skew read in both directions ([#2415](https://github.com/d-hinders/Haven-AI/issues/2415), [#2444](https://github.com/d-hinders/Haven-AI/issues/2444), [#2421](https://github.com/d-hinders/Haven-AI/issues/2421)). Both reviewers behaved correctly; the mechanism misled them.

Restricting the reviewer's **paths** does not fix this, which is the part that is easy to get wrong: a `cp -R` copy reports its own path as `--show-toplevel` and stays inside it, and still reads the live tree. The property that has to hold is that the reviewer's **git view matches its file view**.

Check it rather than instruct it:

```bash
HEAD_SHA=$(git -C <review-root> rev-parse HEAD)
node scripts/ci/review-isolation.mjs <review-root> --builder <builder-tree> --expect-head "$HEAD_SHA"
```

It refuses a root that is not registered as a worktree at its own path (the `cp -R` case — such a copy is registered at the path it was copied *from*), the builder's own tree, a subdirectory, a baseline that lags the real remote, and a HEAD that is not the one under review. On acceptance it prints a contract — root, head, and a **frozen base SHA** with the three-dot diff command to use — which the reviewer quotes back in its verdict.

Two limits, stated because a guard whose limits are unwritten gets over-trusted:

- **It is not a sandbox.** Nothing here prevents a subagent `cd`-ing to the live worktree; this makes the claim checkable, not impossible to violate. Re-running the identical command after the pass returns, with the same `--expect-head`, is the evidence that the tree stood still — [#2415](https://github.com/d-hinders/Haven-AI/issues/2415) caught that drift by luck, and this is the command form of the same catch.
- **`--builder` is what makes "not the builder's tree" a check at all.** Omit it and that one line reports `[–] not asserted` with a caveat rather than a pass — the guard will not substitute the directory it happens to be running in. Round-one review of the change that added this file found exactly that fallback and it was removed; pass the flag.
- **A legitimate `git worktree add` shares its ref store with the parent**, so the builder fetching can advance `origin/dev` mid-pass. The guard says so in a caveat and hands out a frozen SHA precisely so a verdict never rests on a ref name. `git clone` is the stronger isolation where the cost is affordable.

## Scratchpad Naming ([#1801](https://github.com/d-hinders/Haven-AI/issues/1801))

**Every subagent in a session shares one scratchpad directory.** The scratchpad root is namespaced per *session*, not per agent, so two agents in the same session write to the same folder — and a generic filename is a silent overwrite between agents that never meet.

Measured in one working session: **477 entries**, containing `Sidebar.bak`, `Sidebar2.bak`, `Sidebar.tsx.bak` and `Sidebar.fixed` — four backups of one component, written hours apart by unrelated agents. The second agent to write `Sidebar.bak` hands the first one somebody else's file, and the restored working tree looks entirely healthy.

**Name every scratchpad file for the task, not for the file:**

| purpose | write | not |
|---|---|---|
| mutation backup | `Sidebar.tsx.1766.bak` | `Sidebar.bak` |
| PR body | `pr-1766.md` | `pr.md` |
| captured output | `1766-typecheck.txt` | `out.txt` |

Two rules that do not follow from the naming:

- **Verify a restore by content, never by exit code.** `cp` from the wrong backup succeeds. Check for a string the file should contain (`rg`), because "the command worked" and "the right bytes are back" are different claims. A backup also goes *stale behind you* — retake it after any change you mean to keep, or the restore silently reverts a reviewer's correction.
- **Nothing in CI can enforce this.** The scratchpad is outside the repo, so this is a convention held by reading it, not a gate. That is the reason it is written here rather than left implicit: the failure it prevents is invisible, produces a plausible artifact, and is caught only by someone noticing.

Why it matters beyond tidiness: a mis-attributed **PR body is prose**. It fails no check, looks well-formed, and gets merged — a diff carrying a confident description of work it did not do, which is worse than an empty body. The near-miss that produced this rule was a `pr.md` overwritten mid-flight, caught only because the author re-read it before publishing.

**Both logged instances describe the collision as coming from "another session"** — the #1798 near-miss and a second `pr-body.md` collision during #1826. Read literally that is impossible: session scratchpads are separate directories with no shared path. Both were **sibling subagents inside one session**, and the imprecise word is why the hazard looked like somebody else's problem twice. If you are about to write "another session" about a scratchpad collision, check whether you mean another *agent*.

Related, and genuinely cross-session rather than cross-agent: [#1800](https://github.com/d-hinders/Haven-AI/issues/1800), where `npm run screenshot` binds one port in every worktree, so a capture can show another branch's app.

## Common Captain Instructions

Paste this after any task-specific template below, or tell the agent to use `docs/contributing/ai-agent-workflow.md` when working inside this repo.

```text
Use the defined Haven agents to deliver this in the best way.

You are the captain. Own product judgment, implementation strategy, shared files, gravity files, git hygiene, final integration, and verification.

Follow the Haven agent workflow:

1. If the work is trivial, keep it in the captain session and explain why.
2. For non-trivial work, use haven-workflow-coordinator before any other agent to choose the agent plan, ownership boundaries, and expected checks. Do this by default; do not wait for the user to explicitly request agents or parallel workers.
3. Use haven-explorer for read-only discovery before implementation unless the change is trivial.
4. Decide whether this should stay in the captain session or be split across subagents.
5. If using workers, define explicit file ownership before they edit anything.
6. Use workers only for clean, disjoint implementation slices.
7. Workers may create new files only when those files are explicitly listed in their ownership scope.
8. Keep shared files in the captain session unless there is a strong reason not to.
9. Do not allow multiple agents to edit the same file or edit gravity files in parallel.
10. Ask workers to report needed shared changes instead of making them.
11. Integrate each slice before starting broad follow-up work.
12. Run relevant tests, type checks, builds, or browser checks when practical.
13. Run the **Captain Self-Check Preflight** for every changed surface, including a headless equivalent when browser verification is skipped.
14. Use haven-reviewer for a final diff review. Every pull request, unconditionally (owner decision 2026-08-21; `AGENTS.md` is canonical).
15. Use haven-doc-reviewer when changed code matches a document's `covers:` front-matter, and update any stale claims it identifies.

Gravity files the captain should usually own:
- package files
- lockfiles
- global styles
- Tailwind config
- shared UI primitives
- route and layout shells
- generated files
- central API clients
- central shared types

For UI work, enforce the Haven UI instructions from AGENTS.md:
- read the required UX and design docs
- inspect `/design-system` if it exists
- reuse existing primitives and Haven-domain components
- do not invent new card styles, spacing systems, shadows, radius, or typography unless necessary
- include empty, loading, error, and success states when applicable
- make money movement and agent authority clear
- use Haven product language
- hide technical wallet details from primary UX unless the surface is explicitly advanced or developer-facing
- review copy against the UX copy guidelines
- check mobile and desktop layouts when practical
- use `docs/contributing/ai-review-patterns.md` for known reviewer traps before final review
- use `docs/regulatory/casp-risk-guardrails.md` for payment, agent authority, Safe, relayer, SDK payment API, x402/MPP, merchant, fiat/card, swap, yield, treasury, or advice work

Before implementation, briefly tell me:
- which agents you will use, if any
- which work stays with the captain
- any worker file ownership boundaries
- what checks you expect to run
- whether browser verification, headless verification, generated artifacts, or CASP/MiCA guardrails apply

Then proceed with the work unless you find a real blocker. This update is informational, not a request for permission to use the agentic workflow.

Before calling the PR ready, include:
- changed surfaces
- workflow used, including agents used or skipped with reason
- checks run
- browser verification or headless equivalent
- generated artifact and credential handoff impact
- CASP/MiCA guardrail status when relevant
- what was intentionally left out
- review status, written as a **named verdict line per pass** — `haven-reviewer: passed |
  skipped because ___`, and the same for `haven-design-reviewer` on `area:frontend`
  ([#1968](https://github.com/d-hinders/Haven-AI/issues/1968)). The rule above binds either
  way; the line is what makes a skip visible, and `ship-next` will not arm auto-merge
  without it
- merge-readiness report with risk level, residual risk, and recommended merge order if multiple PRs are open
```

## Feature Delivery Prompt Template

Use this when you want the main session to act as captain and choose the right agents without you manually assigning them.

```text
Here is a new feature I want to build:

[Describe the feature, user problem, desired behavior, and any constraints.]

[Paste the Common Captain Instructions here, or say: Use docs/contributing/ai-agent-workflow.md and follow the Common Captain Instructions.]
```

## UX Feedback Iteration Prompt Template

Use this when you have feedback from yourself, users, design review, demos, screenshots, recordings, or product critique, and you want the main session to improve an existing flow.

```text
I want to improve the UX of this Haven flow:

[Name the flow, screen, route, or user journey.]

Here is the feedback/input:

[Paste feedback, notes, user quotes, screenshots, review comments, demo observations, or your own critique.]

Desired outcome:

[Describe what should feel clearer, faster, calmer, more trustworthy, more fintech-grade, or easier to complete.]

For the UX synthesis, tell me briefly:
- what feedback themes you found
- what product problems you think they reveal
- what you will change now
- what you are intentionally leaving out

Evaluate the changed flow against these questions:
- Is the user's next action obvious?
- Is the screen calm and scannable?
- Is money movement or agent authority clear?
- Is the risk/approval state honest without being alarming?
- Can the user pause, revoke, reject, stop, or recover where relevant?
- Does the copy use user-facing Haven language?
- Does the layout hold up on mobile and desktop?
- Are loading, empty, error, and success states handled?

[Paste the Common Captain Instructions here, or say: Use docs/contributing/ai-agent-workflow.md and follow the Common Captain Instructions.]
```

## Bug Fix Prompt Template

Use this when you have a bug report, failed test, console error, production issue, QA note, screenshot, or user-reported broken behavior, and you want the main session to analyze and fix it.

```text
I want to fix this Haven bug:

[Describe the broken behavior.]

Bug report / evidence:

[Paste user report, steps to reproduce, expected vs actual behavior, screenshots, logs, console errors, stack traces, failing test output, affected route, browser/device, account state, or environment.]

Desired outcome:

[Describe the correct behavior and any constraints, such as preserving existing UX/API behavior, avoiding schema changes, or keeping the fix small.]

For the bug triage, tell me briefly:
- what appears broken
- how you will reproduce or verify it
- likely root cause area
- expected checks

While fixing:
- prefer the smallest change that addresses the root cause
- avoid broad refactors unless the bug requires one
- preserve existing product language and design system patterns
- do not mask errors silently
- keep structured API errors where relevant
- never expose technical wallet details in primary UX unless the surface is explicitly advanced, account detail, transaction detail, or developer-facing

Before calling the work complete, report:
- root cause
- fix summary
- files changed
- verification run
- any residual risk or follow-up worth tracking

[Paste the Common Captain Instructions here, or say: Use docs/contributing/ai-agent-workflow.md and follow the Common Captain Instructions.]
```

## Good Worker Contract

```text
You own only:
- [file]
- [file]

You may create new files only if they are listed above.

Do not edit:
- package files
- lockfiles
- global styles
- Tailwind config
- shared UI primitives
- route shells
- files owned by another worker

Do not run git mutation commands. The captain owns branch, commit, push, and PR work.

If you need a shared change, report it instead of making it.
```
