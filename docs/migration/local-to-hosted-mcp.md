# Migration — Local MCP → Hosted MCP

Migrating from the local `npx @haven_ai/mcp` stdio server to the new
hosted, edge-signing MCP server introduced in Epic #181.

> **TL;DR** — Replace your `claude mcp add` command (or JSON config block)
> with one that points at `https://mcp.haven.ai/v1` and carries your Haven
> API key as a Bearer token.  Keep your credential file where it is — the
> signing key stays on your machine.

---

## What changed and why

### Old approach — local stdio server

```
  Agent client (Claude Code / Cursor)
       │
       ▼ stdio
  npx @haven_ai/mcp
  [reads HAVEN_CREDENTIAL_FILE]
       │ HTTP (API key + delegate key in process)
       ▼
  Haven backend
```

- The MCP server ran locally (via `npx`) and held the full credential
  (both the API key **and** the delegate private key) in its process memory.
- Reinstalling on every new machine, CI runner, or Docker container was
  required.
- Any process-level compromise could expose the delegate private key.

### New approach — hosted MCP + edge signing

```
  Agent client (Claude Code / Cursor / SDK)
       │
       ▼ HTTP (Bearer sk_agent_…)
  Haven hosted MCP  ← identity only, no key
  [at mcp.haven.ai/v1]
       │ hash to sign
       ▼
  Edge signer callback (your machine / sidecar)
  [reads delegate key, signs hash, returns signature]
       │ signature only
       ▼
  Haven backend  →  Safe Allowance Module  →  on-chain
```

- The MCP server is fully managed — no local install, no `npx`.
- The **delegate private key never crosses the wire**.  The hosted server
  asks you to sign a hash; only `{payloadHash, signature}` is returned.
- Runtimes (Claude Code, Claude Desktop, Cursor, any MCP SDK) connect to the
  same stable URL.

---

## Step-by-step migration

### 1 · Get your credential file

If you followed the original setup you already have a credential file at
`~/.haven/credential.json`.  It contains both the API key and the delegate
private key.

If you don't have it:

1. Open the Haven app → **Agents** → select your agent → **Show credentials**.
2. Click **Save signing key** — this downloads the key to `~/.haven/` and
   records its SHA-256 so Haven can verify custody later.

### 2 · Remove the old local MCP entry

**Claude Code:**
```bash
claude mcp remove haven
```

**Claude Desktop / Cursor — JSON config:**

Open your MCP config file and delete the `haven` entry from `mcpServers`:

```jsonc
// ← remove this block
"haven": {
  "command": "npx",
  "args": ["@haven_ai/mcp"],
  "env": { "HAVEN_CREDENTIAL_FILE": "..." }
}
```

### 3 · Add the hosted MCP

#### Claude Code (CLI)

```bash
claude mcp add --transport http haven \
  https://mcp.haven.ai/v1 \
  --header "Authorization: Bearer sk_agent_YOUR_KEY"
```

Replace `sk_agent_YOUR_KEY` with the `api_key` from your credential file.

#### Claude Desktop — one-click (recommended)

In the Haven app → **Agents** → **Connect** → click **Claude Desktop** tab →
click **Add to Claude**.  This opens the `claude://` deep link and installs
the connection automatically.

#### Claude Desktop — manual JSON config

Open `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) and add:

```json
{
  "mcpServers": {
    "haven": {
      "url": "https://mcp.haven.ai/v1",
      "headers": {
        "Authorization": "Bearer sk_agent_YOUR_KEY"
      }
    }
  }
}
```

Restart Claude Desktop.

#### Cursor — one-click (recommended)

In the Haven app → **Agents** → **Connect** → click **Cursor** tab →
click **Add to Cursor**.

#### Cursor — manual

Open Cursor's MCP settings and add the same JSON block shown for Claude
Desktop above.

#### Any MCP SDK / custom agent

```bash
# Environment
HAVEN_MCP_URL=https://mcp.haven.ai/v1
HAVEN_API_KEY=sk_agent_YOUR_KEY

# Verify tools are available
curl -X POST "$HAVEN_MCP_URL" \
  -H "Authorization: Bearer $HAVEN_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 4 · Run the edge signer

The hosted MCP needs a local callback to sign payment hashes.  Haven provides
a lightweight sidecar that listens for signing requests, reads the delegate
key from the credential file, and returns the signature — without ever sending
the key over the wire.

```bash
# One-time install (or keep using npx for zero-install)
npm install -g @haven_ai/mcp

# Start the signer sidecar (keeps running alongside your agent session)
haven-signer --credential ~/.haven/credential.json

# Or as a one-liner for CI / ephemeral sessions
HAVEN_CREDENTIAL_FILE=~/.haven/credential.json npx @haven_ai/mcp --signer-only
```

> **What the signer exposes:** a localhost-only HTTP endpoint
> (default `127.0.0.1:3100`).  The hosted MCP calls `POST /sign` with
> `{payloadHash}` and receives `{signature}`.  The delegate private key
> never leaves the signer process.

### 5 · Verify the connection

Ask your agent anything that triggers a Haven tool:

```
User: What's my Haven budget?
```

If the connection is live you'll see a **Connected** badge on the Haven app's
agent card within a few seconds.  The badge is driven by `mcp_last_seen_at` —
the timestamp of the most recent tool invocation — polled every 3 s until
connected and every 10 s thereafter.

To confirm the signer is working end-to-end, trigger a small in-budget
payment and check the transaction feed in the Haven app.

---

## What you can remove

Once the hosted MCP is working you no longer need:

| Item | Can remove? |
|---|---|
| `@haven_ai/mcp` in project dependencies | ✅ Yes |
| `AGENTS.md` / `CLAUDE.md` with SDK tool descriptions | ✅ Yes — tools are now declared by the hosted server |
| Local `.env` with `HAVEN_DELEGATE_KEY` | ✅ Yes — key stays in credential file, read by signer only |
| `stdio` MCP config entries for Haven | ✅ Yes — replaced by the HTTP config above |
| The signer sidecar | ❌ No — still needed for signing payment hashes |
| Your credential file (`~/.haven/credential.json`) | ❌ No — the signer reads it at signing time |

---

## Environment variables reference

| Variable | Used by | Purpose |
|---|---|---|
| `HAVEN_CREDENTIAL_FILE` | Signer sidecar | Path to the credential JSON |
| `HAVEN_MCP_URL` | SDK / curl examples | Hosted MCP base URL |
| `HAVEN_API_KEY` | SDK / curl examples | Agent API key (identity) |
| `NEXT_PUBLIC_HAVEN_MCP_URL` | Frontend | Override the default `mcp.haven.ai` URL |

---

## Custody invariant (unchanged)

The fundamental custody guarantee is **the same** as with the local server:

- The delegate private key never appears in any HTTP request URL, body, or
  header.  See [the regulatory guardrails](../regulatory/casp-risk-guardrails.md)
  and the tests in `packages/mcp/src/tools.test.ts` (tagged `[#190]`) that
  enforce this invariant in CI.
- On-chain spend limits (Safe Allowance Module) constrain every payment
  regardless of what the hosted MCP or the backend database say.
- Haven cannot spend user funds — it can only relay transactions that are
  within limits you approved on-chain.

---

## Troubleshooting

**"Unauthorized" from the hosted MCP**

Your `Authorization` header is missing or the API key is wrong.  Confirm the
key matches the `api_key` field in your credential file, not the delegate
private key.

**Tools list is empty / tools not found**

The hosted MCP only exposes Haven tools.  If you see an empty list, the
Bearer token may be for a revoked or inactive agent.

**Payment fails with "pending_approval" / over-budget**

The agent's Safe Allowance Module headroom is exhausted.  Open the Haven app
→ **Approvals** to review and approve the pending payment.  After approval the
agent can retry.

**Signer not responding**

Check that `haven-signer` (or `npx @haven_ai/mcp --signer-only`) is running.
The hosted MCP logs a `signer_unavailable` error when it can't reach the
callback URL.  The signer must be reachable from wherever the hosted MCP
server makes outbound connections.

> For hosted or serverless agents where you can't run a sidecar, contact
> Haven — a managed signing service is on the roadmap.

---

## Related docs

- [Hosted MCP deploy guide](deploy/hosted-mcp.md)
- [Architecture — hosted MCP connect flow](architecture/06-hosted-mcp-connect-flow.md)
- [Regulatory guardrails (CASP / MiCA)](regulatory/casp-risk-guardrails.md)
