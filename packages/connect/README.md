# @haven_ai/connect

Connect Agent 2 local connector.

This command runs in the user's agent environment. It generates the agent
signing key and API key locally, stores them locally, and sends Haven only the
public signing address, proof signature, and API-key hash. Haven never receives
the private key or plaintext API key.

```sh
npx -y @haven_ai/connect@alpha --setup hv_setup_... --api https://api.haven.example --ack-local-tools --runtime claude-code
```

The connector writes owner-only credential files outside the project by default:

- `~/.haven/agents/<agent-id>/identity.json` contains the Haven API key.
- `~/.haven/agents/<agent-id>/signer.json` contains the local signer key.

The API key identifies the agent. It cannot spend by itself. Payments still need
the locally held signer key and the user-approved on-chain Haven wallet rules.

Use `--credentials-dir <path>` to choose a different local credential directory.
Do not point it at a project repository, shared folder, or cloud-synced folder.

Use `--ack-local-tools` with Haven-generated setup prompts. It prepares the
local Haven tools acknowledgement during setup so Codex and Claude Code can load
Haven after a normal restart.

## Supported runtimes

The default setup writes the hosted Haven MCP (using the agent API key for
identity) plus a separate local signer. The API key identifies the agent; the
locally held signer key and the user's approved Haven wallet rules remain the
spending authority.

| Runtime | Configuration written by setup | Activate the new entry |
| --- | --- | --- |
| Claude Code | User MCP registry | Start a new Claude Code session. |
| Codex CLI | `~/.codex/config.toml` | Start a fresh session, for example `codex resume --last`. |
| Codex Desktop | `~/.codex/config.toml` | Quit and reopen the app. |
| Cursor | Cursor MCP configuration | Wait for hot reload; no app restart is required. |
| VS Code / VS Code Insiders | VS Code MCP configuration | Wait for hot reload; no app restart is required. |
| Claude Desktop | Claude Desktop MCP configuration | Quit and reopen the app. |
| Hermes Agent | `$HERMES_HOME/config.yaml` + `.env`, or `~/.hermes/config.yaml` + `.env` | Start a new session; gateway users run `/restart`. |

## After setup

1. Return to Haven and approve the agent rules. Approval — not restarting —
   unlocks the Haven tools.
2. Activate the runtime using the table above.
3. In the activated runtime, run the read-only `haven_get_agent` and
   `haven_get_allowances` tools to confirm the Haven wallet and live budget.
   Do not sign, fund, or create a payment to verify setup.

If the setup challenge expires, return to Haven to start a fresh connection and
rerun Connect. If a runtime write, installation, or probe fails, resolve the
reported problem, return to Haven for a fresh connection, and run its new
Connect command. Do not manually edit runtime configuration or paste credentials
into prompts, logs, or configuration files.

Connect abbreviates the public delegate address in normal output. Operators who
need its full public identifier can inspect the owner-only, non-secret
`agent.json` orientation file that Connect reports; do not inspect or share
`identity.json` or `signer.json` for diagnostics because they contain secrets.

For Hermes, Connect stores the hosted-MCP API key in the matching owner-only
`.env` file and keeps only `Bearer ${MCP_HAVEN_API_KEY}` in `config.yaml`.
Hermes requires its Python MCP SDK support to be installed. If Haven tools do
not appear after restart, run `pip install mcp` in the Hermes environment, then
restart Hermes and check `hermes mcp list`.
