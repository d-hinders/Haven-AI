---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp/**
  - packages/mcp-server/**
  - packages/signer/**
  - packages/backend/src/routes/agent-connection-setups.ts
  - packages/sdk/src/direct-payment-guard.ts
last-verified: "2026-10-05"
---

# Migration - Local MCP To Hosted MCP

> **Scope:** This guide is for agents with an **existing local MCP setup**. New
> agents do not need it — Connect Agent 2 creates the hosted-MCP + local-signer
> split automatically. For the deployment model tradeoff, see
> [architecture/08-local-vs-hosted-mcp.md](../architecture/08-local-vs-hosted-mcp.md);
> to deploy the hosted server, see [hosted-mcp.md](hosted-mcp.md).

Migrating from the local `npx @haven_ai/mcp@alpha` stdio server to hosted, keyless
MCP plus local signing.

TL;DR: point your agent runtime at the hosted MCP URL with the Haven API key as
a Bearer token. Keep the delegate signing key local. Hosted MCP constructs and
relays; the local runtime or `@haven_ai/signer` signs.

## What Changed

### Old Approach: Local Stdio MCP

```text
Agent runtime
  -> local npx @haven_ai/mcp@alpha
  -> reads api_key + delegate_key from local credential file
  -> signs locally
  -> sends API identity + signed payloads to Haven
```

This was non-custodial because the delegate key stayed local, but every runtime
needed a local server install/config block and the local process held both
identity and signing authority.

### New Approach: Hosted MCP + Local Signing

```text
Agent runtime
  -> hosted Haven MCP over HTTP (Bearer sk_agent_*)
  -> hosted MCP returns unsigned payload hashes
  -> local runtime or @haven_ai/signer signs with delegate key
  -> hosted MCP relays { payment_id, signature } for funding
  -> Haven backend -> on-chain policy (the delegation's caveat enforcers)
```

The split is deliberate:

- Hosted MCP receives the API key as identity only.
- Hosted MCP never receives the delegate private key.
- The local runtime or `@haven_ai/signer` signs payment hashes.
- Funding relay sends only `{ payment_id, signature }` back to hosted MCP.
- Paid MCP-tool completion can also send a signed, merchant-bound
  `payment_header` with the funding `payment_id` so hosted MCP can settle the
  merchant call and attach evidence.
- On the delegation rail's **erc7710** scheme
  ([#2041](https://github.com/d-hinders/Haven-AI/issues/2041)) the header
  travels the other way: there is no funding signature to relay, so
  `haven_submit { settlement_scheme: "erc7710" }` relays the settlement child
  and RETURNS an already-assembled `payment_header` for the agent to retry the
  merchant with. Still only signatures and headers cross the boundary, never the
  key.
- On-chain policy state remains the spend gate: the signed delegation's caveat
  enforcers on delegation-rail accounts. The Safe AllowanceModule is **retired**
  (#1440) — a legacy Safe account cannot pay at all, and every hosted-MCP payment
  tool bottoms out in a route that answers HTTP 410 for it (#1986).

API auth is identity. Signature is authority. On-chain module state is
enforcement.

For new agents, Connect Agent 2 can create this split automatically: Haven
creates a pending setup, the local connector generates the signing key and API
key on the user's machine, and Haven receives the public signing address, a
proof signature, the API-key hash/prefix, and non-secret setup metadata (server
name, run mode, install status), never the signing key or the plaintext API
key, before wallet approval. This
migration guide still applies to existing agents and manual hosted-MCP setups.

## Step-By-Step Migration

### 1. Keep Or Recreate Your Credential File

If you already have a Haven credential file, keep it. It contains the API key
and the delegate signing key. The API key goes into the hosted MCP config; the
delegate key stays local for signing.

If you do not have the credential file, open Haven, select the agent, and use
the payment-credential flow to rotate the API key. Haven cannot recover a lost
delegate private key — nobody can, which is the point of it being yours. What
you do next depends on the rail: a **delegation-rail** agent is re-keyed (same
agent, new key, budget remainder carried — see
[Replacing an agent's signing key](../product/agent-key-rotation.md)). A
**legacy AllowanceModule** record reaches no account, agent or dashboard screen since
#2413 — the row persists, and its name still appears in the `/transactions` initiator
picklist, whose agent query has no rail predicate — and it has no payment-credential or
authority-management controls, and any remaining Safe
permission is managed outside Haven by the owner where they have access. Use
the live delegation flow for a replacement agent.

When using Connect Agent 2 for a new setup, use the Haven-generated connector
prompt instead of manually rebuilding this file. The prompt carries only a
setup token and public connection metadata; it does not carry the delegate key
or plaintext API key.

### 2. Remove The Old Local MCP Server Entry

For Claude Code:

```sh
claude mcp remove haven
```

For JSON-configured runtimes, remove the old stdio block:

```jsonc
"haven": {
  "command": "npx",
  "args": ["@haven_ai/mcp"],
  "env": { "HAVEN_CREDENTIALS": "/path/to/haven-agent.json" }
}
```

### 3. Add Hosted MCP

Use the hosted URL shown in the Haven app's **Connect your agent** flow; the
dashboard and the connector both get it from the backend. The production URL
below is a built-in default only on the production backend itself (#1129).
Every other environment sets its own endpoint in the backend's
`HAVEN_HOSTED_MCP_URL` (`NEXT_PUBLIC_HAVEN_MCP_URL` is still read there as a
fallback name). When neither is set, connector setup fails with an error naming
the variable, and the discovery document reports no hosted MCP. It never hands
out another environment's URL.

Claude Code:

```sh
claude mcp add --transport http haven \
  https://haven-ai-production-5953.up.railway.app/v1 \
  --header "Authorization: Bearer sk_agent_YOUR_KEY"
```

Claude Desktop / Cursor-style JSON:

```json
{
  "mcpServers": {
    "haven": {
      "url": "https://haven-ai-production-5953.up.railway.app/v1",
      "headers": {
        "Authorization": "Bearer sk_agent_YOUR_KEY"
      }
    }
  }
}
```

Codex CLI TOML:

```toml
[mcp_servers.haven]
url = "https://haven-ai-production-5953.up.railway.app/v1"
bearer_token_env_var = "HAVEN_TOKEN"
```

Then launch Codex with:

```sh
export HAVEN_TOKEN=sk_agent_YOUR_KEY
codex
```

For custom MCP clients:

```sh
export HAVEN_MCP_URL=https://haven-ai-production-5953.up.railway.app/v1
export HAVEN_API_KEY=sk_agent_YOUR_KEY

curl -X POST "$HAVEN_MCP_URL" \
  -H "Authorization: Bearer $HAVEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The hosted connection should list Haven tools such as `haven_get_agent`,
`haven_get_allowances`, `haven_pay`, `haven_submit`, and
`haven_pay_x402_quote`. A tool list alone does not prove the key works —
`haven_get_agent` is the first call that checks it.

### 4. Add Local Signing

Hosted MCP does not sign. The agent must sign locally, either with its own
runtime secret handling or with `@haven_ai/signer`.

```sh
npx @haven_ai/signer@alpha --credentials /path/to/haven-agent.json --ack
```

After acknowledgement, run it normally beside the agent runtime:

```sh
npx @haven_ai/signer@alpha --credentials /path/to/haven-agent.json
```

The signer exposes local stdio MCP tools:

| Tool | Purpose |
|---|---|
| `haven_sign` | Sign a delegation-rail payment from EIP-712 `typed_data`/`typed_data_b64`, or just `payment_id` (#1263 — the signer fetches the exact payload itself). A `payload_hash` on its own is REFUSED (`BARE_HASH_REFUSED`, #3169); it is still accepted alongside `typed_data` / `typed_data_b64` or `x402_expected`. Outside the budget paths below, typed data without an x402 context is signed only when it is a direct-payment UserOp from the agent's own delegate account whose only call redeems a delegation made to it — anything else answers `TYPED_DATA_NOT_ALLOWED` (#3272). With an x402 context it signs only a funding leg of that same shape paying the agent's own delegate EOA, or a settlement child from the agent's own account (#3281). With `task_budget_id` or `sub_budget_id` alone (#3329/#3330, never together with `payment_id`), it fetches and verifies that budget's own child delegation or early-close UserOp, signs it, and names `haven_submit` with `{ task_budget_id | sub_budget_id, signature }` as the next step. |
| `haven_sign_x402` | One-call x402 fast path: funding signature + merchant payment header; signs by `payment_id` ALONE (#1355 — Haven's sign-context re-serves `payment_required`); a caller-supplied `payment_required` is the fallback for pre-#1355 backends |
| `haven_x402_sign_header` | Build and sign the x402 merchant payment header after the Haven funding leg succeeds (decomposed flow) |
| `haven_sign_sweep_delegate` | Sign a Haven-prepared gasless Base-USDC recovery sweep (delegate → the agent's account (Haven wallet) only) |

The signer's ONE network use (#1263) is a read-only fetch of a signing context
from Haven. It fetches by `payment_id` for a payment
(`GET /x402/:id/sign-context`, then `GET /payments/:id/sign-context` for a
direct payment), and by `task_budget_id` / `sub_budget_id` for a budget's own
delegation (`GET /task-budgets/:id/sign-context`,
`GET /sub-budgets/:id/sign-context`). It authenticates with the agent
credential (`identity.json`) that the connector stores next to the signer's key
file. This is what lets the agent relay a small id instead of multi-KB signing
payloads. The request carries the agent API key and the signer's version
header, never the delegate key or a signature. Without `identity.json` the
fetch path refuses; on the `payment_id` path it also names the
`typed_data_b64` fallback. The signer core itself remains network-free.

### 5. Verify The Connection

Ask your agent a read-only question first:

```text
What is my Haven budget?
```

It should call `haven_get_allowances`. The Haven dashboard should show recent
agent activity / last activity after tool calls. Those timestamps and audit
rows are informational; the on-chain policy is still the spend gate — the
signed budget delegation's caveat enforcers. (A legacy Safe account cannot pay
at all since #1986, so there is no second answer here any more.)

Then test a tiny in-budget payment. The expected direct payment sequence is:

> **Re-verified #3495 (2026-09-30):** steps 2 and 3, for the compact-by-default
> result and its opt-in relay. Nothing else in this file was re-verified in
> this pass.

1. Agent calls hosted `haven_pay`.
2. Hosted MCP returns a COMPACT result (#3495, mirroring the x402 quote
   tools' #1272 contract): `{ payment_id, status, idempotency_key,
   payload_hash, expires_at }` — and on a **delegation-rail** account (the
   only rail that can pay) also `signature_scheme` (the Hybrid account
   validates the EIP-712 typed data, and a bare-hash signature is rejected
   on-chain, AA24, #1254) — but NOT `typed_data` / `typed_data_b64` by
   default. `idempotency_key` is generated fresh when the caller passed none,
   and always echoed. Since #3277 it also names the signing handoff:
   `next_tool: haven_sign`, `next_arguments: { payment_id }`, plus a
   `signer_compatibility` notice.
3. Agent calls local `haven_sign` — pass just `payment_id` and let the signer
   fetch the payload (#1263 for x402; for a direct payment since #3271, via
   `GET /payments/:id/sign-context`). On a refusal carrying `fallback:
   'typed_data_b64'` (any code — a currently-published signer's transport
   failure, malformed body, or a 404 on an older backend) or
   `SIGN_CONTEXT_REFUSED` / `sign_context_unavailable` (a signer predating
   #3271, which has no fallback of its own to try), having signed nothing:
   follow the result's notice — re-run `haven_pay` with the SAME
   `idempotency_key` plus `include_signing_payload: true` (the backend
   replays the stored payment rather than creating a second one), then
   re-sign with `{ payload_hash, typed_data_b64 }` from THAT re-run's result,
   passed through UNCHANGED, then update the connector. The legacy rail's
   bare-payload-hash variant is unreachable: that rail is retired (#1440) and
   never returns a signable intent.
4. Agent calls hosted `haven_submit` with `{ payment_id, signature }`.
5. Haven relays the independently valid signed transaction.

If `haven_pay` refuses instead of returning a payment to sign (for example
`DELEGATION_BUDGET_EXCEEDED`), the payment was **declined**: it is not waiting
for anyone. An over-budget request is normally refused before it becomes
signable, so the fix is for the wallet owner to grant or raise the budget in
Haven (or wait for the period to reset) and the agent to retry, never to poll.
A result with `payload_hash: null` is different. Its `idempotency_key` already
belongs to a payment past signing, and it carries that payment's real `status`
(and `tx_hash` once recorded), so there is nothing left to sign.

## What You Can Remove

| Item | Can remove? |
|---|---|
| Old stdio `@haven_ai/mcp` config entry | Yes, if the runtime now uses hosted MCP |
| Local SDK tool-description prompt files | Usually, because hosted MCP declares the tools |
| Local `.env` entry that gives the API key to `@haven_ai/mcp` | Yes for hosted-MCP runtime config |
| Credential file | No; the delegate key is still needed for local signing |
| Local signer/runtime secret handling | No; hosted MCP is keyless |

## Environment Variables

| Variable | Used by | Purpose |
|---|---|---|
| `HAVEN_TOKEN` | Codex CLI example | Bearer token env var used by hosted MCP config |
| `HAVEN_API_KEY` | SDK/curl examples | Agent API key, identity only |
| `HAVEN_MCP_URL` | SDK/curl examples | Hosted MCP endpoint |
| `HAVEN_CREDENTIALS` | `@haven_ai/signer` / local `@haven_ai/mcp` | Path to Haven credential JSON |
| `HAVEN_DELEGATE_KEY` | `@haven_ai/signer` fallback | Delegate signing key when not using a credential file |
| `HAVEN_HOSTED_MCP_URL` | Backend | Hosted MCP URL handed to the connector and dashboard at setup time and in the discovery document; required outside production (falls back to `NEXT_PUBLIC_HAVEN_MCP_URL`, then to the production-only default) |

## Custody Invariant

- The delegate private key never appears in hosted MCP URLs, headers, request
  bodies, logs, or deep links.
- Hosted MCP has no signing path and should fail startup if a delegate key is
  injected.
- API keys identify agents only. They do not authorize payment execution.
- On-chain policy state constrains every automatic payment — the delegation's
  caveat enforcers (budget/recipient/expiry). The Safe AllowanceModule rail is
  **retired**, not retiring: closed to new accounts since #1984 and refusing
  every payment path since #1986.
- Haven can relay independently valid signed transactions, but it cannot move
  funds with the API key alone.

## Troubleshooting

**Unauthorized from hosted MCP**

Confirm the Bearer token is the `api_key`, not the delegate key. If the full
API key was lost, rotate it in Haven and update the runtime config.

**Tools are listed but every call fails**

The hosted server lists its tools for any well-formed Bearer token; the key is
checked only when a tool call reaches Haven. A call failing with
`statusCode: 401` (`Invalid or revoked API key`) means the token is invalid or
revoked: rotate the API key or create a new agent credential. A 403
`agent_pending_approval` means the agent is still waiting for its first budget
grant in Haven; `agent_paused` means the owner paused it.

**Payment is declined as over budget**

The request is outside the remaining on-chain agent budget, so it was refused
(normally before it became signable) — **nothing is queued and nothing is waiting for
you**. Have the wallet owner grant or raise the budget in Haven, then retry.
Polling will not help: there is no pending state to poll.

**Local signer is not available**

Start `npx @haven_ai/signer@alpha --credentials /path/to/haven-agent.json` in the
same agent environment, or configure the agent runtime to sign locally from its
own secret store. Do not send the delegate key to hosted MCP.

**Hosted or serverless agent cannot run a local signer**

Keep the signing key under the agent operator's control and get product, legal,
and security review before introducing any hosted signing arrangement. Haven
must not become the party that holds or operates agent private keys.

Re-verified 2026-10-05 (weekly docs audit #3645, at dev `cdb91d86`), a full
re-read. Changed: the hosted-URL handout (step 3 and the variables table) now
says the backend's `HAVEN_HOSTED_MCP_URL` serves both the dashboard and the
connector — the frontend variable and its not-configured state went with #1823
— which also matches `hosted-mcp.md`; the signer table and its network use name
the task- and sub-budget sign-contexts (#3329/#3330); the decline paragraph
separates a refusal from the #3495 `payload_hash: null` replay; the
troubleshooting entry no longer says a bad key empties the tool list (a live
probe of the dev hosted MCP listed every tool for an invalid key, and the first
call answered 401); and Connect Agent 2's registration names its non-secret
setup metadata. Re-checked without change: the package tags, the signer flags
and variables, the production URL default, the tool names, the erc7710
`haven_submit` header, the hosted boot refusal, and steps 2–4.

## Related Docs

- [Hosted MCP deploy guide](./hosted-mcp.md)
- [Architecture - hosted MCP connect flow](../architecture/06-hosted-mcp-connect-flow.md)
- [Edge signer](../architecture/07-edge-signer.md)
- [Regulatory guardrails (CASP / MiCA)](../regulatory/casp-risk-guardrails.md)
