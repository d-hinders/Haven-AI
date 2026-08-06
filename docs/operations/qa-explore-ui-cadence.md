---
owner: "@d-hinders"
status: current
covers:
  - .claude/commands/qa-explore-ui.md
last-verified: "2026-07-12"
---

# qa-explore-ui cadence — the UX-discovery heartbeat

Every other guard in the design-quality epic ([#904](https://github.com/d-hinders/Haven-AI/issues/904)) **prevents regression** — design-lint, the coupling gate, visual regression, copy-lint, the design reviewer. None of them **find** UX improvements. This runbook is the missing continuous-improvement heartbeat ([#903](https://github.com/d-hinders/Haven-AI/issues/903)): a recurring exploratory pass that surfaces friction, then feeds it into the backlog where `/ship-next` can burn it down.

It does **not** restate how the exploration works — that is the existing [`qa-explore-ui`](../../.claude/commands/qa-explore-ui.md) command (Layer 3 of the QA epic, #573/#579). This doc defines only the **cadence** and the **finding → backlog → ship-next loop** so it runs without bespoke prompting each time.

## Cadence

- **Frequency:** weekly (proposed). It is a discovery pass, not a deploy gate — the exact day doesn't matter; consistency does.
- **Trigger:** the owner arms a **Routine** (or runs it by hand) with the prompt in the next section. There is no CI job — this cadence is deliberately **non-gating** and must never block a promotion or a PR.
- **Target:** the deployed **dev** environment only — a non-production Vercel deployment built with `NEXT_PUBLIC_HAVEN_ENV=dev`, re-pointed at the shared dev backend per the `qa-explore-ui` command's Phase 1. Signed in as the seeded **QA user**, on Base Sepolia. Never prod, never a real user (see [`agent-qa.md`](agent-qa.md) → "QA identity, funding & secrets" and "Stable dev targets").

## Trigger prompt (arm this on the Routine)

> Run `/qa-explore-ui` against the dev dashboard. When it finishes writing its `docs/bug-reports/` findings report, triage each **material** finding into a backlog issue per the "Finding → backlog" rules in `docs/operations/qa-explore-ui-cadence.md`: dedupe against open issues, `/new-task` for genuinely new ones (`area:frontend`, backlog-only), and link every filed issue back from the report. Do not fix anything and do not submit any state-changing action in the app.

The `/qa-explore-ui` command owns the exploration, the safety rules (dev/testnet only, observe-don't-submit, secret-safety), and the report format. This runbook owns only what happens to the findings.

## Finding → backlog → ship-next loop

1. **Report first.** `qa-explore-ui` writes a run report under `docs/bug-reports/` (from `_run-report-template.md`). That report is the raw output; it is not itself the backlog.
2. **Triage each finding for materiality.** A *material* finding is a real UX/layout/console/dead-end/clarity problem a user could hit — not a subjective taste call, not a duplicate of a known issue, not a transient dev-data artifact. Drop the rest; note in the report that they were considered and dropped.
3. **Dedupe against open issues before filing.** Search open issues (`gh issue list --search "<surface/keywords>"`) for a materially equivalent report. If one exists, add a comment linking the new evidence instead of opening a duplicate.
4. **File genuinely-new findings with [`/new-task`](../../.agents/skills/new-task/SKILL.md)** — backlog-only (no `code-quality`), labeled `area:frontend` (add `money-path` only if the finding is on a money-movement surface, which routes it through `money.md` and its characterization-test bar). Let `new-task` write the Scope / Acceptance / Files / Surface fields; seed it from the report row (surface, expected vs actual, evidence).
5. **Link back.** Every filed issue is linked from the run report's findings table, so the report is the audit trail of what became an issue and what was dropped.
6. **Burn down separately.** The backlog issues are now ordinary `/ship-next` candidates — `ship-next` picks them up when they're queued (add `code-quality` or make them epic sub-issues). The cadence never ships its own findings; discovery and delivery stay decoupled.

## Guardrails (non-negotiable)

- **Non-gating.** This cadence produces backlog issues, never a pass/fail signal. It must not be wired as a required check or block any promotion.
- **Testnet / dev only.** Base Sepolia, the seeded QA user, a `NEXT_PUBLIC_HAVEN_ENV=dev` build re-pointed at the dev backend. If the app shows a prod build or unexpected data, **stop and report** — do not explore an unknown environment (the `qa-explore-ui` Phase 2 check).
- **Observe, don't act.** The exploration never completes the connect-agent flow, approves/rejects, or sends a payment — the dev QA identity is shared with the deterministic harness, and a stray submit mutates state other runs depend on.
- **Secret-safety.** Never paste JWTs, cookies, setup tokens, API/private keys, or `Authorization` headers into a report, an issue, or an artifact — the report's secret-review step gates the commit.

## Related

- [`qa-explore-ui`](../../.claude/commands/qa-explore-ui.md) — the exploration command this cadence schedules.
- [`agent-qa.md`](agent-qa.md) — QA identity, funding, secrets, and stable dev targets.
- [`e2e-qa-runbook.md`](e2e-qa-runbook.md) — the deterministic (Layer 1/2) QA that *does* gate, for contrast.
- [`new-task`](../../.agents/skills/new-task/SKILL.md) / [`ship-next`](../../.agents/skills/ship-next/SKILL.md) — the backlog-file and burn-down halves of the loop.
