# @haven_ai/connect

Connect Agent 2 local connector.

This command runs in the user's agent environment. It generates the agent
signing key and API key locally, stores them locally, and sends Haven only the
public signing address, proof signature, and API-key hash. Haven never receives
the private key or plaintext API key.

## You are an AI agent and your user has no Haven account yet?

Read **`/for-agents.md`** on the Haven host your user gave you — or
[the copy in this repository](https://github.com/d-hinders/Haven-AI/blob/dev/packages/frontend/public/for-agents.md)
if you do not have that host yet.

Your user creates the account and the passkey: those are theirs, they need a
human, and you should never ask for their password. You can do everything else
— including running the connector command from the setup prompt they paste you,
and managing the account from the shell with `@haven_ai/cli`.

```sh
npx -y @haven_ai/connect@<channel> --setup hv_setup_... --api https://api.haven.example --ack-local-tools --runtime claude-code
```

`<channel>` is a placeholder, like `hv_setup_...` and the API URL beside it:
**the Haven dashboard hands you the exact command to run — copy that one.** The
channel is per-deployment and has been since #2422: the backend's setup response
names the whole package in `connector_package`, production hands out
`@haven_ai/connect@alpha`, and a non-production deployment can be configured to
hand out another, such as `@haven_ai/connect@dev`. This README ships inside every
channel's tarball and is the npm landing page for all of them, so a literal here
would be wrong for every reader it did not describe (#2515).
Read `connector_package` rather than assuming any particular backend's channel. Pinning `@alpha` by hand against such a backend
installs a signer that skews against it — the signer refuses to sign an
`x402_expected_context_version` it does not know.

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

Re-running setup without `--replace` creates a NEW agent and retires nothing
(with `--replace`, see [Running setup again](#running-setup-again)). Long-lived MCP hosts
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
   npx @haven_ai/connect@<channel> --tombstone ~/.haven/agents/<directory> --reason "superseded" --json
   ```

   `<channel>` is the placeholder defined under the first example; this command
   rewrites local files only, so any published connector does the same job.

   This replaces the directory's signer wrapper with a diagnostic that logs the
   retirement (agent id, date, reason, restart guidance) to the host's MCP
   stderr log on every probe, and records it in `TOMBSTONE.json` for
   `--doctor`. It touches no key material and revokes nothing — revoke the
   agent on the Haven agent page yourself. Delete the tombstone only once every
   long-lived host has been restarted.

   **Pass a real DIRECTORY, not an agent id.** A named agent lives at its wiring
   slug, which never equals its agent id — so `~/.haven/agents/<agent-id>` does
   not exist for one, and the command refuses with
   `tombstone_directory_not_found` having retired nothing. List `~/.haven/agents`
   or read the `directory` values out of `--doctor --json`.

   Under `--json`, success is `{"tombstoned": true, …}` on stdout with exit 0,
   and a refusal is `{"tombstoned": false, "error": {"code", "next_action"}}`
   with exit 1 — so check the result rather than assuming silence means success
   (#2175). The `message` field is present only for connector-authored refusals;
   an unexpected filesystem error keeps its raw text on stderr alone.

### Unwiring an agent (`--unwire`, #2169)

Connect has always been able to *write* a pair into a runtime config and never
able to *erase* one — so a "reset" left the old `mcp_servers` pair and (on
Hermes) the `MCP_HAVEN_API_KEY` dotenv line behind, and the runtime quoted as
one agent while signing as another. `--unwire` is the erase half:

```
npx @haven_ai/connect@<channel> --unwire ~/.haven/agents/<directory> [--reason "..."]
npx @haven_ai/connect@<channel> --unwire --name research [--reason "..."]
```

`<channel>` is the placeholder defined under the first example; `--unwire`
touches local files only, so any published connector does the same job.

It tombstone-first (so a stale long-lived host still hears `HAVEN-TOMBSTONE`,
never a masked `ENOENT`), then removes THAT agent's hosted + signer pair from
every runtime config it appears in (Hermes YAML, Codex TOML, the Cursor / VS
Code / Insiders / Claude Desktop JSON configs), plus the Hermes dotenv API-key
line — bare `MCP_HAVEN_API_KEY` or named `MCP_HAVEN_<SLUG>_API_KEY`. Finally it
tears down the target directory's local key material (signer key, any abandoned
re-key, the stored API key) so `--doctor` reports `retired`, not the
still-spend-capable `superseded`; the #2155 tombstone mirror keeps the record.

An **unnamed** pair (`haven` / `haven-signer`) is shared by every unnamed agent
and is only removed when this directory's wrapper is the one the config
launches (or its key is the one the Hermes env holds) — otherwise `--unwire`
**refuses** rather than unwire a different, working agent. Nothing is ever
revoked on the backend; `connect reports, the user decides` (#1688) survives,
and revocation stays an owner action on the Haven agent page. Restart every
long-lived host afterwards, as with any retirement.

### Structured output for automation

Pass `--json` when a launcher needs a machine-readable completion record. Connect
writes progress and human recovery notes to stderr and exactly one JSON object
to stdout, with `schema_version: 1` and `outcome` set to `complete`,
`action_required`, or `failed`. Structured runs skip the interactive
budget-approval wait so the record is emitted promptly; open `approval.url`
whenever ready and verify later with the read-only `haven_get_agent`
tool. The object includes runtime/topology status,
probe result, activation and next-action guidance, approval state/expiry (null
when the backend does not provide an approval expiry) and `approval.url`, the two
read-only verification tools, `hosted_mcp_url`, `superseded_agent_ids`, and —
on a run that replaced existing wiring — `superseded_agents_retired_locally`
with `retired_agent_ids`. It
contains no API key, private key, credential
contents, full credential paths, or full delegate address. The same redacted
object is available to library callers as `runConnect(...).outcome`; the older
fields remain for additive compatibility.

`approval.url` (#2528) is the absolute link to this setup's budget approval,
returned by the backend at register. Present only when `approval.required` is
`true` **and** the backend is new enough to send one — a deployment older than
#2528 omits the key entirely, which is why a caller must test for it rather
than assume it. In prose mode the same link replaces "Return to Haven" in the
printed next steps. It carries no secret (the setup token never appears in it),
and it is the ONLY approval link a caller should use: the outcome carries no
setup id, so there is nothing to assemble one from — relay the whole link or
none. The connector also reports `run_mode` (`json` or `prose`) to the backend
at register, so Haven can tell an automated setup from a narrated one; it is
sent, not returned, and appears in no output.

`hosted_mcp_url` is the hosted MCP endpoint this run wired up — **not** the
backend URL you passed as `--api`. The hosted MCP server is a separate
deployment, so the two differing is intended topology, not an environment
mismatch. It is non-secret: the same string goes into your own MCP config file,
and the API key travels beside it in a header.

`superseded_agent_ids` lists the other agent directories on this machine. A
re-run mints a NEW agent, and without `--replace` retires nothing, so those
older agents still hold live API and signing keys — revoke them on the Haven
agent page if you meant to replace them. Empty on a clean first run; an empty
list is not a guarantee, since a scan that cannot read the credential root also
yields one rather than failing a completed setup. On a `--replace` run, `retired_agent_ids` names the
directories that were actually tombstoned and had their local key files removed
— **the collision set only**, never the whole `superseded_agent_ids` list, which
also names named agents that coexist with the replaced bare pair and are
untouched — and `superseded_agents_retired_locally` is `true` when that
retirement covered every collision entry (`false`: the install ended with an
error code and the retirement was skipped, or one entry failed). Both fields
are absent on any other run and say nothing about the backend, where nothing is
revoked.

A `wiring_collision` refusal (a non-interactive bare setup over a live
previous agent, #2551) carries `error.superseded_agent_ids` and
`error.suggested_name` — the ids the human needs in order to decide, and a
valid `--name` the run can be re-issued with — with `next_action:
relay_wiring_collision_to_user`. It is a relay, not a retry hint: do not append
`--replace` or `--name` on the agent's own initiative.

For a recoverable install, configuration, probe, consent, or manual-runtime
condition, inspect `error.code` and `error.next_action`, then follow the safe
next action. A failed setup emits `outcome: "failed"` with a stable error code;
it never presents credential material as a recovery diagnostic.

### Recovering the record after a lost stream

Connect also writes its terminal outcome to `last-connect-outcome.json` in the
agent's credential directory (`~/.haven/agents/<slug-or-agent-id>/`) — the same
object, pretty-printed, for every terminal state. **If your harness stopped
watching before the connector finished, read that file rather than guessing
from your runtime's MCP listing.** A first run downloads and installs the
signer, which can take several minutes on a cold cache; a command harness that
gives up during it sees the install heartbeat as the last line and never the
verdict. The setup usually finished.

A refusal that happens before any credentials are written (an undetermined
runtime, an expired setup challenge, an unsupported Node) writes no file,
because nothing was created that could need recovering. The write is
best-effort and never changes the verdict: a setup that completed stays
completed even if the record could not be written.

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
starts `pending_approval` with zero spending authority — no budgeted spend can
move until the user approves the budget in Haven. The exact sweep-recovery
routes remain available only to recover a stranded delegate balance and do not
grant spending authority. A CLI-side confirmation would add friction without
adding a security boundary. (The local-signer tool-exposure
acknowledgement is a separate, machine-checkable consent about what the local
MCP tools expose, not a registration gate.)

The one question Connect does put before registration is not about the
agent being created but about the one already here: a **wiring collision**
([#2551](https://github.com/d-hinders/Haven-AI/issues/2551)). When the bare
`haven` / `haven-signer` pair on this machine already belongs to a different
agent whose directory still holds a live key, proceeding would silently
re-point that pair — the state `--doctor` reports as a still-spend-capable
`superseded` directory. That choice (replace it, or install alongside under a
name) belongs to the user, and it is asked *before* the key is minted or the
agent registered so that declining leaves no orphaned `pending_approval` agent
behind. See [Running setup again](#running-setup-again).

## Running setup again

Each setup prompt is one-time and each successful run creates a **new** agent
with its own freshly minted key pair. Re-running Connect on an
already-configured machine behaves as follows (characterized in
`storage.test.ts`, `config-writers.test.ts`, `runtime.test.ts`, and
`runtime-install.test.ts`, #1544/#1569):

- **Re-running an already-consumed connector command** fails cleanly before any
  credential file or runtime configuration is touched — Haven refuses the
  consumed setup when Connect resolves it (or, in a rare concurrent-run race,
  at registration). The key pair minted for the attempt exists only in memory
  and is discarded. Start a fresh connection from the Haven dashboard instead.
- **Running a fresh setup on a configured machine** writes the new agent's
  credentials into its own directory under `~/.haven/agents/<agent-id>/`,
  alongside the previous agent's directory, which stays byte-identical.
  Nothing is rotated, revoked, or deleted locally.
- **A bare re-run over a live previous agent is a decision, not a default
  ([#2551](https://github.com/d-hinders/Haven-AI/issues/2551)).** Before
  minting a key or registering, Connect scans the credential root for a
  bare-pair directory that still holds a usable key — the same reading
  `--doctor` classifies as `wired` or `superseded`; `retired`, `orphaned`,
  `parked` and **named** directories never count. If it finds one:
  - an **interactive terminal** is asked to choose — **replace** (below) or
    **install alongside** under a name Connect proposes from the agent's
    display name (e.g. `payment-agent`), collision-checked against the
    directories already there;
  - a **non-interactive run** (`--json`, CI, an agent tool call, a pipe)
    refuses with `wiring_collision` — nothing written, token still unused —
    naming the superseded agent ids and the two flags that resolve it. The
    refusal is written as a **relay instruction**: an agent running the
    dashboard's command may append only `--json` (and `--runtime` after a
    runtime refusal), so it must hand the choice to its user rather than add
    a flag itself, and re-run only with the flag the user picks.
  - **`--replace`** is the unattended answer "yes, replace". `--name <slug>`
    installs alongside. Passing both is a usage error — they contradict.
- **Replacing re-points the bare pair, then retires the previous directory
  locally.** Connect owns the `haven` and `haven-signer` entries (and the
  managed Codex/Hermes equivalents) and re-points them at the new agent's
  credentials; unrelated MCP servers and configuration are preserved. Once
  the runtime install has actually completed, each superseded directory is
  tombstoned and its local key files removed — the same teardown `--unwire`
  performs — so `--doctor` reads it as `retired` rather than still
  spend-capable. If the install ends with an error code the retirement is
  **skipped**, because the old wiring may still be the only working one; the
  outcome's `superseded_agents_retired_locally` says which happened and
  `retired_agent_ids` names exactly the directories it reached. With
  `--name`, each agent owns its own suffixed pair and they coexist; see
  [Running several agents in one runtime](#running-several-agents-in-one-runtime).
- **The previous agent is not revoked by a re-run — with or without
  `--replace`.** Local retirement is local: its authority remains whatever
  its on-chain rules and the Haven agent page say. Revoke agents you no
  longer use from the Haven dashboard. Connect never calls revoke — that
  route is owner-authenticated, and an agent credential revoking a sibling
  agent would be an agent editing its own authority.
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
npx -y @haven_ai/connect@<channel> --setup hv_setup_... --api https://api.haven.example \
  --name research --runtime claude-code
```

As above, `<channel>` is a placeholder like the rest of this line: take the
package from the setup response's `connector_package`
and add `--name` to the command the dashboard gave you.

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

> A current connector reports the resolved server name (`haven`, or
> `haven-<slug>`) to Haven at registration, and the dashboard shows it on each
> agent, so you can match an agent to its config entry without leaving the
> browser ([#1878](https://github.com/d-hinders/Haven-AI/issues/1878)). It is a
> label, not authority — nothing keys off it.
>
> Agents connected before that shipped read **"MCP name not recorded"**: Haven
> genuinely does not know, and guessing would name the wrong pair for anyone who
> used `--name`. They keep working exactly as they are; `--doctor` on the machine
> still maps them, and reconnecting records the name.

## Replacing an agent's signing key (`--rekey`)

If an agent's signing key is lost or exposed, replace it: same agent, same name,
same history, new key. This does **not** create a new agent, and it is not the
same as running setup again.

Re-key is authorised by the **account owner in the dashboard** — the connector
never calls Haven's re-key endpoints, which refuse an agent credential by
design. So it runs in two phases with the dashboard between them:

```sh
# 1. On this machine: generate the new key, print its public address.
npx -y @haven_ai/connect@<channel> --rekey [--name research]

# 2. In the dashboard: agent → Replace signing key → paste that address.
#    Sign the steps. It shows a new API key ONCE.

# 3. Back here: write the new credentials and rewire this agent's MCP pair.
npx -y @haven_ai/connect@<channel> --rekey-finish --api-key sk_agent_... \
  --runtime claude-code [--name research]
```

**Phase one prints the exact phase-two command — prefer it over the line above.**
Since [#2423](https://github.com/d-hinders/Haven-AI/issues/2423) the connector
builds that command from the npm dist-tag **it** was published under, so a build
installed from a non-production channel tells you to finish with that same
channel rather than sending you to production mid-re-key. `@alpha` is what
production hands out and is right for a production install; it is not right for
every install, which is why the tool computes it and this page cannot.

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
npx @haven_ai/connect@<channel> --doctor --runtime codex-desktop
npx @haven_ai/connect@<channel> --doctor --repair --runtime codex-desktop
```

`<channel>` is the placeholder defined under the first example — and here it is
not indifferent: `signer_runtime` compares the sidecar against the manifest of
the connector **that runs the check**, so a doctor from another channel reports
a skew that is not there. Use the channel your dashboard hands out.

`--doctor` is read-only and needs NO setup token: it checks the runtime config,
the agent credential files, the pinned signer runtime install (and, since
#2424, whether that install was made under a local runtime-spec override —
see the last section of this file), the hosted MCP
(authorized `tools/list`), and starts the local signer for a real stdio
handshake — reporting its advertised compat versions. Every failing check
prints one concrete repair action; the exit code is non-zero on any failure.
Add `--json` for a machine-readable report. No secret material is ever
printed.

`--doctor` also probes every OTHER agent credential directory it did not
select (#1688). A re-run of setup mints a NEW agent and, unless it ran with
`--replace` (#2551), retires nothing, so a directory from a previous setup
can hold an API key that still authenticates — meaning any host that started
before the re-run keeps spending as the agent you believe you replaced. Since
#2551 a bare setup no longer reaches that state silently: it asks at a
terminal and refuses everywhere else, so a `superseded` directory now means
someone chose it — a `--replace` whose install failed, an older connector, or
a directory this scan could not classify. A superseded directory
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

## Installing an unpublished signer / SDK / MCP build (`HAVEN_SIGNER_SPEC`, #2424)

Setup installs the connector's **pinned** siblings — `@haven_ai/signer@<pin>`
and `@haven_ai/sdk@<pin>` into `~/.haven/signer-runtime/<pin>`, and for
`--local` also `@haven_ai/mcp@<pin>` into `~/.haven/mcp-runtime/<pin>`. That
is right for every user and wrong for the one developer iterating on the
signer or SDK, who otherwise has to publish to find out whether a change works
end to end. Three environment variables name a different spec:

| Variable | Replaces | Read by |
|---|---|---|
| `HAVEN_SIGNER_SPEC` | `@haven_ai/signer@<pin>` | the signer runtime (default topology) |
| `HAVEN_SDK_SPEC` | `@haven_ai/sdk@<pin>` | both runtimes — each installs the SDK |
| `HAVEN_MCP_SPEC` | `@haven_ai/mcp@<pin>` | the `--local` MCP runtime |

A value is anything `npm install` accepts for that package: a checkout
(`file:/abs/path/to/packages/signer`), a tarball from `npm pack`
(`/abs/haven_ai-signer-0.0.0.tgz`), or an explicit version
(`@haven_ai/signer@<version>`). Set it in the shell that runs the setup
command — the command itself is unchanged:

```bash
HAVEN_SIGNER_SPEC=file:$PWD/packages/signer npx @haven_ai/connect@<channel> --setup <token> --runtime claude-code
```

`<channel>` is the placeholder defined under the first example.

Environment variables rather than a flag, deliberately: the install runs from
three entry points (`--setup`, `--doctor --repair`, `--rekey-finish`) and all
three honour the same variables, so a re-key cannot silently reinstall the
registry build; and the connector command is minted by the dashboard and pasted
verbatim, often by an agent, so the override sits beside it instead of being
spliced into a line the developer did not write.

**What an active override changes:**

- The runtime directory is `~/.haven/signer-runtime/override-<hash>` (or
  `mcp-runtime/override-<hash>`), keyed by a short hash of the **resolved**
  specs — overridden and pinned alike — so it can never poison the
  version-named directory the normal path reuses, and a pinned-sibling bump
  gets a fresh one.
- The install is **never reused** from an earlier run: a rebuilt `file:`
  package must not be shadowed by a cache hit.
- Setup prints `RUNTIME SPEC OVERRIDE ACTIVE …` first, naming each variable
  and the pin it replaced; `--rekey-finish` prints the same line.
- `signer-runtime.json` / `mcp-runtime.json` record the override under
  `runtime_spec_override`, and their `*_version` fields hold what npm actually
  installed rather than the manifest pins.
- The wrapper the agent client launches carries a
  `// HAVEN RUNTIME SPEC OVERRIDE (#2424): …` comment.
- `--doctor` reports a failing `runtime_spec_override` check — "runtime spec
  overridden — not the pinned manifest" — whenever the sidecar says the
  install ran under one **or** a `HAVEN_*_SPEC` variable is set in the shell
  running the doctor (a `--repair` from that shell would install it). The
  override is legitimate; the finding is its record. Under an override the
  `signer_runtime` check compares the directory against the sidecar's own
  record, not the manifest.

**What it never changes:** the post-setup handshake probe still requires
every tool in the manifest's `requiredTools` / `requiredSignerTools`, so a
local build that dropped a tool fails setup exactly like a bad registry
version would. A set-but-malformed value — empty, containing whitespace or a
shell metacharacter — is refused **before** npm runs and before anything is
written, with a message naming the variable. With no variable set, nothing
here runs: the install arguments, directory, sidecar and wrapper are
byte-for-byte what they were before the override existed (pinned by exact
characterization tests in `signer-runtime.test.ts` and
`local-mcp-runtime.test.ts`).

To return to the pinned manifest: unset the variables and run
`--doctor --repair --runtime <runtime>` (or re-run setup). The override
directories live under `~/.haven` like every other runtime directory, so the
same reset that removes `~/.haven` removes them.

That is the loop for a build that has **not** merged. For one that has — a
`@dev` snapshot of all five packages, published from every package-touching
push to `dev` — and for the owner steps that make the dev dashboard hand out
`npx -y @haven_ai/connect@dev …` in the first place, see the repository runbook
[`docs/operations/package-dev-channel.md`](https://github.com/d-hinders/Haven-AI/blob/dev/docs/operations/package-dev-channel.md).
The two compose: `@dev` picks the connector, these variables pick what it
installs.
