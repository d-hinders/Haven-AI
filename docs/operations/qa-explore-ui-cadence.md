---
owner: "@d-hinders"
status: current
covers:
  - .claude/commands/qa-explore-ui.md
  - .claude/commands/qa-explore-agent-onboarding.md
last-verified: "2026-09-06" # #2538 (follow-up): EDITED, scope = one new subsection under § Cadence, "Whether a Routine is armed is NOT readable from this repository". The doc said "the owner arms a Routine" in three places and never said that the arming state is invisible from the tree, so a reader had no way to distinguish never-armed from armed-and-silent — which is exactly what happened: specified and closed 2026-07-12, zero run reports and zero filed findings by 2026-09-06. Measured three independent ways before writing it (the `bug-reports/` listing on `dev`; a search of open and closed issues for a finding filed by a run; the absence of any scheduled task at all). Names the committed dated run report as the only observable signal, and states the corollary for prompt authors — a run that cannot proceed reports that as its RESULT, so silence keeps meaning one thing. Two Routines were armed on 2026-09-06, which this note deliberately does NOT record as a fact about the repo: it would be an unverifiable claim of exactly the kind the subsection warns against. Scope: that subsection. NOT re-verified: § Cadence's own bullets, the trigger prompts, the finding→backlog loop, the guardrails, or the second-scenario section. Prior: #2538: EDITED, scope = the new § "Second scenario — agent-onboarding-cold" and one `covers:` entry. The cadence gains a second discovery pass on the same weekly/non-gating/dev-only shape; the scenario and rubric live in `.claude/commands/qa-explore-agent-onboarding.md`, so this section owns only the cadence and how to read the scores. Two things measured rather than asserted while writing it. First, the discovery chain to `/for-agents.md` is REDUNDANT — the landing `<link rel="alternate">` reaches it via `llms.txt:11`, `robots.txt` names it outright (`buildRobotsTxt` in `lib/discovery-surfaces.ts`), and `sitemap.xml` lists it — which is why score 1 records the shortest route USED rather than arrival: an arrival-only score cannot fall when one hook is removed, so it would be blind to the regression this scenario exists to catch. Second, the issue asks for a `workflow_dispatch` + weekly cron in `.github/workflows/qa-explore-ui.yml`; that file does not exist and its absence is this doc's own § Cadence decision, so the section keeps the owner-armed Routine shape and states the scenario-specific reason too (a cold agent cannot be cold inside this repo's runner). Escalated on the issue rather than reversed quietly. Scope: that section and the `covers:` addition. NOT re-verified: § Cadence, the finding→backlog loop, the cadence-wide guardrails, or the qa-explore-ui trigger prompt.
---

# qa-explore-ui cadence — the UX-discovery heartbeat

Every other guard in the design-quality epic ([#904](https://github.com/d-hinders/Haven-AI/issues/904)) **prevents regression** — design-lint, the coupling gate, visual regression, copy-lint, the design reviewer. None of them **find** UX improvements. This runbook is the missing continuous-improvement heartbeat ([#903](https://github.com/d-hinders/Haven-AI/issues/903)): a recurring exploratory pass that surfaces friction, then feeds it into the backlog where `/ship-next` can burn it down.

It does **not** restate how the exploration works — that is the existing [`qa-explore-ui`](../../.claude/commands/qa-explore-ui.md) command (Layer 3 of the QA epic, #573/#579). This doc defines only the **cadence** and the **finding → backlog → ship-next loop** so it runs without bespoke prompting each time.

## Cadence

- **Frequency:** weekly (proposed). It is a discovery pass, not a deploy gate — the exact day doesn't matter; consistency does.
- **Trigger:** the owner arms a **Routine** (or runs it by hand) with the prompt in the next section. There is no CI job — this cadence is deliberately **non-gating** and must never block a promotion or a PR.
- **Target:** the deployed **dev** environment only — a non-production Vercel deployment built with `NEXT_PUBLIC_HAVEN_ENV=dev`, re-pointed at the shared dev backend per the `qa-explore-ui` command's Phase 1. Signed in as the seeded **QA user**, on Base Sepolia. Never prod, never a real user (see [`agent-qa.md`](agent-qa.md) → "QA identity, funding & secrets" and "Stable dev targets").

### Whether a Routine is armed is NOT readable from this repository

A Routine lives in the owner's client, not in the tree. Nothing here — no file,
no workflow, no check — can tell you whether one exists, when it last fired, or
whether it fired and produced nothing. **The only observable signal is a
committed run report under [`../bug-reports/`](../bug-reports/)**, dated.

That is not a footnote. This cadence was specified and its issue closed on
2026-07-12, and by 2026-09-06 it had produced **zero** run reports and zero
backlog findings — measured three ways: the `bug-reports/` directory held only
the template and two one-off records; no open or closed issue was a finding
filed by a run; and no scheduled task existed at all. Nobody noticed for two
months, because *never armed*, *armed but never fired* and *fired and found
nothing* are indistinguishable from inside the repo.

So: **read the reports, not the intention.** If the newest report under
`bug-reports/` for a scenario is older than a couple of weeks, the cadence is
not running, whatever anyone believes about it — and a run that finds nothing
still writes a report saying so, precisely so silence keeps meaning one thing.

A second consequence, for whoever writes the trigger prompts: a run that cannot
proceed must say so **as its result** rather than exiting quietly. `qa-explore-ui`
needs the seeded QA user's credentials, which an unattended run may not have; its
prompt makes that check the first step and reports *blocked on credentials*
rather than producing nothing. A blocked report is a signal. No report is not.

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

## Second scenario — agent-onboarding-cold (#2538)

The cadence runs **two** discovery passes on the same weekly, non-gating, dev-only
shape. `qa-explore-ui` explores the signed-in dashboard. **agent-onboarding-cold**
measures the other direction: whether an agent that has never seen Haven can get its
user set up. That is the path epic [#2519](https://github.com/d-hinders/Haven-AI/issues/2519)
exists to make work, and the [A0 baseline](../bug-reports/agent-first-cold-test-2026-09-04.md)
is the one measurement of it that exists.

The scenario, the guardrails and the scoring rubric live in
[`qa-explore-agent-onboarding`](../../.claude/commands/qa-explore-agent-onboarding.md),
next to the command it parallels — not in this runbook and not in a workflow file. This
section owns only the cadence and how to read the scores.

### Trigger prompt (arm this on a second Routine)

> Run `/qa-explore-agent-onboarding` against the dev preview URL. Give the cold agent
> that URL and the instruction "set it all up so my agent can pay for things", and
> nothing else — naming a path in the prompt invalidates score 1. Write the report to
> `docs/bug-reports/`, then triage material findings per the "Finding → backlog" rules
> in `docs/operations/qa-explore-ui-cadence.md`. Do not fix anything, and do not approve,
> pay, or enter any credential.

### The fetch-first rule

The agent is given **the landing URL only**. Score 1 asks whether it reached
`/for-agents.md` by following hooks the served HTML and `robots.txt` advertise, rather
than by guessing the convention — which is exactly what the A0 run had to do, because in
September 2026 the head carried a `<meta description>` and nothing else. **If the prompt
names a path, score 1 measures the prompt.** That is the one way to invalidate this
scenario, so it is stated here as well as in the command.

### How to read the four scores

None of them means anything alone. Each is reported beside the previous run and A0, and
**a moved score is the finding** — a stable one is the cadence doing its job.

| Score | What a drop means |
|---|---|
| **1. Discovery (0–3)** | A hook regressed. 3 = found from the landing HTML alone; 2 = via `robots.txt`/`sitemap.xml`; 1 = guessed a path (the A0 behaviour); 0 = never found. |
| **2. First reply** | The agent named fewer than the four human-only steps. The user is then stuck at the one it dropped, with an agent that believes setup is done. |
| **3. Tool calls to the login wall** | Only meaningful as a diff. A rise means the path got longer, not that the agent got worse. |
| **4. The two commands** | `haven login` (C1/#2526) and `haven agents connect` (C2/#2527), scored correct/wrong/not attempted with the verbatim command. Nearly right is wrong: the user pastes it. |

**Why score 1 has four bands rather than the issue's three.** The hooks are redundant —
`/for-agents.md` is reachable from the landing `<link rel="alternate">` → `llms.txt` →
its link, from `robots.txt`, which names it outright, and from `sitemap.xml`. A score
that only asks *did it arrive* cannot fall when one hook is removed, because the agent
uses another. It would be insensitive to the regression the scenario exists to catch,
which is why the band records the shortest route **used**, not the arrival.

### Guardrails specific to this scenario

Beyond the cadence-wide rules below: the agent **never** enters a password, creates a
passkey, approves a budget, or submits a payment. Those are the human's, always — the
standing owner constraint of 2026-09-04 and the invariant the epic rests on. It stops at
each and writes the hand-off message it would have sent; those messages are the report's
most useful content, because they are what the user would actually have received.

### Who runs it

The same way `qa-explore-ui` runs: **the owner arms a Routine.** There is no CI job, for
the reason in § Cadence above and for one specific to this scenario — **a cold agent
cannot be cold inside this repository's own runner.** Score 1 is only valid if the agent
does not know the path, and a job in Haven-AI's Actions has the checkout and a token in
its environment. You can skip the checkout; you cannot make the measurement robust,
because a later edit to the workflow could hand the agent repo knowledge and the score
would keep reporting a number that no longer means what it says.

## Guardrails (non-negotiable)

- **Non-gating.** This cadence produces backlog issues, never a pass/fail signal. It must not be wired as a required check or block any promotion.
- **Testnet / dev only.** Base Sepolia, the seeded QA user, a `NEXT_PUBLIC_HAVEN_ENV=dev` build re-pointed at the dev backend. If the app shows a prod build or unexpected data, **stop and report** — do not explore an unknown environment (the `qa-explore-ui` Phase 2 check).
- **Observe, don't act.** The exploration never completes the connect-agent flow, approves/rejects, or sends a payment — the dev QA identity is shared with the deterministic harness, and a stray submit mutates state other runs depend on.
- **Secret-safety.** Never paste JWTs, cookies, setup tokens, API/private keys, or `Authorization` headers into a report, an issue, or an artifact — the report's secret-review step gates the commit.

## Related

- [`qa-explore-ui`](../../.claude/commands/qa-explore-ui.md) — the exploration command this cadence schedules.
- [`agent-first-cold-test-2026-09-04.md`](../bug-reports/agent-first-cold-test-2026-09-04.md) — the **A0 baseline** for the cold-agent onboarding scenario ([#2538](https://github.com/d-hinders/Haven-AI/issues/2538)), a second discovery pass that joins this cadence: same weekly, non-gating, dev-only shape, but scored against that run rather than exploring the signed-in dashboard.
- [`agent-qa.md`](agent-qa.md) — QA identity, funding, secrets, and stable dev targets.
- [`e2e-qa-runbook.md`](e2e-qa-runbook.md) — the deterministic (Layer 1/2) QA that *does* gate, for contrast.
- [`new-task`](../../.agents/skills/new-task/SKILL.md) / [`ship-next`](../../.agents/skills/ship-next/SKILL.md) — the backlog-file and burn-down halves of the loop.
