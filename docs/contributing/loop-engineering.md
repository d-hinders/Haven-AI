---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/loop-harness/**
  - packages/backend/package.json
  - packages/frontend/src/lib/loop-harness/**
  - packages/frontend/package.json
  - .github/workflows/ci.yml
  - docs/contributing/autonomous-pr-loop.md
  - docs/contributing/code-quality-loop.md
last-verified: "2026-07-01"
---

# Loop Engineering (oracle-grounded automated loops)

Last updated: 2026-07-01

> **Disambiguation.** Haven uses “loop” in three ways:
> [`code-quality-loop.md`](./code-quality-loop.md) is a human-curated discovery
> method whose actionable queue is GitHub Issues;
> [`autonomous-pr-loop.md`](./autonomous-pr-loop.md) describes the issue-driven
> `/loop /ship-next` workflow; and this doc is about
> **automated, oracle-grounded loops**: a coding agent generates adversarial
> inputs, grades them against an independent oracle, and converges on fixes —
> leaving behind a permanent differential test. They compose, but they are
> different tools.

## 1. The core idea: a loop is a verb that leaves a noun

"Loop" is overloaded. Keep two things separate:

- **The loop = an activity** (a verb). An oracle-grounded improvement campaign a
  coding agent drives: *generate adversarial cases → grade against an oracle →
  fix divergences → lock each fix in*. It runs for a session, **converges**, and
  ends. It is work, not a file.
- **The harness = the residue** (a noun). When the loop converges, what stays in
  the repo is ordinary test code — a reference model + generators + a
  differential test + regression guards. It runs in CI forever as a regression
  and drift guard.

So a loop is a *pentest, not a smoke alarm*: a directed campaign you point at a
surface to harden it; the lasting value is the patched code plus the guard it
leaves behind. You don't run the campaign forever — you run it when you want to
harden an area, and the guard keeps watch after.

## 2. The precondition: no oracle, no loop

A loop only works where there is a **mechanical way to decide "is this output
correct?" without a human eyeballing it.** That is the *oracle*. It can be:

- a **reference model** (a small independent re-derivation of the intended
  behavior — what both allowance loops use),
- the **real artifact** (a forked-chain contract, a second implementation),
- an **invariant** ("an over-budget intent never auto-executes"),
- a **spec** (OpenAPI, a state machine).

If you cannot name the oracle, you do not have a loop — you have hand-written
tests. Surfaces with no checkable notion of "correct" (pure UX judgment, business
logic without a spec) are **not** loop targets; improve them another way.

The strongest signal a surface deserves a loop: **logic that mirrors or predicts
some source of truth** (an off-chain copy of on-chain state, a cache of a remote
value, a re-implementation that must agree with a contract). Those drift; the
loop pins the drift.

## 3. Loop shapes

Same discipline, different oracle:

| Shape | Oracle | Example in Haven |
| --- | --- | --- |
| **Differential** | a reference model / the real artifact | `computeEffectiveAllowance` vs the AllowanceModule reset model (backend + frontend) |
| **Property / invariant** | an asserted rule over fuzzed inputs | "over-remaining intent ⇒ `pending_approval`, never `executed`" |
| **Eval** (future) | a grading rubric | an LLM-assisted feature graded against expected outputs |

This doc's worked examples are **differential** loops; the structure generalizes.

## 4. Anatomy of a harness

The template, as instantiated twice today
(`packages/backend/src/loop-harness/`,
`packages/frontend/src/lib/loop-harness/`):

```
loop-harness/
  README.md                      # why this loop exists + findings log
  reference-<thing>.ts           # the ORACLE: independent re-derivation of correctness
  generators.ts                  # seeded, deterministic adversarial case generation
  <thing>-differential.test.ts   # equivalence ratchet + regression guards
```

- **Reference model** — the smallest faithful port of the intended behavior,
  derived independently from the source of truth (e.g. the contract). Document
  where it comes from. Note honestly if it is not machine-certified against the
  real artifact.
- **Generators** — a tiny seeded PRNG (e.g. `mulberry32`), biased toward the
  interesting regions (boundaries, edge magnitudes). Every case carries its
  `seed`.
- **Differential test** — two sections:
  1. *equivalence ratchet*: N fuzzed cases assert mirror == oracle. The green
     baseline; if it goes red, behavior drifted.
  2. *regression guards*: converged findings kept permanent.

**Testability is part of the fix.** If the logic under test reaches for ambient
state (`Date.now()`, a global), make it injectable (pass the value in) so the
loop can drive it. Both allowance loops turned an internal `Date.now()` into an
explicit `nowSec` parameter — that change *is* what made the bug fixable and
guardable.

## 5. Determinism is non-negotiable

A divergence reported on iteration N must be replayable on iteration N+1 so a fix
can be verified. Therefore:

- Generate cases from a **seed**, never `Math.random()`.
- Do **not** anchor generated inputs to wall-clock time. Use a fixed epoch
  constant (see `generators.ts` `BASE_NOW_MIN`) so a reported `seed` reproduces
  the same case months later.
- Surface the `seed` (and the minimal inputs) in the failure message.

## 6. Convergence model

A loop has a terminal state, and the harness encodes it:

- **Green ratchet** — the equivalence test stays green; every iteration that
  finds nothing still hardens confidence.
- **Finding lifecycle** — a fresh divergence can be parked as `it.fails` (passes
  while the defect exists; *fails* once fixed — the signal it converged). On
  convergence, promote it to a **permanent regression guard** that fails if the
  defect ever returns. (Both allowance loops did exactly this: the wall-clock
  `it.fails` became a "reset decision tracks chain time" guard.)
- **Terminal state** — green ratchet + zero open findings. The loop on that
  surface is *converged*; the harness now works only as a sentinel.

## 7. Guardrails

- **Pin the oracle/invariants in reviewed code; never let the agent "fix" a
  failure by weakening the assertion.** That is the classic reward-hack. The
  oracle is the contract; only humans change it.
- **Financial surfaces:** run against a simulated/forked chain or a faithful
  mock, never live funds. The loop produces *tests + a fix branch* — **no
  auto-merge of money-moving code.** A human gates the merge.
- **Bound the campaign:** cap iterations and diff size so a stuck loop surfaces a
  "stuck, here's my diagnosis" report instead of a sprawling refactor.
- **Classify the value honestly.** These allowance loops are *reliability /
  state-correctness* loops, not fund-safety loops — the on-chain module enforces
  the hard limit. Know which kind you are running.

## 8. Running and scheduling

- Focused run:
  - Backend: `npm --prefix packages/backend run test:loop`
  - Frontend: `npm --prefix packages/frontend test -- src/lib/loop-harness`
- The harness lives under the package's normal test glob, so it runs whenever
  CI's change detection selects that package's unit-test job.
- As a recurring *active* campaign (only worth it while editing that surface or
  to widen coverage — re-running identical seeds on frozen code is a no-op):
  ```
  /loop 30m npm --prefix packages/backend run test:loop
  ```
  To widen coverage, bump the base seed in the differential test.

## 9. Division of labor — and handing a loop to another agent

The judgment does not automate; the mechanics do.

- **Human (or captain) owns:** choosing a surface that *has* an oracle, and
  *defining* that oracle. This is the high-value, non-transferable part.
- **The implementing agent owns:** building the harness to the template once the
  target and oracle are named.

Any capable coding agent (Codex, another Claude session, Cursor) can replicate
the pattern from this repo — the two `loop-harness/` dirs are worked examples and
this doc is the spec. Give it an explicit prompt, not "go find loops":

> Replicate the loop-harness pattern in `packages/*/src/loop-harness`
> (see `docs/contributing/loop-engineering.md`) for **<target file/function>**,
> using **<named oracle>** as ground truth. Add a seeded differential test with
> an equivalence ratchet and regression guards, and a README findings log.
> Make the logic time-injectable if it reads ambient state. Do not weaken the
> oracle to make tests pass.

Turning an agent loose to *discover* loops is the failure mode: without a chosen
oracle it tends to pick oracle-less surfaces and write tests that assert current
behavior (reward-hacking) rather than independent truth.

## 10. Checklist for defining a new loop

1. **Target**: which logic mirrors/predicts a source of truth and is bug-prone?
2. **Oracle**: what independently decides "correct"? If you can't name it, stop.
3. **Value class**: reliability, correctness, or safety? Set expectations.
4. **Testability**: does the logic need to be made injectable (no ambient state)?
5. **Generators**: seeded, deterministic, boundary-biased, no wall-clock anchor.
6. **Guards**: park findings as `it.fails`, promote to regression guards on fix.
7. **Guardrails**: simulated chain for money paths; oracle pinned; tests-only.
8. **Register it** in [`loop-harness-index.md`](./loop-harness-index.md).

## See also

- [`loop-harness-index.md`](./loop-harness-index.md) — the portfolio of live loops.
- `packages/backend/src/loop-harness/README.md`,
  `packages/frontend/src/lib/loop-harness/README.md` — worked examples.
- [`ai-agent-workflow.md`](./ai-agent-workflow.md) — the broader agentic delivery workflow.
