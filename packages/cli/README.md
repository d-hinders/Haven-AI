# @haven_ai/cli

A terminal-native, scriptable companion to the Haven dashboard. Sign in as
yourself and read or manage your account from the shell — used **alongside** the
web app, not instead of it.

## Install

```bash
npm i -g @haven_ai/cli@alpha   # or run ad hoc: npx @haven_ai/cli@alpha <command>
haven --help
```

The CLI talks to the hosted Haven backend by default. Point it elsewhere with
`--api <url>` or `HAVEN_API_URL` (e.g. a local backend at
`http://localhost:3001`).

> **This version: login, read, and backend-only management.** On-chain,
> owner-signed actions (budgets, send) are signed in the
> dashboard — this CLI never holds your keys. See
> [`docs/research/haven-cli.md`](../../docs/research/haven-cli.md) for the full
> design and roadmap.

## Usage

```bash
# auth
haven login --email you@example.com      # password via prompt or HAVEN_PASSWORD
haven whoami                             # user, session expiry, API URL
haven guide                              # the agent onboarding runbook
haven logout

# read
haven wallets list
haven wallets balances --safe <id|address>
haven agents list
haven agents show <id>
haven budget show <agentId>
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
```

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

**What the approved session can do.** Create and manage agents — including
issuing an agent a new API key, which stops the old one working — set up a
connection, and read your account. **What it cannot:** sign anything, approve a
budget, change signers, move funds, change your credentials, or re-key an
agent's delegate key (`/agents/:id/rekey/*`, which is a different thing from
rotating its API key and is not on the list). The allow-list lives in
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
`npx @haven_ai/cli` stays a small install for an agent.

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
