# @haven_ai/cli

The terminal surface for setting up and running a Haven agent — **an agent can
drive it end to end**, up to the steps that need a human signature. It is also a
scriptable companion for a human power user; both readers are served below, agent
first, because the agent is the one that cannot fall back to the dashboard.

What it never does is sign. On-chain, owner-signed actions — approving a budget,
rotating a key, moving funds — happen in the dashboard with the owner's passkey.
This CLI reads, arranges and hands off.

## Are you an AI agent whose user has no Haven account yet?

Read **`/for-agents.md`** on the Haven host your user gave you — or
[the copy in this repository](https://github.com/d-hinders/Haven-AI/blob/dev/packages/frontend/public/for-agents.md)
if you do not have that host yet.

Your user creates the account and the passkey: those are theirs, they need a
human, and you should never ask for their password. You can do everything else
— including running the connector command from the setup prompt they paste you,
and managing the account from the shell with `@haven_ai/cli`.

## Install

```bash
npm i -g @haven_ai/cli@alpha   # or run ad hoc: npx @haven_ai/cli@alpha <command>
haven --help
```

A bare `npx @haven_ai/cli` resolves to the `latest` dist-tag, which may be an
**older build** than the one your deployment's docs describe — `latest` tracks
the newest *published* release and nothing guarantees it matches the channel a
given deployment serves (owner decision 2026-09-04 put the mechanism behind a
release; issue [#2617](https://github.com/d-hinders/Haven-AI/issues/2617) is
the reason the runbook and the manifest now name the channel explicitly). The
runbook (`/for-agents.md`, printed by `haven guide`) and the manifest
(`/.well-known/haven.json`, field `packages.cli.channel`) name the channel the
deployment serves as `@<channel>`: read the tag from there, never pick one.
`<channel>` below is that tag; `@alpha` is only a concrete example.

The CLI talks to the hosted Haven backend by default. Point it elsewhere with
`--api <url>` or `HAVEN_API_URL` (e.g. a local backend at
`http://localhost:3001`).

> **This version: login, read, backend-only management, and budget
> construct-and-hand-off.** On-chain, owner-signed actions (budget signature,
> send) are signed in the dashboard — this CLI never holds your keys. See
> [`docs/research/haven-cli.md`](../../docs/research/haven-cli.md) for the full
> design and roadmap.

## Setting Haven up as an agent

The path an agent walks, and where it stops. Four of the six steps in
[`/for-agents.md`](https://github.com/d-hinders/Haven-AI/blob/dev/packages/frontend/public/for-agents.md)
are your user's; these are the two that are yours.

```bash
# 1. Get a scoped session. Prints a code and a link for your user to approve in
#    a browser — you never see or ask for their password. @alpha is an example:
#    run the tag your deployment names (see "Install" above).
npx -y @haven_ai/cli@alpha login --api <api-url>

# 2. Create the agent and its budget. Prints the connector command the backend
#    built, and the approval link to hand your user.
haven agents connect --name <name> --budget 25 --token USDC --period 1440

#    --run executes that command here instead of printing it for a human.
haven agents connect --name <name> --budget 25 --token USDC --period 1440 --run
```

`haven guide` prints the whole runbook — the same text served at
`/for-agents.md`, so you can read it without a network round trip.

**What the session can and cannot do.** It is an allow-list, not your user's
authority: it creates and manages agents and reads the account, and it **cannot**
approve a budget, rotate a key, change a signer or move money. Those need your
user, every time.

**Funding is theirs too, and has a command anyway.** `haven wallets funding`
prints the address, the amount **and which chain** — read the chain from there
rather than assuming one. You can compose the message; you cannot send the money.

**Every command takes `--json`**, and every refusal is a JSON object with a
machine-readable `code`. The contract and the six exit codes are in
[*For agents and scripts*](#for-agents-and-scripts) below — read that before
branching on anything.

**Pass `--api <url>` or set `HAVEN_API_URL` on the first command.** The session
remembers the backend afterwards. There is a default and it is Haven's hosted
**production** backend, so on any other deployment an omitted flag does not fail
— it connects somewhere real and wrong.

## Usage — the full command surface

Everything the CLI does, for a human power user and as the reference an agent
checks a command against. `haven --help` prints the same list.

```bash
# auth
haven login                              # browser device-code approval (the default)
haven login --email you@example.com      # password path instead (prompt or HAVEN_PASSWORD)
haven whoami                             # user, session expiry, API URL
haven guide                              # the agent onboarding runbook
haven logout

# read
haven wallets list
haven wallets balances --safe <id|address>
haven wallets funding [--safe <id|address>] [--wait]   # the paste-ready funding instruction (#2534)
haven agents list
haven agents show <id>
haven budget show <agentId>
haven budget show <agentId> --hashes
haven activity list [--safe <id|address>] [--agent <id>] [--direction in|out] [--limit <n>] [--offset <n>]
haven activity export [same filters] > activity.csv
haven activity export --format sie [--from <ISO>] [--to <ISO>] [--company <name>] > books.si
haven catalog list
haven contacts list

# manage (backend-only — no on-chain signing)
haven agents pause <id> | resume <id>
haven agents revoke <id> --yes           # terminal; needs explicit --yes
haven agents rotate-key <id>             # new API key, shown once
haven agents rename <id> <name>
haven wallets rename <id> <name>
haven contacts add <name> <address> | contacts remove <id>

# set an agent up without the dashboard modal (#2527)
haven agents connect --name <name> --budget <amount> --token USDC --period <minutes>
haven agents connect --name <name> --budget 25 --token USDC --period 1440 --run
haven agents connect --status <setupId> [--wait]

# budgets: construct-and-hand-off (#2539) — the CLI never signs
haven budget grant <agentId> --amount 25 --token USDC --period 1440
haven budget grant <agentId> --amount 25 --token USDC --period 1440 --recipient <address> --wait
haven budget revoke <agentId> <delegationHash> [--wait]
```

### `haven budget grant` / `haven budget revoke` (#2539)

Later budget changes — a second token, a raise, a recipient pin, a stop — no
longer require describing where to click. Both commands CONSTRUCT the
signature request and print a dashboard link; **the human signs in the
browser**, with their passkey or wallet, every time. The CLI never signs and
never calls `activate` — that is the whole design.

- `budget grant <agentId> --amount <n> --token USDC --period <minutes>`
  builds the pending delegation (period is whole **minutes**, at least `1` —
  this rail has no one-time budget, and the CLI refuses `--period 0` rather
  than letting `/delegations/build` answer it with a 400. `agents connect`
  does take `--period 0`, but that sets `reset_period_min` on a different
  route). `--amount` is in
  whole tokens, read from your wallet's balances exactly like
  `agents connect`; `--recipient` pins the budget to one address (omit for an
  open budget); `--expires` takes unix seconds (default: 90 days).
- `budget revoke <agentId> <delegationHash>` prepares the sponsored
  revocation (no gas, one signature). The hash comes from
  `haven budget show <agentId> --hashes` or the dashboard. (`agents show` does
  NOT print hashes — it renders the allowances projection, which has no hash
  field. #2612.)
- `--wait` on either command polls until the human's signature lands (grant:
  the hash turns `active`; revoke: the row turns `revoked`), 5 s interval, 15
  minute ceiling. The build is idempotent for the same parameters while it is
  still pending and unexpired — the dashboard form re-running the same grant
  returns the same hash, so `--wait` converges instead of chasing a version
  that never activates.
- Under `--json`, grant returns the backend's build object —
  `{ build_id, typed_data_hash, signing_url, delegation_hash, version }`
  (`build_id` and `typed_data_hash` are the delegation hash, named for API
  clarity) — plus `agent_id` and `status`. The link first, the settled status
  after: the same two-emission shape as device login.

### `haven agents connect`

Does what the dashboard's connect modal does, from a terminal: creates the
setup and prints the connector command, the approval link, and when the setup
expires. `--budget` is in **whole tokens** as you would say it (`25` is 25
USDC); the CLI reads the token's decimals from your wallet's own balances and
converts, and it **refuses** an amount with more precision than the token has
rather than rounding it away.

The connector command is **printed, never composed** — it is the same string
the dashboard shows for the same setup, because both render what the backend
built. `--run` executes it for you as a child process with exactly `--json`
appended and nothing else changed, streams the connector's output, and puts the
thing you have to act on first.

If the connector refuses — it cannot tell which runtime to wire, or the machine
is already wired to a different agent — you get **exit 4** with the refusal
object intact, including any ids or suggested name it carried. That is a
message to relay to your user, not a problem to solve: `haven agents connect`
deliberately has no `--replace` and no `--name` for the connector, because
choosing between replacing an existing wiring and installing alongside it is
the human's decision.

Two flags the issue sketched and this does not have, so you are not left
looking for them: **`--recipient`** (a recipient pin lives in the delegation's
caveat enforcers; `budget grant` above can set one, but a connect setup has no
API field to carry it — the human adds it when approving) and
**`haven agents create`** (`POST /agents` requires a
delegate address, and a CLI an agent drives must never hold a signing key —
`connect` is the path that generates one locally, on your machine).

Approving the budget stays with the human, in the browser, every time.

### `haven wallets funding`

Prints the funding instruction a human acts on: what to send (each token's
documented minimum-useful amount), to which address, on which chain, plus the
explorer link and a faucet link on testnets. It reads
`GET /user/safes/:safeId/funding` — the same facts the dashboard's funding
card shows — and composes nothing locally, so the printed sentence and the
dashboard can never disagree about the amount.

`--wait` polls the same read until the account counts as funded, printing the
elapsed time on stderr while it waits, and exits 0 the moment `funded` flips.
On timeout it exits 1 with the elapsed time in the message. It is read-only in
every mode: it never sends anything and never touches a faucet — the transfer
itself stays with the human.

Add `--json` to any read command for machine-readable output:

```bash
haven agents list --json | jq '.[] | select(.status == "active") | .name'
```

## For agents and scripts

`--json` is a contract, not a formatting flag (#2525). Under it, **stdout
carries exactly one JSON value and nothing else** — every sentence meant for a
human goes to stderr. That holds for refusals too, which is the half a caller
cannot work around: parse stdout, branch on the exit code, and read stderr only
when a person is watching.

### Signing in without a password (#2526)

`haven login` starts a **browser-approved** flow by default. It prints a link
and a code; a human opens the link, sees who is asking — the `client_label` the
CLI sent — and what the session may do, then approves.
There is no password anywhere in that path, which is the point: an agent
driving this CLI must never hold its user's password.

```bash
haven login --json
# {"ok":true,"verification_url":"https://app.haven…/device?code=ABCD-2345",
#  "user_code":"ABCD-2345","expires_at":"…"}
```

Under `--json` that object is printed **before** polling begins, so an agent
can hand its user the link immediately rather than after the flow completes.
Add `--no-wait` to stop there and poll later; without it the CLI waits at the
interval the server names, widening it when the server says `slow_down`.

Exit codes carry the outcome an agent acts on: **3** when the code expired
(ask for a new one), **4** when the human denied it (stop asking).

`haven login --email <address>` keeps the password path for a human who wants
it. It is not removed — it is simply no longer what an agent gets by asking to
log in.

**What the approved session can do.** Create and manage agents, set up a
connection, and read your account. **What it cannot:** sign anything, approve a
budget, change signers, move funds, change your credentials, or rotate an
agent's keys — neither the delegate key (`/agents/:id/rekey/*`) nor the API key
(`/agents/:id/rotate-key`). `haven agents rotate-key` therefore needs an
ordinary session (`haven login --email`), not a device-code one: issuing a
fresh credential is a change of authority, and the human keeps those. The allow-list lives in
`packages/backend/src/middleware/owner-cli.ts`; a route that is not on it
refuses, because #1640 already refuses every purpose-carrying token everywhere
and this is a single opt-in exception. A census test measures what the
enforcement actually answers for every registered route, refuses an entry whose
route does not exist or is not behind `authMiddleware`, and holds the list
against an independent opinion about which path shapes are authority.

```bash
haven agents list --json                 # success: the payload, unchanged
haven agents show missing --json         # failure: one object, still parseable
```

A failure is always:

```json
{ "ok": false, "error": { "code": "not_authenticated", "message": "Not authenticated.", "hint": "Run `haven login` ..." } }
```

Success keeps whatever shape the command already returned — including the bare
arrays the list commands emit — so a script that parses a success today keeps
working. `login`, `logout` and the manage commands, which used to print only a
sentence, now emit an object as well.

### Exit codes

| Code | Meaning | What a caller should do |
|---|---|---|
| `0` | Success | Continue. |
| `1` | Failed | Something broke that none of the below describes (a 5xx, an unexpected error). Retrying may help. |
| `2` | Usage | The command line was wrong — unknown command, missing argument, bad flag, or a `--safe` that matches nothing. Fix the argv; retrying it unchanged will not help. |
| `3` | Not authenticated | No stored session, or the backend rejected the one we have. Run `haven login`. |
| `4` | Refused | The session is fine and the backend said no anyway (403, 410, other 4xx). The message is the backend's, echoed verbatim. |
| `5` | Network | The backend could not be reached at all. Check connectivity and `--api`. |

**Why a 401 is `3` and not `4`.** The two overlap by definition — a 401 *is* the
backend refusing — and the split is made on what the caller does next: `3` means
re-authenticate, `4` means do not bother, the session was never the problem.
Collapsing them would leave an agent guessing which one it had.

### `haven guide`

```bash
haven guide            # the agent onboarding runbook, as Markdown
haven guide --json     # { ok, format, content }
```

Prints the same text served at `/for-agents.md` — what Haven is, which steps
need a human, and what to say at each hand-off. It is compiled into the CLI, so
it works with no session and no network, which is exactly the situation it
describes how to get out of. The string is generated from
`packages/sdk/src/agent-guidance.ts` by
`node packages/cli/scripts/sync-agent-guidance.mjs` and byte-pinned to it by a
test; the copy exists so this package keeps **zero runtime dependencies** and
`npx @haven_ai/cli@<channel>` stays a small install for an agent.

## Config

- `--api <url>` or `HAVEN_API_URL` — backend URL (defaults to the hosted Haven
  backend). The backend is pinned into the saved session at login.
- `HAVEN_EMAIL` / `HAVEN_PASSWORD` — non-interactive login (CI/scripts).
- Session is stored owner-only at `~/.haven/session.json`. Treat it like a
  secret; `haven logout` removes it.

## Custody

The CLI authenticates as the user and talks to the same JWT API as the
dashboard. It can read everything and perform backend-only management; anything
that moves funds or changes on-chain authority is signed by your wallet/passkey
in the dashboard. Haven never holds your Safe owner key or any delegate key
through this tool.
