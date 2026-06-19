# @haven_ai/cli

A terminal-native, scriptable companion to the Haven dashboard. Sign in as
yourself and read or manage your account from the shell — used **alongside** the
web app, not instead of it.

> **This version: login, read, and backend-only management.** On-chain,
> owner-signed actions (deploy, budgets, approvers, send) are signed in the
> dashboard — this CLI never holds your keys. See
> [`docs/research/haven-cli.md`](../../docs/research/haven-cli.md) for the full
> design and roadmap.

## Usage

```bash
# auth
haven login --email you@example.com      # password via prompt or HAVEN_PASSWORD
haven whoami
haven logout

# read
haven wallets list
haven wallets balances --safe <id|address>
haven agents list
haven agents show <id>
haven budget show <agentId>
haven activity list [--safe <id>] [--agent <id>] [--direction in|out] [--limit <n>]
haven activity export [same filters] > activity.csv
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

## Config

- `--api <url>` or `HAVEN_API_URL` — backend URL (default `http://localhost:3001`).
  The backend is pinned into the saved session at login.
- `HAVEN_EMAIL` / `HAVEN_PASSWORD` — non-interactive login (CI/scripts).
- Session is stored owner-only at `~/.haven/session.json`. Treat it like a
  secret; `haven logout` removes it.

## Custody

The CLI authenticates as the user and talks to the same JWT API as the
dashboard. It can read everything and perform backend-only management; anything
that moves funds or changes on-chain authority is signed by your wallet/passkey
in the dashboard. Haven never holds your Safe owner key or any delegate key
through this tool.
