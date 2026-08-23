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

1. Return to Haven and approve the budget. Approval — not restarting —
   unlocks the Haven tools.
2. Activate the runtime using the table above.
3. In the activated runtime, run the read-only `haven_get_agent` and
   `haven_get_allowances` tools to confirm the Haven wallet and live budget.
   Do not sign, fund, or create a payment to verify setup.

### `--doctor` reports every agent, not just one (#1697)

With several agents wired into one runtime (`--name`), the doctor enumerates
every credential directory on the machine and classifies each one:

| Classification | Meaning |
| --- | --- |
| `wired` | Its MCP pair is present in this runtime's config. Fully checked. |
| `superseded` | It holds credentials, but no config entry points at it. Reported, never silently skipped — its API key may still spend. |
| `retired` | Tombstoned (see below); key material removed. |
| `orphaned` | No usable identity and no tombstone. |

The exit code is non-zero if **any** wired agent fails **any** check — not
only the one the report's main section describes. In `--json`, the same
information is on `agents[]`, each entry carrying `slug`, `agentId`,
`directory`, `classification` and its own `checks[]`; the flat `checks` array
is retained and still describes one agent, so a single-agent install reads as
it always did.

One check is worth calling out: **`identity_match`** compares the agent the
stored API key actually authenticates as against the `delegate_address` in
that directory's `signer.json`. A mismatch means the runtime would quote as
one agent and sign as another, and it fails hard. This is the half of that
hazard a local tool can know — the doctor still cannot see inside an
already-running host, which is why the restart guidance below matters.

## Retiring an old agent directory

Re-running setup creates a NEW agent and retires nothing. Long-lived MCP hosts
(gateways, TUI workers, editors, desktop apps) load their MCP wiring once, at
process start — a host started before your latest setup keeps spawning the OLD
agent's signer path forever, and when that directory is later removed the spawn
failure surfaces only as a masked "Connection closed" retried every few
minutes. Two rules follow:

1. **Restart EVERY long-lived host after a setup or retirement, not just one.**
   Each process holds the snapshot from its own start time, so after a chain of
   re-setups each host can be parked on a *different* old agent.
2. **Tombstone a directory before (or instead of) deleting it:**

   ```
   npx @haven_ai/connect@alpha --tombstone ~/.haven/agents/<id> --reason "superseded"
   ```

   This replaces the directory's signer wrapper with a diagnostic that logs the
   retirement (agent id, date, reason, restart guidance) to the host's MCP
   stderr log on every probe, and records it in `TOMBSTONE.json` for
   `--doctor`. It touches no key material and revokes nothing — revoke the
   agent on the Haven agent page yourself. Delete the tombstone only once every
   long-lived host has been restarted.

### Structured output for automation

Pass `--json` when a launcher needs a machine-readable completion record. Connect
writes progress and human recovery notes to stderr and exactly one JSON object
to stdout, with `schema_version: 1` and `outcome` set to `complete`,
`action_required`, or `failed`. Structured runs skip the interactive
budget-approval wait so the record is emitted promptly; approve in the Haven
dashboard whenever ready and verify later with the read-only `haven_get_agent`
tool. The object includes runtime/topology status,
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

## Why there is no pre-registration confirmation prompt

Connect mints a signing key and registers the agent as soon as it runs, without
an extra "about to create agent X, proceed?" gate. That is deliberate: the
consent already happened when the user minted the one-time setup prompt in the
Haven dashboard, which enumerates exactly what the command may do. The setup
stays cancellable from the dashboard throughout, and the registered agent
starts `pending_approval` with zero spend authority — nothing can move funds
until the user approves the budget in Haven. A CLI-side confirmation would add
friction without adding a security boundary. (The local-signer tool-exposure
acknowledgement is a separate, machine-checkable consent about what the local
MCP tools expose, not a registration gate.)

## Running setup again

Each setup prompt is one-time and each successful run creates a **new** agent
with its own freshly minted key pair. Re-running Connect on an
already-configured machine behaves as follows (characterized in
`storage.test.ts`, `config-writers.test.ts`, `runtime.test.ts`, and
`runtime-install.test.ts`, #1544/#1569):

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
  Unrelated MCP servers and configuration are preserved. Without `--name`, one
  runtime is therefore wired to one Haven agent — the newest one. With
  `--name`, each agent owns its own suffixed pair and they coexist; see
  [Running several agents in one runtime](#running-several-agents-in-one-runtime).
- **The previous agent is not revoked by a re-run.** Its credentials remain on
  disk and its authority remains whatever its on-chain rules say. Revoke
  agents you no longer use from the Haven dashboard, then delete their
  credential directories.
- **A re-run never overwrites an existing credential file.** A write that would
  collide with an existing `identity.json`/`signer.json`/`agent.json` is
  refused outright (and a partially failed write rolls itself back), so a
  re-run cannot corrupt stored key material. **`--rekey` is the one exception,
  and it is a different operation** — it deliberately replaces a credential set
  in place, at an unchanged path, and is the supported way to replace a key
  rather than accumulate agents. See
  [Replacing an agent's signing key](#replacing-an-agents-signing-key-rekey).

## Running several agents in one runtime

`--name <slug>` gives an agent its own MCP server pair and its own credential
directory, so several agents coexist in one runtime instead of replacing each
other:

```sh
npx -y @haven_ai/connect@alpha --setup hv_setup_... --api https://api.haven.example \
  --name research --runtime claude-code
```

| | Without `--name` | With `--name research` |
|---|---|---|
| MCP entries | `haven`, `haven-signer` | `haven-research`, `haven-signer-research` |
| Credentials | `~/.haven/agents/<agent-id>/` | `~/.haven/agents/research/` |

A writer only ever touches the pair it owns, so adding a named agent cannot
disturb the bare pair or another named one. Omitting `--name` is byte-identical
to how the connector behaved before named pairs existed, so nothing already
wired needs changing.

The slug is **1–32 lowercase letters, digits and single hyphens**, validated
before anything is written, and **immutable once wired** — it is the server name
and tool prefix every host depends on. `haven`, `signer` and `signer-*` are
refused, because their derived names would collide with another pair's.

> The slug is local. Haven does not receive it, so the dashboard cannot yet tell
> you which agent corresponds to which entry
> ([#1878](https://github.com/d-hinders/Haven-AI/issues/1878)). Until it can,
> `--doctor` on this machine is what maps the two.

## Replacing an agent's signing key (`--rekey`)

If an agent's signing key is lost or exposed, replace it: same agent, same name,
same history, new key. This does **not** create a new agent, and it is not the
same as running setup again.

Re-key is authorised by the **account owner in the dashboard** — the connector
never calls Haven's re-key endpoints, which refuse an agent credential by
design. So it runs in two phases with the dashboard between them:

```sh
# 1. On this machine: generate the new key, print its public address.
npx -y @haven_ai/connect@alpha --rekey [--name research]

# 2. In the dashboard: agent → Replace signing key → paste that address.
#    Sign the steps. It shows a new API key ONCE.

# 3. Back here: write the new credentials and rewire this agent's MCP pair.
npx -y @haven_ai/connect@alpha --rekey-finish --api-key sk_agent_... \
  --runtime claude-code [--name research]
```

Between the two phases nothing has changed: the agent keeps working on its old
key until you finish. Phase one refuses up front what the backend would refuse
anyway — a legacy-rail account, a revoked agent — so you find out before signing
anything. Phase two refuses to write unless the pasted key authenticates,
belongs to **this** agent, and Haven's recorded signing address matches the one
this machine generated.

**Pass `--runtime` on the finish step.** Your API key lives inside the MCP config
as well as in the credential files, so without it the credentials are correct and
every wired host still presents the retired key and fails with 401.

**Then restart every long-lived host** — not just the one in front of you. Each
long-running process loaded its wiring at startup and is still holding the old
key. The connector prints the exact restart command for your runtime; the sweep
across the rest is yours.

> **If the key is lost, check for a balance on it first.** An agent's delegate
> address can hold a small amount from x402 settlement, and sweeping it needs a
> signature from that key. After a re-key it is unrecoverable — by you and by
> Haven. Haven's preflight reads the balance and refuses until you say what
> happened to it. Full detail:
> [Replacing an agent's signing key](../../docs/product/agent-key-rotation.md).

## Diagnosing a stuck setup: `--doctor` / `--repair` (#1589)

```bash
npx @haven_ai/connect@alpha --doctor --runtime codex-desktop
npx @haven_ai/connect@alpha --doctor --repair --runtime codex-desktop
```

`--doctor` is read-only and needs NO setup token: it checks the runtime config,
the agent credential files, the pinned signer runtime install, the hosted MCP
(authorized `tools/list`), and starts the local signer for a real stdio
handshake — reporting its advertised compat versions. Every failing check
prints one concrete repair action; the exit code is non-zero on any failure.
Add `--json` for a machine-readable report. No secret material is ever
printed.

`--doctor` also probes every OTHER agent credential directory it did not
select (#1688). A re-run of setup mints a NEW agent and retires nothing, so
a directory from a previous setup can hold an API key that still
authenticates — meaning any host that started before the re-run keeps
spending as the agent you believe you replaced. A superseded directory
whose key is still live is a FAILING check naming the agent id, with the
repair spelled out: revoke it on the Haven agent page, then remove the
directory. An already-revoked one reports as informational; an unreachable
probe is a note, never a verdict. Connect never revokes or deletes
credentials itself — it reports, you decide. The setup completion output
names superseded agents the moment they are created, for the same reason.
One honest limit: "newest" is decided by file mtime, so a restored backup or
a sync tool that rewrites timestamps can make doctor examine the wrong
directory as current — before revoking anything, confirm the agent id
against the Haven agent page, which is the authority on which agent is
which.

`--repair` re-runs what setup already owns — reinstall the pinned signer
runtime, rewrite the wrapper + sidecar, and re-write the runtime config from
the STORED credentials. It never touches keys and never needs a new token.
