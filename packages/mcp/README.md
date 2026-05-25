# Haven MCP server

`@haven_ai/mcp` exposes Haven payment primitives as local MCP tools. It is a
thin wrapper around `@haven_ai/sdk`.

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
- `haven_quote_mpp`
- `haven_pay_mpp_challenge`
- `haven_resume_mpp_payment`
- `haven_get_payment_status`
- `haven_get_resume_state`
- `haven_get_agent`
- `haven_get_allowances`
- `haven_list_receipts`

## Manual sanity test

1. Start Claude Desktop or another MCP client with the config above.
2. Call `haven_get_agent` and confirm it returns the expected Haven wallet and
   delegate address.
3. Call `haven_quote_x402` for a paid test URL.
4. Call `haven_pay_x402_quote` with the returned quote.
5. If the result has `nextAction: "wait_for_user_approval"`, approve in Haven,
   then call `haven_resume_x402_payment` with the returned `resume_state` or
   `payment_id`.

The MPP flow is equivalent: `haven_quote_mpp`, `haven_pay_mpp_challenge`, then
`haven_resume_mpp_payment` after approval when needed.

## Non-custodial invariant

Do not run this as a hosted multi-tenant signer. The expected deployment is
`npx @haven_ai/mcp` running beside the agent runtime that owns the credential
file. Revoking the agent on-chain disables spending even if this MCP server is
still running.
