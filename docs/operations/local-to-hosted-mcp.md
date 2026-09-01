---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp/**
  - packages/mcp-server/**
  - packages/signer/**
last-verified: "2026-08-27" # #2102: five places where this doc contradicted itself or described dead state. The ASCII diagram and the Verify-The-Connection walkthrough both presented AllowanceModule-vs-delegation as a live either/or, nine and a hundred-odd lines from this doc's own "The Safe AllowanceModule is **retired**… a legacy Safe account cannot pay at all". The custody bullet said the rail was "retiring", present tense, contradicting the same line. And the `haven_pay` step plus the "Payment returns pending approval" troubleshooting entry told a reader to approve in Haven and poll — for a state #2055 removed, sending them to a deleted screen. Restated as declined-before-signable throughout. Scope: those five; the migration/setup walkthroughs and the custody-direction bullets were not re-read. Prior: #2041: the custody bullet list enumerated the two directions signed material crosses the local/hosted boundary and missed the third this change adds -- on the erc7710 scheme `haven_submit` RETURNS an assembled `payment_header` rather than relaying a funding signature. One bullet added; the migration, setup and direct-payment walkthroughs make no claim about per-tool argument shapes and are untouched. Scope: that bullet only. Prior: #1992: three claims corrected against the retirement - the spend-gate bullet still listed "the Safe AllowanceModule on imported legacy Safes" as a live gate, "(the base for new accounts)" implied a second rail still took payments, and the `haven_sign` step still documented a legacy-rail bare-payload-hash variant that is unreachable because the rail never returns a signable intent. Scope: those three places. Prior: #1984: "the legacy import-only rail" corrected — the rail is closed to new accounts entirely. The hosted-MCP trust claims around it re-read and unchanged: on-chain policy still constrains every automatic payment on both rails. Prior: #1702: the delegate-key-loss answer here was the PRE-#1694 one — "pause or revoke the agent and create a new key path". Epic #1694 made a delegation-rail agent's key REPLACEABLE (re-key: same agent, new key, budget remainder and period boundary carried), so the guidance is now split by rail rather than stated as one blanket answer. Found by the cross-epic doc sweep #1702's acceptance criteria asked for, not by the coupling gate — no `covers:` glob connects this file to `routes/agent-rekey.ts`. This doc names both rails a few lines above, so a single answer was actively wrong here rather than merely incomplete. Scope: the delegate-key paragraph only. Prior: #1813: dropped two `covers:` entries for libs deleted as unreachable (`hosted-connect.ts`, `agent-runtime-snippets.ts`). The body's only related line — NEXT_PUBLIC_HAVEN_MCP_URL rendered in connect-agent snippets — is still accurate; those snippets come from the live ConnectAgentModal path. Prior: re-verified for #1352 (Node floor 24->22: engines/constant only; grep-checked: no numeric floor claim in this doc; floor prose lives in mcp-runtime-compatibility.md)
---

# Migration - Local MCP To Hosted MCP

> **Scope:** This guide is for agents with an **existing local MCP setup**. New
> agents do not need it — Connect Agent 2 creates the hosted-MCP + local-signer
> split automatically. For the deployment model tradeoff, see
> [architecture/08-local-vs-hosted-mcp.md](../architecture/08-local-vs-hosted-mcp.md);
> to deploy the hosted server, see [hosted-mcp.md](hosted-mcp.md).

Migrating from the local `npx @haven_ai/mcp` stdio server to hosted, keyless
MCP plus local signing.

TL;DR: point your agent runtime at the hosted MCP URL with the Haven API key as
a Bearer token. Keep the delegate signing key local. Hosted MCP constructs and
relays; the local runtime or `@haven_ai/signer` signs.

## What Changed

### Old Approach: Local Stdio MCP

```text
Agent runtime
  -> local npx @haven_ai/mcp
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
key on the user's machine, and Haven receives only the public signing address,
proof, API-key hash/prefix, and install status before wallet approval. This
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
[Replacing an agent's signing key](../product/agent-key-rotation.md)), while a
**legacy AllowanceModule** agent has no delegation to revoke and re-issue, so
it is paused or revoked and re-onboarded.

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

Use the hosted URL shown in the Haven app's **Connect your agent** flow. The
production URL below is a built-in default only on the production deployment
itself (#1129); every other environment sets its own endpoint via
`NEXT_PUBLIC_HAVEN_MCP_URL` (frontend) / `HAVEN_HOSTED_MCP_URL` (backend), and
shows a not-configured state instead of another environment's URL when unset.

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
`haven_pay_x402_quote`.

### 4. Add Local Signing

Hosted MCP does not sign. The agent must sign locally, either with its own
runtime secret handling or with `@haven_ai/signer`.

```sh
npx @haven_ai/signer --credentials /path/to/haven-agent.json --ack
```

After acknowledgement, run it normally beside the agent runtime:

```sh
npx @haven_ai/signer --credentials /path/to/haven-agent.json
```

The signer exposes local stdio MCP tools:

| Tool | Purpose |
|---|---|
| `haven_sign` | Sign a payment: `payload_hash` (legacy rail), the delegation-rail EIP-712 `typed_data`/`typed_data_b64`, or just `payment_id` (#1263 — the signer fetches the exact payload itself) |
| `haven_sign_x402` | One-call x402 fast path: funding signature + merchant payment header; signs by `payment_id` ALONE (#1355 — Haven's sign-context re-serves `payment_required`); a caller-supplied `payment_required` is the fallback for pre-#1355 backends |
| `haven_x402_sign_header` | Build and sign the x402 merchant payment header after the Haven funding leg succeeds (decomposed flow) |
| `haven_sign_sweep_delegate` | Sign a Haven-prepared gasless Base-USDC recovery sweep (delegate → own Safe only) |

The signer's ONE network use (#1263) is a read-only fetch of a pending
payment's signing context from Haven by `payment_id`, authenticated with the
agent credential (`identity.json`) the connector stores next to the signer's
key file — this is what lets the agent relay a small id instead of multi-KB
signing payloads. It never sends the key, a signature, or anything else
outbound; without `identity.json` the fetch path refuses and names the
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

1. Agent calls hosted `haven_pay`.
2. Hosted MCP returns `{ payment_id, payload_hash, expires_at }` — and on a
   **delegation-rail** account (the only rail that can pay) also
   `signature_scheme`, `typed_data` and `typed_data_b64`: the Hybrid account
   validates the EIP-712 typed data, and a bare-hash signature is rejected
   on-chain (AA24, #1254).
3. Agent calls local `haven_sign` — pass `typed_data_b64` UNCHANGED (or, for
   x402 intents, just `payment_id` and let the signer fetch the payload, #1263).
   The legacy rail's bare-payload-hash variant is unreachable: that rail is
   retired (#1440) and never returns a signable intent.
4. Agent calls hosted `haven_submit` with `{ payment_id, signature }`.
5. Haven relays the independently valid signed transaction.

If `haven_pay` does not return a hash, the payment was **declined** — it is not
waiting for anyone. An over-budget request is refused before it becomes
signable, so the fix is for the wallet owner to grant or raise the budget in
Haven and the agent to retry, never to poll.

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
| `NEXT_PUBLIC_HAVEN_MCP_URL` | Frontend | Hosted MCP URL rendered in connect-agent snippets |

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

**Tools list is empty**

The token may be invalid, revoked, or tied to an inactive agent. Rotate the API
key or create a new agent credential.

**Payment is declined as over budget**

The request is outside the remaining on-chain agent budget, so it was refused
before it became signable — **nothing is queued and nothing is waiting for
you**. Have the wallet owner grant or raise the budget in Haven, then retry.
Polling will not help: there is no pending state to poll.

**Local signer is not available**

Start `npx @haven_ai/signer --credentials /path/to/haven-agent.json` in the
same agent environment, or configure the agent runtime to sign locally from its
own secret store. Do not send the delegate key to hosted MCP.

**Hosted or serverless agent cannot run a local signer**

Keep the signing key under the agent operator's control and get product, legal,
and security review before introducing any hosted signing arrangement. Haven
must not become the party that holds or operates agent private keys.

## Related Docs

- [Hosted MCP deploy guide](./hosted-mcp.md)
- [Architecture - hosted MCP connect flow](../architecture/06-hosted-mcp-connect-flow.md)
- [Edge signer](../architecture/07-edge-signer.md)
- [Regulatory guardrails (CASP / MiCA)](../regulatory/casp-risk-guardrails.md)
