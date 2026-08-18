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

### Structured output for automation

Pass `--json` when a launcher needs a machine-readable completion record. Connect
writes progress and human recovery notes to stderr and exactly one JSON object
to stdout, with `schema_version: 1` and `outcome` set to `complete`,
`action_required`, or `failed`. The object includes runtime/topology status,
probe result, activation and next-action guidance, approval state/expiry (null
when the backend does not provide an approval expiry), and the two
read-only verification tools. It contains no API key, private key, credential
contents, full credential paths, or full delegate address. The same redacted
object is available to library callers as `runConnect(...).outcome`; the older
fields remain for additive compatibility.

For a recoverable install, configuration, probe, consent, or manual-runtime
condition, inspect `error.code` and `error.next_action`, then follow the safe
next action. A failed setup emits `outcome: "failed"` with a stable error code;
it never presents credential material as a recovery diagnostic.

If the setup challenge expires, return to Haven to start a fresh connection and
rerun Connect. If a runtime write, installation, or probe fails, follow the
structured `error.next_action` (or its human equivalent). The `other` runtime
is the manual exception: finish the secret-free file-reference setup it prints,
then start a fresh runtime session. Do not manually edit managed runtime
configuration or paste credentials into prompts, logs, or configuration files.

Connect abbreviates the public delegate address in normal output. Operators who
need its full public identifier can inspect the owner-only, non-secret
`agent.json` orientation file that Connect reports; do not inspect or share
`identity.json` or `signer.json` for diagnostics because they contain secrets.

For Hermes, Connect stores the hosted-MCP API key in the matching owner-only
`.env` file and keeps only `Bearer ${MCP_HAVEN_API_KEY}` in `config.yaml`.
Hermes requires its Python MCP SDK support to be installed. If Haven tools do
not appear after restart, run `pip install mcp` in the Hermes environment, then
restart Hermes and check `hermes mcp list`.

## Running setup again

Each setup prompt is one-time and each successful run creates a **new** agent
with its own freshly minted key pair. Re-running Connect on an
already-configured machine behaves as follows (characterized in
`storage.test.ts`, `config-writers.test.ts`, and `runtime.test.ts`, #1544):

- **Re-running an already-consumed setup command** fails cleanly before any
  credential file or runtime configuration is touched — Haven refuses the
  consumed setup when Connect resolves it (or, in a rare concurrent-run race,
  at registration). The key pair minted for the attempt exists only in memory
  and is discarded. Start a fresh connection from the Haven dashboard instead.
- **Running a fresh setup on a configured machine** writes the new agent's
  credentials into its own directory under `~/.haven/agents/<agent-id>/`,
  alongside the previous agent's directory, which stays byte-identical.
  Nothing is rotated, revoked, or deleted locally.
- **Runtime MCP entries are replaced, not duplicated**: Connect owns the
  `haven` and `haven-signer` entries (and the managed Codex/Hermes
  equivalents) and re-points them at the newest agent's credentials.
  Unrelated MCP servers and configuration are preserved. One runtime is
  therefore wired to one Haven agent — the newest one. Known exception
  ([#1569](https://github.com/d-hinders/Haven-AI/issues/1569)): Claude Code's
  opt-in local-stdio mode (`--local`) does not yet replace a pre-existing
  `haven` entry on a re-run — the config update fails and the runtime stays
  wired to the previous agent's local MCP wrapper; run
  `claude mcp remove haven` and re-run setup. The default hosted topology
  replaces both entries.
- **The previous agent is not revoked by a re-run.** Its credentials remain on
  disk and its authority remains whatever its on-chain rules say. Revoke
  agents you no longer use from the Haven dashboard, then delete their
  credential directories.
- **Connect never overwrites an existing credential file.** A write that would
  collide with an existing `identity.json`/`signer.json`/`agent.json` is
  refused outright (and a partially failed write rolls itself back), so a
  re-run cannot corrupt stored key material.
