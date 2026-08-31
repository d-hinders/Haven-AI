---
owner: "@d-hinders"
status: research
covers:
  - packages/cli/**
last-verified: "2026-08-31" # #2313: the tier table — which sits BELOW this doc's "read the sections below as proposed" banner but states live-facing FACTS, and which this doc's own #1988 entry set the precedent of correcting — carried three retired items: Tier A `approvals` (route deregistered, `approval_requests` dropped, #2055), Tier B approver *metadata* (five routes deleted by #1988, `safe_approver_metadata` dropped by migration 069/#1990), and Tier C `deploy Safe, create/modify agent allowance, approve over-budget payment, add/remove approver` (closed by #1984 or deleted by #1988/#2055). Rows re-based on the live owner-signed actions and the removals recorded in a note below the table, following #1988's keep-the-record style rather than deleting silently. The tiering ARGUMENT is untouched. Scope: the tier table and its new note. NOT re-verified and deliberately LEFT: the command sketch, the signing-handoff options and the P0-P3 roadmap, which are inside the banner's design-record scope and read as proposed. Prior: #1988: the Tier-C deep-link sketch cited `/user/safes/:id/approvers/tx` as a live example of a backend that already returns unsigned tx data. #1988 deleted it, so the example is marked historical and the agent-connection-setup flow carries the point. Tier C is still NOT built and nothing else here was re-verified. Prior: weekly #1248 audit: package SHIPPED — status header rewritten to record what was built vs the sketch (Tier A/B live as @haven_ai/cli; Tier C/D unbuilt; no connect code reuse; unplanned SIE export shipped); covers: corrected to the package this doc is actually about
---

# Sketch — `haven` CLI (terminal-native parallel to the dashboard)

> Status: **partially SHIPPED.** `packages/cli` exists and publishes as
> `@haven_ai/cli` (bin `haven`, same release train as sdk/signer/mcp/connect).
> What shipped matches the sketch's Tier A/B: `login/logout/whoami`, wallets,
> agents (list/show/pause/resume/revoke/rotate-key/rename), `budget show`,
> `activity list/export`, catalog, contacts — session at `~/.haven/session.json`
> (0600), `--json` on reads. **Deviations from this sketch, recorded:**
> the CLI reuses NOTHING from `packages/connect` (own `args.ts`/`session.ts`,
> parallel construction rather than the proposed code reuse); **Tier D
> (SDK-backed `haven pay`/`haven x402`) and Tier C (deep-link owner actions,
> `haven connect`, `approvers`) are NOT built** — #460 tracks Tier C; and one
> unplanned feature shipped: `haven activity export --format sie` (Fortnox/
> Visma/Bokio-compatible SIE 4I, part of the bookkeeping-export arc). The
> sections below are kept as the original design record; read them as
> "proposed", with the above as what reality did.

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
| **A. Read** | wallets, balances, agents, allowances (live remaining), transactions, catalog, analytics | user JWT | ✅ fully |
| **B. Backend-only management** | pause/resume/revoke agent, rotate agent key, rename wallet/agent, contacts, create connect-setup tokens, CSV export | user JWT | ✅ fully |
| **C. On-chain, owner-signed** | grant/revoke an agent budget delegation, re-key an agent, manual send | owner key (wallet/passkey) | ⛔ not directly — **hand off** |
| **D. Agent payments** | direct pay / x402 / MPP within budget | agent API key + delegate key (already local) | ✅ via `@haven_ai/sdk` |

> **Three of these rows were re-based by #2313 (epic #1440); the tiering ARGUMENT is
> unchanged.** Tier A listed `approvals` — `/approvals` was deregistered and
> `approval_requests` dropped by #2055, so there is nothing to read. Tier B listed
> approver *metadata* — #1988 deleted the five approver routes and migration 069
> (#1990) dropped `safe_approver_metadata`. Tier C read "deploy Safe, create/modify
> agent allowance, approve over-budget payment, add/remove approver, manual send";
> every one of those but `manual send` is a Safe-rail action closed by #1984 or
> deleted by #1988/#2055, and the live owner-signed actions are the delegation
> rail's budget grant/revoke and re-key. What the tier says about *custody* — an
> owner-signed on-chain action cannot happen in a terminal — is why the row exists
> and did not change.

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
   (it already returns unsigned tx data — e.g. the agent-connection-setup flow;
   `/user/safes/:id/approvers/tx` was the other example until #1988 deleted it
   with the Safe rail) and prints a dashboard URL to finish signing
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
