# Haven MCP server

`@haven_ai/mcp` exposes Haven payment primitives as local MCP tools. It is a
thin wrapper around `@haven_ai/sdk`.

For Codex CLI and Claude Code setup, the Haven app leads with this local stdio
server so a normal restart can load Haven tools without shell environment
setup. Hosted MCP plus a separate local edge signer remains a fallback shape for
other runtimes.

The server is intentionally local-only:

- It runs in the agent operator's environment, usually as a stdio subprocess.
- It reads `api_key` and `delegate_key` from a local credential file.
- It signs locally with the delegate key.
- Haven's backend receives API identity plus signed payloads. It never receives
  the delegate key.

## Credential file

Create a private JSON file from the values in the Haven agent handoff:

```json
{
  "api_key": "sk_agent_...",
  "delegate_key": "0x...",
  "agent_id": "agent-id",
  "safe_address": "0xYourHavenWallet",
  "api_url": "https://havenbackend.example"
}
```

`delegate_key` is required. Without it the MCP server cannot sign locally.

The Haven connector may also write split credentials:

```sh
npx @haven_ai/mcp@alpha --identity ~/.haven/agents/<agent-id>/identity.json --signer ~/.haven/agents/<agent-id>/signer.json
```

`identity.json` holds the local API key and setup metadata. `signer.json` holds
the delegate key. Both files stay on the user's machine.

### Credential file permissions

The credential file contains a private key. Restrict it to your user
immediately after downloading:

- macOS / Linux: `chmod 600 /path/to/haven-agent.json`
- Windows (PowerShell): `icacls "path\to\haven-agent.json" /inheritance:r /grant:r "$env:UserName:R"`

On POSIX systems the MCP server checks the file's mode bits at load time and
prints a warning to stderr if it's readable beyond the owner (e.g. world-
or group-readable). It does not refuse to start — some controlled
deployments intentionally widen access — but unattended warnings are a
strong signal something needs tightening. Avoid storing credentials in
cloud-synced folders (iCloud, Dropbox, OneDrive) or shared dotfile
repositories.

## Claude Desktop

```json
{
  "mcpServers": {
    "haven": {
      "command": "npx",
      "args": ["@haven_ai/mcp", "--credentials", "/absolute/path/to/haven-agent.json"]
    }
  }
}
```

Environment variable form:

```json
{
  "mcpServers": {
    "haven": {
      "command": "npx",
      "args": ["@haven_ai/mcp"],
      "env": {
        "HAVEN_CREDENTIALS": "/absolute/path/to/haven-agent.json"
      }
    }
  }
}
```

## Tools

- `haven_quote_x402`
- `haven_pay_x402_quote`
- `haven_resume_x402_payment`
- `haven_get_payment_status`
- `haven_get_resume_state`
- `haven_get_agent`
- `haven_get_allowances`
- `haven_discover_tools`
- `haven_submit_catalog_entry`
- `haven_list_receipts`

## First-launch consent

The first time the MCP server runs against a credential file it refuses to
start until you've acknowledged what tools it exposes and what the agent can
actually spend.

On first launch you'll see something like this on stderr:

```
Haven MCP server — first-launch consent
────────────────────────────────────────────────────────────
Credential: sk_agent_ab…

Tools this server will expose to your agent runtime:
  • haven_pay_x402_quote
      Pay a previously inspected x402 quote …
  • haven_get_allowances
      Return configured and on-chain allowance state …
  …

On-chain budget (the real spend gate — enforced by the agent's
signed delegation, not by Haven):
  • up to 50.000000 USDC per 1440 min

Anything above the on-chain budget is declined before any money
moves — it is not queued, and no one is asked to review it. If the
agent needs more room, the wallet owner grants or raises the budget
in Haven. Revoking the agent on-chain disables every MCP tool that
would spend.

Consent hash: 6f4b…d1a2
```

Acknowledge in one of two ways:

- **Sidecar file (recommended).** Re-run once with `--ack`:

  ```sh
  npx @haven_ai/mcp@alpha --credentials /absolute/path/to/haven-agent.json --ack
  ```

  This writes `haven-agent.json.ack.json` next to your credential. Future
  launches pick it up automatically. When the tool set or your on-chain
  allowance changes, the hash changes and you'll be re-prompted.
  For split credentials, the sidecar is written next to `identity.json`.

- **Environment variable.** Copy the printed hash and set
  `HAVEN_MCP_ACK=<hash>` in the MCP client's `env` block. Useful for
  Claude Desktop configs that prefer environment over filesystem state.

For CI or scripted setups, `HAVEN_MCP_ACK=skip` bypasses the gate entirely.
Do not set this for human-operated installs — the consent block is the only
place a wallet owner is shown the real on-chain allowance before tools go
live.

## Audit log

Every MCP tool invocation tags the underlying Haven API call with
`X-Haven-MCP-Tool: <tool_name>`. The backend records one
`agent_tool_invocations` row per call (tool name, payment id when present,
result status, nextAction, error code, HTTP status, timestamp). The agent's
activity feed in the Haven dashboard surfaces these rows alongside payments,
so the wallet owner can see exactly which tools the
agent called and what happened — even for read-only calls that don't move
money.

The audit log is informational. The agent's signed budget delegation — its
on-chain caveat enforcers — remains the only thing that can stop a spend;
revoking the agent on-chain disables every MCP tool that would settle,
regardless of audit state.

## Manual sanity test

1. Start Claude Desktop or another MCP client with the config above.
2. Call `haven_get_agent` and confirm it returns the expected Haven wallet and
   delegate address.
3. Call `haven_quote_x402` for a paid test URL.
4. Call `haven_pay_x402_quote` with the returned quote.
5. The pay tool performs the merchant retry itself, so a successful call needs
   no follow-up. If the call is declined for budget, raise the agent budget in
   Haven and repeat from step 4 — Haven holds no approval queue, so there is
   nothing to wait for. If the process crashes after payment, a later
   `haven_get_payment_status` call may report
   `nextAction: 'retry_original_x402_request'` — only then call
   `haven_resume_x402_payment` with the preserved resume state or payment id;
   do not call it speculatively.

The legacy MPP demo flow is retired (#1328) — pay through the x402 merchant
flow above instead.

## Non-custodial invariant

Do not run this as a hosted multi-tenant signer. The expected deployment is
`npx @haven_ai/mcp@alpha` running beside the agent runtime that owns the credential
file. Revoking the agent on-chain disables spending even if this MCP server is
still running.
