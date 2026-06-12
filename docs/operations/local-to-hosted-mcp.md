# Migration - Local MCP To Hosted MCP

> **Scope:** This guide is for agents with an **existing local MCP setup**. New
> agents do not need it — Connect Agent 2 creates the hosted-MCP + local-signer
> split automatically. For the deployment model tradeoff, see
> [architecture/10-local-vs-hosted-mcp.md](../architecture/10-local-vs-hosted-mcp.md);
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
  -> hosted MCP relays { payment_id, signature }
  -> Haven backend -> Safe AllowanceModule -> on-chain
```

The split is deliberate:

- Hosted MCP receives the API key as identity only.
- Hosted MCP never receives the delegate private key.
- The local runtime or `@haven_ai/signer` signs payment hashes.
- Only `{ payment_id, signature }` goes back to hosted MCP for relay.
- On-chain Safe AllowanceModule state remains the spend gate.

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
delegate private key. If the delegate key is gone, pause or revoke the agent
and create a new signing path.

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
current default can also be overridden in deployments with
`NEXT_PUBLIC_HAVEN_MCP_URL`.

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
`haven_x402_authorize`.

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
| `haven_sign` | Sign the `payload_hash` returned by hosted `haven_pay` or `haven_x402_authorize` |
| `haven_x402_sign_header` | Build and sign the x402 `X-PAYMENT` header after the Haven funding leg succeeds |

The signer does not need the API key and makes no network calls. It reads the
delegate key locally and emits signatures/headers only.

### 5. Verify The Connection

Ask your agent a read-only question first:

```text
What is my Haven budget?
```

It should call `haven_get_allowances`. The Haven dashboard should show recent
agent activity / last activity after tool calls. Those timestamps and audit
rows are informational; the Safe AllowanceModule is still the spend gate.

Then test a tiny in-budget payment. The expected direct payment sequence is:

1. Agent calls hosted `haven_pay`.
2. Hosted MCP returns `{ payment_id, payload_hash, expires_at }`.
3. Agent calls local `haven_sign` with the payload hash.
4. Agent calls hosted `haven_submit` with `{ payment_id, signature }`.
5. Haven relays the independently valid signed transaction.

If `haven_pay` returns `pending_approval`, there is no hash to sign. The user
must approve the action in Haven, and the agent should poll status rather than
creating duplicate payments.

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
- On-chain Safe AllowanceModule state constrains every automatic payment.
- Haven can relay independently valid signed transactions, but it cannot move
  funds with the API key alone.

## Troubleshooting

**Unauthorized from hosted MCP**

Confirm the Bearer token is the `api_key`, not the delegate key. If the full
API key was lost, rotate it in Haven and update the runtime config.

**Tools list is empty**

The token may be invalid, revoked, or tied to an inactive agent. Rotate the API
key or create a new agent credential.

**Payment returns pending approval**

The request is outside the remaining on-chain agent budget. Open Haven,
approve or reject the action, then have the agent poll status or resume the
payment when Haven reports the correct next action.

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
