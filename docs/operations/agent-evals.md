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
  - packages/qa-agent/src/seed.ts
  - packages/qa-agent/src/config.ts
  - packages/qa-agent/src/lib/chain.ts
  - packages/connect/src/args.ts
  - packages/connect/src/server-names.ts
  - packages/signer/src/consent.ts
  - packages/signer/src/cli-args.ts
last-verified: "2026-10-14"
---

# Agent Evals — the model-in-the-loop eval suite (epic #3957)

The agent evals run a REAL model agent against the dev environment and grade
what it actually did: its tool-call log, the dev backend, and Base Sepolia.
This is the layer the deterministic money-flow harness (`docs/operations/agent-qa.md`)
deliberately does not cover — that harness has no LLM in it. Slice 1 (#3958)
builds the harness-neutral core: the task format, the graders, ~10 starter
tasks and the Hermes runner. Slice 2 (#3959) adds a Claude Code adapter that
reuses the task format and graders unchanged.

Everything here runs on **Base Sepolia test USDC against the shared dev
backend**. No payment code is changed by this suite; the graders only READ.

## The pieces

| Piece | Where | What it is |
|---|---|---|
| Task format | `packages/qa-agent/src/evals/types.ts` | One JSON file per task: the instruction, the setup it needs, the budget-aware amount rule, and the graders to apply. JSON, never Markdown. |
| Graders | `packages/qa-agent/src/evals/graders.ts` | Read the recorded tool-call log + injected chain/backend probes. No model, no live agent. |
| Tool lists | `packages/qa-agent/src/evals/tools.ts` | The 29 hosted tools, the 5 signer tools, and the explicit 9-tool payment list. Graders match BARE tool names + `next_tool_server_role`, never the server-prefixed name. |
| Starter tasks | `packages/qa-agent/src/evals/tasks/*.json` | 10 tasks across direct-payment / x402-paywall / over-budget, each citing its source. |
| Hermes adapter | `packages/qa-agent/src/evals/hermes.ts` | Runs one task through Hermes, collects the tool-call log, parses it into the grader model. |
| Runner | `packages/qa-agent/src/evals/runner.ts` + `cli.ts` | k trials per task, applies graders, writes JSON report + readable summary with per-task pass rate, pass^k and wall time per session. |

Amounts are **budget-aware** (#3958 § 4): success tasks are sized from the
live remaining period budget at launch, over-budget tasks from remaining + 1
USDC (the `over-budget-refused` scenario's own derivation). The budget read
is refused, not guessed, when the chain/backend does not supply the number —
the #2016 discipline. Size the eval agent's period budget for a full night:
10 tasks x 3 trials plus margin, and remember 30 nightly sessions share ONE
period budget unless the owner resets it.

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

## Running the suite

```
npm run evals:list -w packages/qa-agent      # print the tasks, no agent
npm run evals -w packages/qa-agent -- --trials=3 --out=evals-report.json
```

Env the run needs (all dev/testnet):

- `QA_API_URL` — the shared dev backend (from the standard `QA_*` contract,
  `packages/qa-agent/src/config.ts`).
- `QA_EVAL_AGENT_API_KEY` — the eval agent's `sk_agent_...` key (item 1 above).
- `QA_EVAL_RECIPIENT` — the address transfer graders expect the money to reach.
- `QA_EVAL_AGENT_ACCOUNT` — the eval agent's account/delegate address (the
  payer the chain probe accepts).
- `QA_EVAL_HERMES_COMMAND` — how ONE task runs through Hermes, non-interactively:
  a command template containing `{instruction}` and optionally `{log}`
  (e.g. `hermes -p {instruction} --session-log {log}`). **There is no
  default**: the adapter refuses to guess how Hermes runs one task
  unattended and where it writes the session log (partner open question 2).
- `QA_EVAL_HERMES_SESSION_LOG` — the log path, when the template does not
  carry `{log}`.
- `QA_RPC_URL_BASE_SEPOLIA` — optional; the OBSERVER node the chain graders
  read through. Deliberately separate from the backend's own RPC (see
  `packages/qa-agent/src/lib/chain.ts`): point it at a node the backend does
  not write through.

The output is a JSON report plus a `<out>.summary.txt` readable summary:
per-task pass rate, pass^k (all k trials), and wall time per session. The
CLI exits non-zero if any task failed any trial.

## Grader semantics (pinned, do not soften)

- A budget refusal is recognized by the backend `error_code`
  `delegation_budget_exceeded` on a tool result — the typed 403 from the
  fail-fast pre-checks (#3503, #2706). A bare HTTP status proves nothing.
- "Told the user" = the run's final user-facing message; tasks may pin words
  that must appear (`mustMention`).
- "No further call from the payment-tool list" = the explicit 9-tool hosted
  list in `tools.ts`, matched through `bareToolName()` so a log recorded
  with `mcp__haven-<slug>-dev__haven_pay` graders identically to a bare
  log. Unknown tool names fail CLOSED (they match nothing).
- A transfer is proven by the observer node's USDC `Transfer` LOG with the
  exact amount and recipient — a log that claims success with no matching
  transfer FAILS. This asymmetry is the point (it is what a "success"
  message without money movement looks like).
- The x402 counterpart is `payment_status_settled`: an erc7710 redemption
  is submitted by the merchant's facilitator, so the backend payment object
  is the outcome there, not a transfer from the agent's account.

## Open questions (partner) — the adapter's recorded seams

1. Which model and inference server (Ollama, vLLM, llama.cpp, MLX...), and
   what context window? The agent sees 29 hosted + 5 signer tools plus
   Hermes built-ins — if tools must be filtered, the report records it.
2. Can Hermes run one task non-interactively, exit when done, and save the
   tool-call log? Nothing in this repo documents it. Until answered,
   `QA_EVAL_HERMES_COMMAND` + `QA_EVAL_HERMES_SESSION_LOG` are REQUIRED and
   the parser accepts the Anthropic-style session JSONL (assistant
   `tool_use` / user `tool_result`) or our normalized JSON. If the real
   session format differs, extend `parseHermesSessionLog` — do not fork the
   graders.
3. When is the machine free: every night, or some nights? (Budget sizing
   follows this.)
4. How do results come back — a narrowly scoped GitHub token pushing to a
   results branch, or something simpler? Decide at setup; the token is
   credential item 4 above.
5. The real 10 x 3 partner-machine run is an issue-level acceptance
   criterion reported on #3958, not a build gate for this slice.

## Where this fits

- The deterministic, no-LLM money-flow harness: `docs/operations/agent-qa.md`
  (the deploy-confidence core; this suite is the model-behaviour layer on top).
- Slice 2, the Claude Code adapter: #3959 — reuses the task format, graders
  and log contract from here; nothing is copied.
