# @haven_ai/qa-agent

Internal QA harness for the Haven **dev environment** (epic #573). Not published.

This is the shared home for the automated QA layers that exercise the *deployed*
dev stack (which the mocked Playwright suite structurally can't):

- **#574** — dev seeding (a QA identity: user + Safe + agent + on-chain allowance).
- **#575** — the deterministic, no-LLM money-flow harness (the deploy-confidence
  core): drives the real SDK/API payment path on **Base Sepolia** against the
  shared dev backend + the dev demo-merchant, asserting the #420 invariants.

## Status: scaffold

Only the shared **config contract** (`src/config.ts`) is implemented so far. The
seed step and money-flow scenarios are deliberately deferred until the **dev-stack
verification checklist (#574) is green** — they need a verified dev stack plus
owner-provisioned credentials/funding that don't exist yet:

- the dev demo-merchant deployed + its URL recorded,
- a funded QA delegate on Base Sepolia,
- the `QA_*` GitHub Actions secrets.

Building the on-chain seed / settlement logic before those exist would be
unverifiable speculation, so it waits. See
[`docs/operations/agent-qa.md`](../../docs/operations/agent-qa.md) and the #574
verification checklist.

## Config contract

Both the seed step and the harness load their config from `loadQaConfig()`, the
single source of truth for the `QA_*` env (all **testnet/dev-only**):

| Env | Meaning |
|---|---|
| `QA_HAVEN_API_URL` | Shared dev backend, hit **directly** (Node→API, no CORS) |
| `QA_AGENT_API_KEY` | QA agent identity (`sk_agent_*`) |
| `QA_DELEGATE_PRIVATE_KEY` | QA delegate EOA key — signs locally, testnet-only |
| `QA_PAYMENT_TO` | Recipient for direct-send scenarios |
| `QA_DEMO_MERCHANT_URL` | Dev demo-merchant base URL (optional until confirmed) |

`loadQaConfig()` fails fast with a clear error listing every missing var.

## Scripts

```bash
npm run typecheck -w packages/qa-agent
npm run test -w packages/qa-agent
npm run build -w packages/qa-agent
```
