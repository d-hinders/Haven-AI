---
owner: "@d-hinders"
status: research
covers:
  - packages/connect/src/args.ts
  - packages/connect/src/redact.ts
  - packages/connect/src/storage.ts
  - packages/sdk/src/client.ts
last-verified: "2026-06-28"
---

# Sketch — `haven` CLI (terminal-native parallel to the dashboard)

> Status: **design sketch / proposal.** No package built yet. Purpose: agree the
> shape, the custody boundary, and a phasing before scaffolding `packages/cli`.

## Goal

A `haven` command-line tool that lets a signed-in **user** do from the terminal
what they do in the dashboard — inspect wallets/agents/activity and manage what
can be managed off-chain — used **alongside** (not instead of) the web app. It
should be scriptable (`--json`) and reuse the existing SDK + backend, not fork
logic.

Audience (recommended primary): **power users / developers** who live in the
terminal and run agents there already (they used `npx @haven_ai/connect`). The
dashboard stays the home for first-time onboarding and anything needing a
browser wallet.

## The organizing constraint: custody

Haven is non-custodial — the CLI must never hold the **Safe owner key**. That
splits every command into three tiers, and the tiers are the design:

| Tier | What | Auth needed | CLI can do it? |
|---|---|---|---|
| **A. Read** | wallets, balances, agents, allowances (live remaining), transactions, approvals, catalog, analytics | user JWT | ✅ fully |
| **B. Backend-only management** | pause/resume/revoke agent, rotate agent key, rename wallet/agent, contacts, approver *metadata*, create connect-setup tokens, CSV export | user JWT | ✅ fully |
| **C. On-chain, owner-signed** | deploy Safe, create/modify agent allowance, approve over-budget payment, add/remove approver, manual send | owner key (wallet/passkey) | ⛔ not directly — **hand off** |
| **D. Agent payments** | direct pay / x402 / MPP within budget | agent API key + delegate key (already local) | ✅ via `@haven_ai/sdk` |

Tier C is the crux. A terminal has no browser wallet, so the CLI **constructs**
the action and hands signing off (see [Signing handoff](#signing-handoff)). Tiers
A, B, D are fully terminal-native today.

## Auth model

- `haven login` — email/password → backend `/auth/login` returns the user JWT;
  store it `chmod 600` at `~/.haven/session.json` (mirror connect's owner-only
  credential storage). `haven whoami` reads `/auth/me`; `haven logout` clears it.
- Agent-scoped commands (Tier D) reuse the **agent credential** the connector
  already writes (`~/.haven/agents/<id>/…`) — no new secret model.
- `--api <url>` / `HAVEN_API_URL` override, same as connect.

> The session token is a *user* credential. Keep the same discipline as the
> signing key: never log it, never send it anywhere but the Haven API.

## Command surface (sketch)

```
haven login | logout | whoami
haven wallets list                      # Tier A
haven wallets balances [--safe <id>]
haven agents list | show <id>
haven agents pause|resume|revoke <id>   # Tier B (backend-only)
haven agents rotate-key <id>            # Tier B — prints new key once
haven budget show <agentId>             # Tier A (live remaining)
haven approvers list <safeId>           # Tier A
haven activity list [--safe|--agent|--direction] [--json]
haven activity export [...] > out.csv   # reuse #411 CSV builder
haven catalog list [--category]
haven connect [--runtime <r>]           # wraps @haven_ai/connect (Tier B+D)
haven pay <to> <amount> <token> --agent <id>   # Tier D, signs locally via SDK
haven x402 <url> --agent <id>                  # Tier D
# Tier C → handoff:
haven agents create | budget set | approvers add|remove | send | wallets deploy
   →  prints a dashboard deep link (or a connected-wallet flow once built)
```

Every read command supports `--json` for piping; default output is human-readable.

## Signing handoff (Tier C)

Three escalating options; ship the first, design toward the third:

1. **Deep link (P-now).** The CLI calls the backend to create the pending action
   (it already returns unsigned tx data — e.g. `/user/safes/:id/approvers/tx`,
   the agent-connection-setup flow) and prints a dashboard URL to finish signing
   in the browser. Honest, zero new signing surface.
2. **WalletConnect in terminal (P-later).** `haven connect-wallet` pairs a mobile/
   desktop wallet over WalletConnect; the CLI builds the SafeTx and the wallet
   signs. Reuses the wagmi/viem SafeTx construction the frontend already has.
3. **Local EOA owner (advanced/self-host).** For users whose Safe owner is a
   plain EOA they control, an opt-in `--owner-key` path (same guardrails as the
   signer: file-only, never transmitted). Not for passkey-owned Safes.

## Architecture

- New `packages/cli` → `@haven_ai/cli`, bin **`haven`**. Thin shell:
  Tier A/B over the backend JWT API; Tier D over `@haven_ai/sdk`; `haven connect`
  delegates to the existing `@haven_ai/connect` runtime (fold its `haven-connect`
  bin in as `haven connect`).
- Reuse from `connect`: arg parsing (`args.ts`), secure logging/redaction
  (`redact.ts`), owner-only credential storage (`storage.ts`).
- No backend changes for Tiers A/B/D — the endpoints exist (auth, user/safes,
  agents, agent-activity, transactions, balances, catalog, analytics, payments).
- Output: a small `--json` flag + a human formatter; no heavy TUI in v1.

## Phasing

- **P0 — auth + read.** `login/logout/whoami`, `wallets`, `agents list/show`,
  `budget show`, `activity list`, `catalog list`, all with `--json`. Pure value,
  zero custody risk.
- **P1 — backend-only management.** agent pause/resume/revoke/rotate-key, rename,
  contacts, `activity export` (CSV), `haven connect` unification.
- **P2 — Tier C via deep links.** create agent / set budget / approvers / send /
  deploy → construct + hand off to the dashboard.
- **P3 — in-terminal signing.** WalletConnect, then optional `--owner-key` EOA.

## Open questions

1. Primary audience — power-user/dev (recommended) or also non-technical end
   users? Changes how much we invest in Tier-C ergonomics vs. deep-link handoff.
2. One umbrella `haven` bin folding in `haven-connect`, or keep them separate?
   (Recommend fold — one tool, discoverable subcommands.)
3. Publish as a 5th npm package on the existing release pipeline?
4. Is in-terminal WalletConnect signing (P3.2) worth it, or is the deep-link
   handoff sufficient long-term for owner actions?
5. Should `--owner-key` exist at all, given the non-custodial posture? (Lean: only
   for self-host/EOA-owner, loudly gated, never default.)

## Non-goals (v1)

- Holding or generating the Safe owner key by default.
- A full-screen TUI.
- Replacing the dashboard for onboarding or browser-wallet flows.
