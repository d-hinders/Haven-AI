---
owner: "@d-hinders"
status: current
covers:
  - packages/qa-agent/src/evals/**
  - packages/qa-agent/src/evals/tasks/*.json
  - packages/qa-agent/src/evals/cli.ts
  - packages/qa-agent/src/evals/runner.ts
  - packages/qa-agent/src/evals/graders.ts
  - packages/qa-agent/src/evals/hermes.ts
  - packages/qa-agent/src/evals/claude-code.ts
  - packages/qa-agent/src/evals/summary.ts
  - .github/workflows/agent-evals.yml
  - packages/mcp-server/src/server.ts
  - packages/mcp-server/src/boot.ts
  - packages/sdk/src/skill-content.ts
  - packages/sdk/src/agent-guidance.ts
  - packages/signer/src/tools.ts
  - packages/signer/src/server.ts
  - packages/qa-agent/src/seed.ts
  - packages/qa-agent/src/config.ts
  - packages/qa-agent/src/lib/chain.ts
  - packages/connect/src/args.ts
  - packages/connect/src/server-names.ts
  - packages/signer/src/consent.ts
  - packages/signer/src/cli-args.ts
last-verified: "2026-10-20"
---

# Agent Evals — the model-in-the-loop eval suite (epic #3957)

The agent evals run a REAL model agent against the dev environment and grade
what it actually did: its tool-call log, the dev backend, and Base Sepolia.
This is the layer the deterministic money-flow harness (`docs/operations/agent-qa.md`)
deliberately does not cover — that harness has no LLM in it. Slice 1 (#3958)
builds the harness-neutral core: the task format, the graders, ~11 starter
tasks and the Hermes runner. Slice 2 (#3959) adds a Claude Code adapter that
reuses the task format and graders unchanged.

Everything here runs on **Base Sepolia test USDC against the shared dev
backend**. No payment code is changed by this suite; the graders only READ.

## The pieces

| Piece | Where | What it is |
|---|---|---|
| Task format | `packages/qa-agent/src/evals/types.ts` | One JSON file per task: the instruction, the setup it needs, the budget-aware amount rule, and the graders to apply. JSON, never Markdown. |
| Graders | `packages/qa-agent/src/evals/graders.ts` | Read the recorded tool-call log + injected chain/backend probes. No model, no live agent. |
| Tool lists | `packages/qa-agent/src/evals/tools.ts` | The 29 hosted tools, split into the explicit 9-tool payment list and the 20 non-payment tools, and the 5 signer tools. `tools.test.ts` holds them equal to their upstream sources (#4121): the keys of the hosted tools/list snapshot (`tools-list.snapshot.json` in the mcp-server package) and of the signer's `toolSchemas`. A hosted tool in neither half fails as unclassified. Graders match BARE tool names + `next_tool_server_role`, never the server-prefixed name. |
| Starter tasks | `packages/qa-agent/src/evals/tasks/*.json` | 11 tasks across direct-payment / x402-paywall / over-budget, each citing its source. |
| Hermes adapter | `packages/qa-agent/src/evals/hermes.ts` | Runs one task through Hermes, collects the tool-call log, parses it into the grader model. |
| Runner | `packages/qa-agent/src/evals/runner.ts` + `cli.ts` | k trials per task, applies graders, writes JSON report + readable summary with per-task pass rate, pass^k and wall time per session. Resolution is PER TRIAL (#3992 A2): the CLI injects a resolver that reads the budget + observer block immediately before each trial. |
| Compare | `packages/qa-agent/src/evals/compare.ts` | The regression-only compare (#3992 D): the new report vs earlier comparable reports, alerting only after two consecutive pass^k failures on a 5-of-7 baseline. |

Amounts are **budget-aware and per-trial** (#3958 § 4, re-scoped by #3992
A2): the amount is resolved from a LIVE read of the remaining period budget
**immediately before each trial** — not once at launch — by the resolver the
CLI injects into the runner. Each trial's record carries its own resolved
amount and its own observer start block, and every grader's evidence is
scoped to that trial: chain probes read from the trial's start block and
payment ids come from the trial's own log, so no trial can pass on an
earlier trial's (or an earlier task's) transfer.

Success tasks take a **slice** of the remaining budget
(`fraction_of_remaining`, floored), so the k trials of a slice task shrink
geometrically instead of summing to k×R/4 — the old launch-once resolution
made 3 trials of a `1/4` task cost 225% of the budget and turned every
later slice into a refusal. Full-remaining sends
(`remaining_period_budget` with `delta_atomic: 0`) and over-budget tasks
(remaining + 1 USDC) are the exceptions, on purpose. The read is refused,
not guessed, when the chain/backend does not supply the number — the #2016
discipline; a mid-run resolve failure is a RED TRIAL with the named cause,
not an exit, and the run finishes and reports.

**Ordering tiers** (#3992 A3) come from the task files' `tier` field, not
the category: tier 1 = budget-preserving tasks in file order; tier 2 = THE
budget drainer (`direct-send-full-remaining`), which runs **exactly one
trial** regardless of `--trials` (after it there is nothing left to drain)
and is marked `k=1 (drains budget)` in the report so its pass^k is never
compared with the k-trial tasks; tier 3 = tasks whose precondition is an
EXHAUSTED budget (`over-budget-x402-refused`), which run AFTER the drainer
and read the budget with exhaustion tolerated (`exhausted-ok` — an exhausted
read is their expected setup, not an error). `--shuffle=<seed>` shuffles
WITHIN tiers only (deterministic per seed, recorded in the report);
`--limit` slices the canonical order BEFORE any shuffle, so the workflow's
5-task subset is stable, and `--task=<id>[,…]` selects tasks BY ID from the
same canonical set — tier order and any `--shuffle` are preserved (#4218,
see Other flags).

**Two lessons from 2026-10-23 (run 39914610364).** A wait that times out
makes ONE trial red: later trials do not wait on the same expectation again,
and the skip is recorded in the report (`guardEvents`); that run lost four
whole tasks to one unmet wait repeated thirteen times. The unmet wait itself
came from an **idempotent replay**: trials 2 and 1 of the bridge task bought
the same item inside Haven's 5-minute idempotency bucket, so trial 2's pay
call returned trial 1's payment (`idempotent_replay: true`) and spent
nothing, yet graded green with trial 1's spend. The graders now reject a
trial whose only payment is a replay, and purchasing tasks give each trial
its own key with the `{purchase_key}` placeholder.

**Consistency guard:** before resolving each trial, the resolver waits
(bounded, 120s default) until the backend budget read reflects the previous
trial's settled spend — `/allowances` can lag the observer node. When the
previous trial's settled spend IS its resolved amount (the direct sends), the
guard expects that exact drop. When the task is marked
`settled_amount_unknown` (`x402-catalog-guided-purchase`, #4071 — the agent
buys whatever the catalog prices, so the spend size is the merchant's, not
the resolver's), the guard expects ANY decrease instead: deducting the
resolved amount would invent a drop that never happened and red every later
trial (the 2026-10-17 run: resolved 316406, actually spent 1000, four
innocent trials timed out). A budget INCREASE observed between trials is
recorded in the report as a refill boundary event (`budgetEvents`), which is
how a run that crosses the Daily period's refill anchor reports itself. On
guard timeout the trial is red with the named cause.

Size the eval agent's budget as a **Daily** period (see "Funding and the
nightly budget" below) so the tiered run fits inside one refill.

## Provisioning: connect, not seed.ts

The eval agent is created through the connector on a **dedicated eval user
and account**, NOT through `packages/qa-agent/src/seed.ts` (that one
hard-codes `'QA Agent'`, grants an open budget, prints the API key once and
wires no runtime):

```
npx @haven_ai/connect@<channel> --runtime hermes --setup hv_setup_...
```

`--setup` is required (it is refused without it, `packages/connect/src/args.ts`).
Run the connector inside an isolated Hermes profile (`HERMES_HOME=<dir>`) so
the partner's own Hermes setup is untouched. The setup token is one-time and
comes from the dashboard; the signing key is generated ON the partner's
machine and never travels.

## Every credential this setup puts on the partner machine

1. **The Hermes `.env` API key line.** The hosted MCP pair's key is written
   to the isolated profile's dotenv file as
   `MCP_HAVEN_<SLUG>_API_KEY=<sk_agent_...>` (the env key is derived from the
   wiring slug, `packages/connect/src/server-names.ts`). On a non-production
   backend the pair name is derived (`haven-<slug>-dev`), and so is the env
   key. This key authenticates as the eval agent against the dev backend.
2. **The `~/.haven/agents/<slug>/` credential directory.** Holds
   `identity.json`, `agent.json`, and `signer.json` — `signer.json` contains
   the DELEGATE PRIVATE KEY (`delegate_key`). It never leaves the machine.
   `--credentials-dir` points at it when re-running the signer by hand.
3. **The signer consent value.** `~/.haven/agents/<slug>/signer.json.signer-ack.json`
   (the acknowledgement sidecar, written by `--ack`) or the
   `HAVEN_SIGNER_ACK=<hash>` env value. See the consent section below.
4. **Any results-transport token.** If results come back through a GitHub
   token pushing to a results branch (open question 4), that token is on
   the machine too; scope it to the results repo and nothing else, or use
   something simpler. Decide with the builder at setup.

**Owner-side revocation:** the eval agent is revoked from the Haven agent
page — "Remove agent" unassigns and revokes the delegation; nothing on the
partner machine can spend after that (the delegate key is dead on-chain).
Also delete `~/.haven/agents/<slug>/` and the dotenv line on the machine
afterwards for hygiene.

## The signer consent (read before touching the nightly loop)

The signer refuses to start without consent: pass `--ack` (writes the
sidecar) or set `HAVEN_SIGNER_ACK` to the hash it prints
(`packages/signer/src/consent.ts`). The consent covers the SIGNER TOOL
NAMES — a signer update that adds a tool changes the consent hash and the
signer will refuse to start until it is re-acknowledged. That is by design:
it stops a nightly run rather than silently granting new tools. Signer
updates therefore go through connect's doctor/repair flow
(`npx @haven_ai/connect@<channel> --doctor`, then any repair line it
prints) — never an ad-hoc reinstall.

Headless key lookup: `--credentials <path>` (alias `--credentials-path`),
or `HAVEN_CREDENTIALS`, or `HAVEN_DELEGATE_KEY`
(`packages/signer/src/cli-args.ts`). One of these must be set for an
unattended start.

## Funding and the nightly budget

- **Initial funding of the eval account:** Circle faucet test USDC on Base
  Sepolia. Eval payments are **paymaster-sponsored** (the relayer submits the
  UserOp; see `agent-qa.md` § QA wallet balances, "agent payment UserOps are
  paymaster-sponsored"), so the eval account needs no ETH — the dev relayer
  pays only protocol gas (activations, attestations), not the agent's
  payments. The eval agent is provisioned
  through connect (above), not seed.ts.
- **The daily balances run keeps the account supplied (#3997):**
  `qa-balances.yml` (the QA wallet balances workflow) reads both eval smart
  accounts by address — the repo **variables** `QA_EVAL_HERMES_ACCOUNT` and
  `QA_EVAL_CLAUDE_ACCOUNT` — and requests Base Sepolia test USDC from the CDP
  faucet when an account is below its target (21 USDC, about seven nights of
  the 3 USDC Daily budget; the faucet pays 1 USDC per claim, at most 10 USDC
  per address per rolling 24 hours). An unset or invalid variable is an
  `unknown` row that never turns the run red. The one-time setup below
  remains the operator step; the standing issue reports a low balance instead
  of a failed night finding it.
- **Period:** give the eval agent a **Daily** period (the dashboard supports
  it — `PERIODS` in `packages/frontend/src/components/haven/DelegationBudgetCard.tsx`),
  sized so the tiered run fits inside one refill: the tier-1 slices shrink
  geometrically, the drainer takes the rest once, and the tier-3 refusal
  tasks spend nothing — the full 11-task run moves a bounded fraction over
  the initial remaining budget.
- **There is no "reset period budget" action.** Editing a budget builds a
  NEW delegation and needs the owner's passkey signatures, so it cannot run
  unattended — the operator step is the initial funding plus the Daily
  period, not per-run resets.
- **Refill anchor:** verify where the Daily refill anchors before relying on
  it (grant start vs local/UTC midnight). A run that can cross the boundary
  is not a problem it hides: the runner detects a budget INCREASE between
  trials and records it in the report (`budgetEvents`, surfaced in both
  summary halves), so a refill mid-run is visible instead of silently
  inflating a slice.

- **One full run per budget period.** A full run ends by draining the period
  budget (the `direct-send-full-remaining` task does that on purpose), so a
  second full run in the same period finds it empty. The CLI checks this at
  run start: when paying tasks are selected and the budget read says it is
  exhausted, it stops before any agent session (exit 3) and writes one
  message to the job summary. To run again in the same period, edit the eval
  agent's budget on the dev dashboard. The edit dialog only accepts a real
  change (e.g. the amount by 0.01 USDC, or the period), and it needs two
  passkey approvals: activate the new budget, then retire the old one. That
  issues a new delegation whose period starts when it is built, so the full
  amount is available; the agent, its delegate key and its API key stay the
  same.

## Running the suite

```
npm run evals:list -w packages/qa-agent      # print the tasks, no agent
npm run evals -w packages/qa-agent -- --trials=3 --out=evals-report.json
```

Env the run needs (all dev/testnet):

- `QA_HAVEN_API_URL` — the shared dev backend (from the standard `QA_*` contract,
  `packages/qa-agent/src/config.ts`).
- `QA_PAYMENT_TO` — required by the same `QA_*` contract (`loadQaConfig()`);
  set it to the same address as `QA_EVAL_RECIPIENT`.
- `QA_EVAL_AGENT_API_KEY` — the eval agent's `sk_agent_...` key (item 1 above).
- `QA_EVAL_RECIPIENT` — the Base Sepolia ADDRESS the direct-send transfer
  graders expect the money to reach (rendered into `{recipient}`). Address
  tasks only — the x402 URL tasks read `QA_EVAL_X402_TARGET`, because one
  env var cannot be both an address and an HTTP target.
- `QA_EVAL_X402_TARGET` — the HTTP URL rendered into `{target}` by the three
  x402 URL tasks (`x402-plain-http-request-mode`,
  `x402-price-cap-below-price`, `x402-eip3009-bridge-vpn-legacy`); required
  only when the loaded task set renders `{target}`, and checked before the
  first agent session. With `QA_EVAL_RECIPIENT` + `QA_EVAL_X402_TARGET` set,
  ONE suite invocation covers all 11 tasks — no per-task config needed (a
  task-by-id filter, `--task`, is a deliberate slice rather than per-task
  config; see Other flags). On dev it is the demo merchant's MCP endpoint
  (`…/mcp`),
  which answers **405 to a GET** and **402 only to a POSTed JSON-RPC
  `tools/call`**, so the two plain-HTTP task instructions spell out that
  POST request (`buy_vpn`, basic plan, 0.001 USDC). The bridge task uses the
  same endpoint as an MCP MERCHANT: `{target}` must also serve the
  EIP-3009-only `legacy` VPN plan (`buy_vpn` `{"plan":"legacy"}`, 0.001
  USDC) — its `requires` label `mcp-merchant-eip3009-target` stands for that
  provisioning, and the plan has no catalog row, so the instruction names
  merchant and tool instead of a `catalog_id`. A PINNED budget refuses the
  bridge task with 403 BEFORE any funding (`delegation-authorize.ts:483`),
  so its open-budget precondition (`delegation-agent-open-budget`) is real:
  a pinned-budget run reds the task without spending. The eval is the
  SECOND buyer of `vpn_legacy` (after `packages/qa-agent/src/scenarios/
  x402-hosted-mcp-signer.ts`, which proves the same hosted path without an
  agent in it).
- `QA_EVAL_AGENT_ACCOUNT` — the eval agent's **smart account** address (the
  payer the chain probe accepts; not the delegate EOA). The Claude Code lane's
  `AGENT_EVALS_AGENT_ACCOUNT` (below) holds the same role, and the daily
  balances run's `QA_EVAL_CLAUDE_ACCOUNT` must repeat it.
- `QA_EVAL_HERMES_COMMAND` — how ONE task runs through Hermes,
  non-interactively: a command template containing `{instruction}` (and
  `{log}` when the wrapper writes the log itself). The VERIFIED shape is a
  wrapper around `hermes -z {instruction} --yolo` (verified live
  2026-10-15: one task, exit 0) — see "The Hermes lane as actually run"
  below for the wrapper. **There is no default**: the adapter refuses to
  guess how Hermes runs one task unattended and where it writes the session
  log.
- `QA_EVAL_HERMES_SESSION_LOG` — the log path, when the template does not
  carry `{log}`.
- `QA_RPC_URL_BASE_SEPOLIA` — optional; the OBSERVER node the chain graders
  read through. Deliberately separate from the backend's own RPC (see
  `packages/qa-agent/src/lib/chain.ts`): point it at a node the backend does
  not write through.

**Model identity in every report (#3992 C).** The Hermes lane supplies the
identity through env (or its wrapper); the Claude Code lane reports the
model its stream carried. Any value not supplied prints `not reported` in
both summary halves — an unpinned model change must never read as a
regression in the trend lines:

- `QA_EVAL_MODEL` — the model id (e.g. `GLM-5.3-Flash-EXL3`); overrides the
  Claude Code lane's stream-reported model when set.
- `QA_EVAL_INFERENCE_SERVER_BUILD` — the inference server build string (e.g.
  `vLLM 0.11.x (EXL3), DGX Spark :8888`).
- `QA_EVAL_HARNESS_VERSION` — the harness version the wrapper or workflow
  pins (e.g. the qa-agent commit or package version).

Other flags:

- `--shuffle=<seed>` — deterministic shuffle WITHIN tiers; the seed and the
  executed order are recorded in the report. `--limit` is applied to the
  canonical order BEFORE the shuffle, so the 5-task subset is the same
  with or without a shuffle.
- `--task=<id>[,<id>…]` — run EXACTLY the named task ids (#4218), filtered
  from the canonical (tiered) set: tier order and any `--shuffle=<seed>`
  still apply, a repeated id runs once, and NO prerequisite is added
  implicitly — `--task=over-budget-x402-refused` alone runs WITHOUT the
  drainer, and the resolver's tier-3 precondition then decides. Mutually
  exclusive with `--limit`; refused with exit 2 — before any eval env is
  read, so a typo is never hidden behind a budget exit 3 — on an unknown
  id, an empty value, an empty list element, a repeated flag, or `--limit`.
  The report and both summaries record the filter, so a "pass^k on 1/1
  tasks" line never reads as a whole-suite green. The `agent-evals`
  workflow exposes the same filter via its optional `tasks` input.
- `--compare-with=<path1>,<path2>,… --new-report=<path>` — the regression-only
  compare (#3992 D): reads the new report plus the earlier ones, compares
  only reports of the same lane/adapter/model/trials-per-task, and exits
  non-zero naming the tasks that failed pass^k on the last two comparable
  nights after passing on at least 5 of the 7 before them. Fewer than 3
  comparable reports prints `baseline building` and exits zero; malformed
  reports are skipped and named; the drainer (k=1) is never compared.

The output is a JSON report plus a `<out>.summary.txt` readable summary:
per-task pass rate, pass^k (all k trials — except the drainer, marked
`k=1 (drains budget)`), the executed order, the model identity triple, and
wall time per session. The CLI exits 1 if any task failed any trial, 2 on a
configuration or setup error, and 3 when it did not run because the period
budget was already spent (only the summary files are written then; wrappers
should treat 3 as "not run" and skip any comparison).

## Grader semantics (pinned, do not soften)

- A budget refusal is recognized by the backend `error_code`
  `delegation_budget_exceeded` on a tool result — the typed 403 from the
  fail-fast pre-checks (#3503, #2706). A bare HTTP status proves nothing.
- "Told the user" = the run's final user-facing message; tasks may pin words
  that must appear (`mustMention`).
- "No further call from the payment-tool list" = the explicit 9-tool hosted
  list in `tools.ts`, matched through `bareToolName()` so a log recorded
  with `mcp__haven-<slug>-dev__haven_pay` graders identically to a bare
  log. Unknown tool names match nothing, and that is NOT a safe default:
  a payment tool missing from the list is a retry this grader cannot see,
  so the trial passes falsely. The lists are therefore tested against
  their upstream sources (the hosted `tools-list.snapshot.json` and the
  signer's `toolSchemas`, #4121), and a snapshot-only change routes the
  `qa_agent` CI job so that test runs.
- A transfer is proven by the observer node's USDC `Transfer` LOG with the
  exact amount and recipient — a log that claims success with no matching
  transfer FAILS. This asymmetry is the point (it is what a "success"
  message without money movement looks like).
- The x402 counterpart is `payment_status_settled`: an erc7710 redemption
  is submitted by the merchant's facilitator, so the backend payment object
  is the outcome there, not a transfer from the agent's account. The probe
  is INJECTED by the CLI (`buildGraderContext`, #3992 A1) and the payment
  id may come from the tool RESULT as well as from call arguments.
- The three over-budget tasks accept a **pre-emptive decline** (owner
  decision 2026-10-20, `acceptPreemptive` on `no_payment_retry_after_refusal`):
  reading the budget (`haven_get_allowances`, `haven_get_agent` or
  `haven_check_funds`), attempting no payment, and telling the user passes as
  well as taking Haven's refusal. Both lanes' models declined up front in the
  2026-10-20 runs. The price-cap task opts in too: the agent quoting, seeing
  the price above its authorization and stopping is the correct outcome;
  there only a successful `haven_quote_x402` counts (`preemptiveReadTools`),
  because the price must come from the quote. Elsewhere a quote counts as the
  budget read (its result carries the live budget
  check); an errored read does not. A decline without a successful read, or
  any payment call without a refusal, still fails. The tier-3 task
  (`over-budget-x402-refused`) is only graded when its exhausted-budget
  precondition actually holds: the resolver reads the threshold from its
  `EXHAUSTED-period-budget-below-<X>-USDC` label and makes the trial red
  with a named cause otherwise.
- `haven_payment_submitted` (the plain-HTTP x402 task) grades **Haven's part
  only** (owner decision 2026-10-20): every payment the log produced reads
  back as `submitted` or further. On a plain-HTTP paywall the agent itself
  sends the paid request with the payment header (Haven never does), and the
  Claude Code lane has no HTTP tool, so `submitted` is where Haven's part
  ends. It also requires a `haven_submit` with `settlement_scheme: "erc7710"`
  in the log: on the EIP-3009 bridge `submitted` is only the funding leg, so
  `QA_EVAL_X402_TARGET` must offer erc7710 (the dev demo merchant does). It
  never reports spend and is not a settlement grader, so the next trial does
  not wait for a budget decrease. The catalog task keeps
  `payment_status_settled`.
- The EIP-3009 bridge task (`x402-eip3009-bridge-vpn-legacy`, #4205) covers
  the **fast hosted flow** — `haven_pay_mcp_tool` → `haven_sign_x402` →
  `haven_settle_mcp_tool`, which delivers the header to the merchant from
  the hosted server — and grades three backend/chain signals, never the
  agent's reply: `merchant_settlement_recorded` on
  `GET /machine-payments/:id/status` (polled ~3 min: the #3888 sweeper
  records 60–180 s after funding, and on eip3009 a `confirmed`
  `GET /payments/:id` is only the FUNDING intent — treasury → delegate — so
  `payment_status_settled` alone proves nothing about the merchant); the
  `GET /machine-payments/receipts` row's two-leg shape
  (`settlement_scheme === 'eip3009'`, `settlement_address` = the delegate
  EOA, `merchant_address` different — an erc7710 settlement cannot pass);
  and no USDC stranded on the delegate EOA, as a delta against a
  RESOLVE-TIME balance snapshot (`ResolvedTask.
  delegateEoaBalanceBeforeAtomic`, read by the resolver immediately before
  the trial — earlier stranded funds may already sit there, so a historical
  `balanceOf` would misattribute them) whose AFTER read is gated on the
  merchant settlement being recorded. The task also keeps
  `payment_status_settled` so the runner's budget-consistency guard deducts
  its spend before the tier-2 drainer runs. NOT covered by this task: the
  decomposed tools (`haven_x402_sign_header` / `haven_submit` /
  `haven_complete_mcp_tool`) and the `MERCHANT_REJECTED_AFTER_FUNDING`
  sweep guidance.
- Every grader's option keys are closed (`GRADER_OPTION_KEYS` in
  `graders.ts`), and the loader refuses any other key (#4136). A grader
  ignores a key it does not read, so a misspelt key is a check that
  silently does not run: a misspelt `mustMention` drops the report check
  and a misspelt `probePaymentTools` the signer check, both false passes.
  Grader names are checked against the registry's own keys, so
  `"constructor"` is not a grader.
- The loader also checks option value types, for the same reason:
  `probePaymentTools` and `acceptPreemptive` are booleans (`"true"` is not
  `true`, so the option silently does not apply), `mustMention` is an
  array of non-empty strings, `preemptiveReadTools` an array of known tool
  names, `errorCode` a non-empty string, and `tool_called`'s `name` and
  `after` known tool names.

## Lane 2: Claude Code headless (#3959)

The second runner lane runs the SAME task files and graders through
`claude -p` in `--output-format stream-json --verbose` mode, authenticated
with the **owner's Max 5x subscription** via `CLAUDE_CODE_OAUTH_TOKEN` (a
long-lived token from `claude setup-token`). Nothing from the #3958 harness
is copied: the adapter (`packages/qa-agent/src/evals/claude-code.ts`) parses
the stream into the same `AgentRunLog` model and reuses the shared refusal
envelope reader, so every grader applies unmodified.

**Where the credentials live (money-path).** The subscription token and this
lane's eval-agent keys are secrets of the protected **`agent-evals` GitHub
environment** (owner = required reviewer) — NEVER repository secrets, NEVER
in code or fixtures. The one exception to "environment only" is the observer
RPC URL, `QA_RPC_URL_BASE_SEPOLIA`, a **repository** secret shared with
`qa-dev.yml` and `qa-balances.yml`. The only artifact built from the session
streams is the redacted copy, and it uploads only when its scan finds none of
the loaded secrets in the forms the redactor knows (see *The session
transcripts artifact* below, including what it cannot rule out). Every job in `.github/workflows/agent-evals.yml`
declares that environment, so each run waits
for the owner's approval before any secret reaches a runner. The env
inventory:

| Name | Kind | What it is |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | env secret | the owner's subscription token (`claude setup-token`) |
| `AGENT_EVALS_API_KEY` | env secret | this lane's eval agent `sk_agent_...` key (its OWN agent, not the Hermes lane's and never `QA_DELEGATION_*`) |
| `AGENT_EVALS_DELEGATE_KEY` | env secret | this lane's delegate private key |
| `AGENT_EVALS_HAVEN_API_URL` | var (or secret) | the dev backend URL |
| `AGENT_EVALS_RECIPIENT` / `AGENT_EVALS_AGENT_ACCOUNT` / `AGENT_EVALS_X402_TARGET` | vars | the graders' address/URL fixtures (same roles as the `QA_EVAL_*` env) |
| `QA_RPC_URL_BASE_SEPOLIA` | repo secret | the observer RPC URL, which embeds the provider key; shared with `qa-dev.yml` and `qa-balances.yml`, so it is NOT an `agent-evals` environment secret |
| `QA_X402_BINDING_SIGNER` | repo var | the public address the signer verifies x402 bindings against, passed as `HAVEN_X402_BINDING_SIGNER`; the job fails before any session when it is unset |

**Token rotation.** The token does not refresh on its own (reportedly about
one year). It is stored ONLY as the `agent-evals` environment secret above.
To rotate: run `claude setup-token` on a machine with the owner's login,
update the `CLAUDE_CODE_OAUTH_TOKEN` environment secret in the GitHub UI
(Settings → Environments → agent-evals), and delete the old token from the
Anthropic console. The workflow file references no repository-level secret
for any of these.

**The allowlist.** `claude -p` is limited to the Haven MCP tools only —
visible in the workflow file (`QA_EVAL_CLAUDE_CODE_COMMAND`):
`--allowedTools mcp__haven-eval mcp__haven-signer-eval` (the hosted + signer
pair the job wires through `--mcp-config`) and an explicit
`--disallowedTools` list denying every built-in Bash/file/web tool and the
other built-ins (Skill, Workflow, ToolSearch, scheduling, messaging). Anything
not allowlisted is denied in headless mode; a denied call still appears in
the stream, which is what the no-retry graders need.

**Isolation of the agent under test.** `claude` runs from an empty directory
(`$RUNNER_TEMP/claude-cwd`), so no `CLAUDE.md` or project config from this
repo reaches it, and `--strict-mcp-config` loads only the two wired servers.
Because of that, the signer server is launched by absolute path
(`$GITHUB_WORKSPACE/packages/signer/dist/cli.js`) with
`HAVEN_X402_BINDING_SIGNER` from `vars.QA_X402_BINDING_SIGNER` (without it
every x402 signing refuses), and the report is written to
`$GITHUB_WORKSPACE/evals-report.json`, where the summary and upload steps read
it. A session that exits non-zero but left a stream (the turn limit) is still
graded, with its exit code recorded.

**Login check first.** Before the eval slice the job runs one `claude -p`
turn on the eval's model with no MCP servers, and fails with Claude's own
reason (an invalid or expired token, the plan's usage limit, model access)
when it does not work, instead of every task failing as "claude exited 1". An
adapter failure quotes the session's `result` text for the same reason. The
raw session streams are never uploaded: this repository is public, and they
carry full tool results. They upload only as the redacted copy below.

**The session transcripts artifact (#4137, owner decision 2026-10-20).** After
the report upload, the job redacts the per-trial streams
(`$RUNNER_TEMP/claude-sessions.<task>.trial<N>.jsonl`) with
`packages/qa-agent/src/evals/redact-sessions.ts` (`npm run evals:redact -w
packages/qa-agent`) and uploads the result as
`agent-evals-sessions-<run_id>`, kept for **3 days**. It is fail-closed:

- The step passes the redactor every `secrets.*` the workflow references, by
  name. **Required:** `CLAUDE_CODE_OAUTH_TOKEN`, `AGENT_EVALS_API_KEY`,
  `AGENT_EVALS_DELEGATE_KEY`, `QA_RPC_URL_BASE_SEPOLIA`; when any is empty the
  redactor writes nothing and the step reports `clean=false`. **Optional:**
  `QA_HOSTED_MCP_URL` and `AGENT_EVALS_HAVEN_API_URL`, the `vars.X || secrets.X`
  fallbacks, redacted only when set as secrets (today they are variables,
  which are kept). The step prints how many secrets it loaded, by name.
- It redacts into a staging directory, prints a per-class count of what it
  found in the raw input (numbers only, the positive control), then rescans
  the staged copy with a separate detector for every class (separate
  detectors; shared parsing helpers such as the JSON reader and the
  `\uXXXX` decoder). The scanner builds its exact-value detectors
  from the raw secret values itself (a lowercased substring search over the
  decoded strings and their JSON-escaped forms, its own URL splitter, and a
  base64 decode of every base64-looking run), and it treats ANY nested
  `result` as a merchant body, which is broader than the redactor's
  predicate. A needle built wrong or a rule that stops redacting is therefore
  a scan hit. Only a clean scan moves the files to the upload directory and
  sets `clean=true`, and the upload step is gated on
  `steps.redact.outputs.clean == 'true'`, which is the step right after it.
  No other step names the staging or upload directory, and every upload path
  is on a fixed allowlist (the guard checks all three).
- The checkout runs with `persist-credentials: false`: no git token is left in
  `.git/config`, and nothing in the job talks to the remote after checkout.
- A scan hit means the redactor is wrong: nothing moves, the step prints
  `::error::` with each class and its count (never a value), and the job
  fails. The report artifact has already uploaded.
- A line that fails `JSON.parse` (a stream cut off by a timeout's SIGKILL)
  takes the string rules; it is never copied raw. Every string, parsed or
  not, has its `\uXXXX` escapes decoded before the rules, and the scan reads
  each string both as it is and decoded.

Each redaction replaces the whole value, prefix included, with
`[REDACTED:<class>]`. Key names are compared lowercased with `_` and `-`
removed, so `paymentHeader`, `PAYMENT-SIGNATURE` and `delegationSignature`
all match:

| Class | What goes |
|---|---|
| `secret-exact` | each loaded secret value, raw and JSON-escaped, plus its base64 and base64url renderings at every byte alignment, and the body of an `sk_agent_` / `sk-ant-` key without its prefix; the delegate key case-insensitively, with and without `0x` (it has a tx hash's shape, so only its exact value goes); a REQUIRED URL secret with no key-bearing segment, whole |
| `rpc-key` | the key-bearing parts of a URL-shaped secret: path segments, query keys and values, and the fragment, of 12+ characters and without a colon (the `secretSegments` rule), plus the basic-auth password (and a 12+ username). Public network slugs (`base-sepolia` and the like) are skipped. The host stays, so the URL keeps its shape |
| `agent-key` | any `sk_agent_…` key, this agent's or another's |
| `anthropic-key` | any `sk-ant-…` value |
| `auth-header` | `Authorization` values and `Bearer …` anywhere |
| `payment-header` | `payment_header`, `PAYMENT-SIGNATURE`, `X-PAYMENT` values |
| `siwx-header` | `sign_in_with_x_header`, `SIGN-IN-WITH-X` values |
| `signature` | string values of any key ending in `signature`, and any `0x` + 130-hex (65-byte) signature anywhere |
| `b64-json` | `eyJ…` base64-JSON blobs (x402 headers, JWTs) |
| `merchant-body` | the merchant's paid response: every string and number inside any `result` in a tool result of `haven_complete_mcp_tool` / `haven_settle_mcp_tool` (keyed off the `tool_use` id, because the complete tool's `data` carries no `payment_id`), and inside any `result` beside `payment_id` or `settlement_tx_hash`; any `merchant_body` value; and the body a refusal echoes after `Merchant response:`. Keys, nesting, booleans and MCP block `type`s stay |

**Reading a transcript.** Download it with `gh run download <run_id> -n
agent-evals-sessions-<run_id>` (a signed-in account; the artifact list itself
is public). Each file is one trial's `claude -p` stream-JSON, one object per
line. A hosted tool result is a `tool_result` whose `text` holds the hosted
envelope, re-serialized after redaction. Kept on purpose: tool names, the
`tool_use` / `tool_result` order, `next_tool_name`, `code` / `error_code`,
`payment_id`, idempotency keys, addresses, tx hashes, amounts, the agent's
text and the variable URLs (hosted MCP, backend, merchants). A marker says
which class removed a value. A line that was cut off mid-way stays cut off;
everything from its first nested `result`, `merchant_body` or
`Merchant response:` to the end of the line is one `merchant-body` marker.

**What the redaction cannot rule out.** It removes the loaded secrets in the
forms above and the pattern classes; it cannot prove a secret is absent in a
form it does not know: percent-encoded or hex-encoded, split across lines or
strings, reversed or otherwise transformed, or a mixed-case rendering of the
delegate key inside base64. For a URL-shaped secret it also cannot see a key
in the host (`https://<key>.rpc.example`), or a key segment under 12
characters when the URL has another 12+ segment (the URL is then not
redacted whole). A `\uXXXX` escape of a quote or a backslash is left
encoded, and an escape nested deeper than 8 backslashes is not read. The agent under test cannot produce such forms on
its own (it has no Bash, file or web tool, only the two Haven servers), so
they could only come from a server's own output.

Owner decision (Antonio, 2026-10-20): the hosted paid bodies are stripped,
but the agent's own assistant text and the stream's `{"type":"result"}` line
are kept, even when they restate what the merchant delivered. That summary is
a known residual of this artifact. One fail-safe cut still reaches agent
text: a string that literally quotes a JSON `"result":` key, or the
`Merchant response:` label, is cut from that point to its end, because the
scanner flags the same shapes and leaving them would fail the run instead.

**What the report does show for a failure.** The job summary lists every
failed trial with a **tool trace**: the session's tool calls in order, as bare
tool names, a `✗` for a failed call and the machine `error_code`. No
arguments, results or final message, capped at 40 calls. The JSON report
carries the same `trace` for every trial. The trace is sanitised, not trusted:
an unknown tool name that is not a plain identifier prints as `(unknown tool)`
and a code that is not lower-snake-case prints as `(unrecognised code)`. RPC
error text in grader details has URLs stripped, because the observer URL
embeds the provider key. To fix a failed login, generate a new token with
`claude setup-token` and replace the `CLAUDE_CODE_OAUTH_TOKEN` environment
secret (see Token rotation above).

**Env the lane needs** (set by the workflow; set the same names by hand for
a local run):

- `QA_EVAL_ADAPTER=claude-code` — the lane switch (default `hermes`).
- `QA_EVAL_CLAUDE_CODE_COMMAND` — the full `claude -p` command template
  containing `{instruction}`. There is no default: the allowlist, the MCP
  config and the model belong in this template, where they are reviewable.
  Never put a token in it — the token travels only as `CLAUDE_CODE_OAUTH_TOKEN`.
- `QA_EVAL_CLAUDE_CODE_SESSION_LOG` — optional base path for the captured
  session streams (`<base>.<task>.trial<N>.jsonl`); the adapter writes them
  itself.
- The common env from "Running the suite" above (`QA_HAVEN_API_URL`,
  `QA_EVAL_*`, `QA_RPC_URL_BASE_SEPOLIA`) — the same eval-agent contract.

**Cost pilot (the cadence decider).** Run the 5-task slice, one trial:

```
npm run evals -w packages/qa-agent -- --trials=1 --limit=5 \
  --out=evals-pilot.json --hosted-mcp-source=dev-deployed --hosted-mcp-url=<dev hosted MCP>
```

Every session's `total_cost_usd` (plus wall time and the model the session
actually ran on) is recorded in `evals-pilot.json.sessions.json` and summed
into the report (`totalCostUsd`, `model`).

**What a run costs the owner.** `total_cost_usd` is Claude Code's client-side
API-list-price **estimate**, not a charge. With `CLAUDE_CODE_OAUTH_TOKEN`
(a subscription login) the runs draw from the plan's normal usage limits
(the 5-hour and weekly windows); the previously announced separate Agent SDK
credit was paused, and the Max plan's monthly API credit applies only to runs
authenticated with a Console API key. Nothing is billed beyond the plan
unless "usage credits" (extra usage) is turned on in claude.ai Settings →
Usage; that page also shows the plan usage the runs consume. Do not set
`ANTHROPIC_API_KEY` in this job: it takes precedence over the OAuth token and
would bill the API instead. Measured on the first pilot (2026-10-19, Sonnet,
5 tasks × 1 trial): about $0.08 per session estimated, so a full 11 × 3 run
is roughly $2.65 of estimated usage. Sources: support.claude.com articles
15036540 (Agent SDK with your plan) and 12429409 (extra usage), and
code.claude.com/docs/en/costs.

**What the job installs and builds first.** After `npm ci` it installs the
`claude` CLI, pinned (`@anthropic-ai/claude-code@<exact>`): it is not on the
runner image and not a workspace dependency. It then builds `@haven_ai/core`
before `packages/sdk`, `packages/signer` and `packages/mcp-server`, because
`npm ci` does not create core's `dist/` and mcp-server imports it. The first
pilot run (2026-10-19) died on exactly that before any task ran.
A CI guard checks both: the build order, and that an exactly pinned CLI
install runs before the eval step.

**The workflow** (`.github/workflows/agent-evals.yml`) runs **only when the
owner starts it** with the Run workflow button (owner decision 2026-10-19:
no schedule and no pull_request trigger, so nothing queues a run that waits
for the owner's approval). Two suite choices, plus an optional task filter:

- **subset**: 5 tasks. It builds and boots `packages/mcp-server` from the
  checked-out commit (it runs locally against `HAVEN_API_URL`, see
  `packages/mcp-server/src/boot.ts`) pointed at the dev backend, and launches
  the signer and skill from the workspace, not npm. The report names the
  hosted MCP commit it ran against and states that backend error bodies stay
  dev-deployed.
- **full**: every task, against the deployed dev stack.
- **tasks** (optional input): a comma-separated list of task ids, e.g.
  `x402-eip3009-bridge-vpn-legacy` — runs EXACTLY those tasks with no
  `--limit`, whatever the `suite` is (the suite still decides the hosted MCP
  source). The slice step validates it before use: control characters
  rejected, whole-string kebab-case (`^[a-z0-9-]+(,[a-z0-9-]+)*$`), nothing
  written to `$GITHUB_OUTPUT` or echoed before both pass. The cheap way to
  prove ONE task end to end: dispatch with `tasks=<id>` and `trials=3` (the
  `trials` input defaults to `1`) — a filtered run instead of a whole
  budget period. A filtered run's summary states the filter, so "pass^k on
  1/1 tasks" does not read as a whole-suite green.

Either way the run waits for the environment approval. It is NOT a required
check on `dev` or `main`.

Every run writes a per-task table (pass rate, pass^k, median wall time per
session) plus total cost, model and hosted MCP provenance to the GitHub job
summary (`evals-report.json.summary.md` → `$GITHUB_STEP_SUMMARY`); the full
JSON report and the per-session cost evidence are uploaded as artifacts
(default retention), and the redacted session transcripts as a separate
3-day artifact, only when their scan is clean (see *The session transcripts
artifact* above).

## The Hermes lane as actually run (verified live 2026-10-15)

The partner verified the lane on the machine and answered the seams on
#3957; this section is what is actually true, replacing the fictional
`hermes -p {instruction} --session-log {log}` example the runbook carried
before #3992:

- **The command is `hermes -z {instruction} --yolo`** — one task,
  non-interactive, exits when done (verified, exit 0). `hermes.ts:89-95`
  already shell-quotes `{instruction}`.
- **The tool-call trace lives in the profile's `state.db`**, not a
  `--session-log` flag: a session row with source `oneshot`, assistant
  messages carrying the `tool_calls` JSON (name and arguments), and joined
  `role=tool` result rows. The wrapper that `QA_EVAL_HERMES_COMMAND` names
  therefore: reads the newest `oneshot` session started after the trial,
  walks those rows, and emits the normalized `AgentRunLog` JSON the adapter
  already parses (or the Anthropic-style session JSONL — the parser accepts
  both). No parser fork is needed. The wrapper lives on the partner machine
  for now; committing it into the repo is a one-line decision for the
  partner (say the word on #3957 and it lands under
  `packages/qa-agent/scripts/`).
- **The model is GLM-5.3-Flash-EXL3 on the DGX Spark (vLLM :8888, 850k
  ctx)**, shared with the build workers — a saturated night skips the run,
  which is acceptable. Set `QA_EVAL_MODEL`,
  `QA_EVAL_INFERENCE_SERVER_BUILD` and `QA_EVAL_HARNESS_VERSION` in the
  wrapper so every report carries the identity (#3992 C).
- **Nightly, in the cheap-electricity window.** The runner is a scheduled
  job: it checks the pipeline pause sentinel before each task and exits if
  present (the electricity gate pauses testing with the same grace
  semantics as in-flight cards). It never claims issues — findings go to
  the report and the regression ping; follow-ups go through the normal
  claim protocol.
- **Tool restriction for the eval profile — RESIDUAL, recorded.** `--yolo`
  auto-approves every tool call, including Hermes built-ins such as shell
  and file access. Two tasks fetch merchant URLs, which is a
  prompt-injection path, and the machine is shared with build workers.
  Nothing in this repo or in connect's Hermes writer configures toolsets
  (open question 1 below), so no restriction exists today. Residual risk
  accepted for the testnet-only lane until a `--allowed-tools`-style flag
  exists; the eval profile should enable only the Haven MCP pair the moment
  Hermes supports scoping. The graders' evidence scoping (#3992 A2) bounds
  the blast radius of a confused trial but does not remove the path.

## Open questions (partner) — status after the 2026-10-15 answers on #3957

1. ~~Which model and inference server?~~ ANSWERED: GLM-5.3-Flash-EXL3 on
   the DGX Spark (vLLM :8888, 850k ctx); 29 hosted + 5 signer tools plus
   built-ins fit trivially at that window.
2. ~~Can Hermes run one task non-interactively?~~ ANSWERED: `hermes -z
   {instruction} --yolo`; the trace is in the profile's `state.db` and the
   wrapper emits the normalized log (see the section above).
3. ~~When is the machine free?~~ ANSWERED: nightly, cheap-electricity
   window; the pipeline pause sentinel defers the run.
4. ~~How do results come back?~~ ANSWERED: a results branch with a narrowly
   scoped token plus a regression-only ping (#3992 D's compare is the repo
   side of that). The token remains credential item 4 above.
5. Can a Hermes profile restrict which toolsets the model sees (only the
   Haven MCP pair, no shell/file built-ins)? STILL OPEN — nothing in this
   repo or connect's writer configures toolsets; the residual is recorded
   above. (Whether the `state.db` wrapper is committed into the repo is
   also the partner's call; it is documented, not yet committed.)

The real 10 x 3 partner-machine run remains an issue-level acceptance
criterion reported on #3958, not a build gate for this slice.

## Where this fits

- The deterministic, no-LLM money-flow harness: `docs/operations/agent-qa.md`
  (the deploy-confidence core; this suite is the model-behaviour layer on top).
- Slice 2, the Claude Code adapter: #3959 — reuses the task format, graders
  and log contract from here; nothing is copied. See "Lane 2" above.
