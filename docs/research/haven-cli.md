---
owner: "@d-hinders"
status: research
covers:
  - packages/cli/**
last-verified: "2026-09-06"
---

# Sketch — `haven` CLI (terminal-native parallel to the dashboard)

> Status: **partially SHIPPED.** `packages/cli` exists and publishes as
> `@haven_ai/cli` (bin `haven`, same release train as sdk/signer/mcp/connect).
> What shipped matches the sketch's Tier A/B: `login/logout/whoami`, wallets,
> agents (list/show/pause/resume/revoke/rotate-key/rename), `budget show`,
> `activity list/export`, catalog, contacts — session at `~/.haven/session.json`
> (0600), `--json` on reads. **Deviations from this sketch, recorded:**
> the CLI reuses NOTHING from `packages/connect` (own `args.ts`/`session.ts`,
> parallel construction rather than the proposed code reuse) — and **#2540
> measured whether that should change, then decided it should not**. Of the
> four pieces that issue proposed extracting: the two argument parsers are
> structurally different (command/sub with a value-flag set, against mode
> flags plus `env`) and five long-form flag NAMES coincide — `--api`,
> `--help`, `--json`, `--name`, `--version` (`comm -12` over the literal flag
> strings of the two files; `-h` is a short alias of one already counted).
> Only `--name` means a different thing on the two sides: an arbitrary display
> name for the backend in the CLI, an `assertValidServerSlug`-validated,
> machine-local wiring slug in connect. So sharing one parser would still be a
> rewrite rather than an extraction, on the parsers' structure rather than on
> the names. `redact.ts` exists only in connect and the CLI redacts nothing;
> the six-code exit table exists only in the CLI and connect returns a bare
> 0/1. Exactly one had real overlap, and it is **three lines** — the CLI's
> whole `save()` is `mkdir` 0700, `writeFile` 0600 and a redundant `chmod`
> (`packages/cli/src/session.ts:48-50`). Connect never writes that shape
> plainly: the 0700 `mkdir` appears twice (`storage.ts:49`, `:64`), each time
> followed by a `restrictPermissions` call that re-applies the mode and warns
> once on failure without retrying; the 0600 write is reached through
> `writeOwnerOnlyJson` (atomic `wx`, `dropUndefined`, refuses to overwrite) at
> six call sites plus one that bypasses it. None of that machinery exists in
> the CLI, so what is genuinely common is two syscalls with two modes. That
> does not pay for a package of its own, since `@haven_ai/cli` is published with ZERO runtime
> dependencies and a private workspace package could only reach it by being
> bundled in at build time. The duplication is smaller than the machinery to
> remove it; **Tier D
> (SDK-backed `haven pay`/`haven x402`) and Tier C (deep-link owner actions,
> `approvers`) are NOT built** — #460 tracks Tier C. **`haven agents connect`
> IS built (#2527)**, and it is not the Tier-C shape this sketch imagined: it
> creates a connect setup and prints the connector command the backend built,
> and with `--run` executes that command as a child process. It constructs no
> transaction and signs nothing — budget approval stays human plus WebAuthn in
> the browser, which is the custody constraint below, not an exception to it.
> And one
> unplanned feature shipped: `haven activity export --format sie` (Fortnox/
> Visma/Bokio-compatible SIE 4I, part of the bookkeeping-export arc).
>
> **Since #2525 the CLI also carries a machine contract, which this sketch did
> not anticipate:** `--json` now applies to *every* command including refusals
> (one JSON value on stdout, prose on stderr), exit codes are documented and
> asserted (`0` ok, `1` failed, `2` usage, `3` not authenticated, `4` refused,
> `5` network), `whoami` reports session expiry and the API URL, and `haven
> guide` prints the agent onboarding runbook (#2523) offline. The sketch's
> framing of the CLI as a companion *for a human at a terminal* is the part
> that has moved: it is now also the owner-side surface an agent drives, which
> is what epic #2519 is for. `@haven_ai/cli` keeps **zero runtime
> dependencies** — the runbook is a generated, byte-pinned copy rather than an
> `@haven_ai/sdk` import, because that import would put ethers + viem + x402
> (~94 MB) on the `npx @haven_ai/cli` path an agent uses. The
> sections below are kept as the original design record; read them as
> "proposed", with the above as what reality did.

## Goal

A `haven` command-line tool that lets a signed-in **user** do from the terminal
what they do in the dashboard — inspect wallets/agents/activity and manage what
can be managed off-chain — used **alongside** (not instead of) the web app. It
should be scriptable (`--json`) and reuse the existing SDK + backend, not fork
logic.

Audience (recommended primary): **power users / developers** who live in the
terminal and run agents there already (they ran the connector command from a
shell). The
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

- `haven login` — since #2526 this DEFAULTS to a browser-approved device-code
  flow (`/auth/device/*`), which mints a `purpose: owner_cli` token scoped to
  an allow-list rather than a full session; `--email` keeps the password path
  below. Either way, store it `chmod 600` at `~/.haven/session.json` (mirror
  connect's owner-only credential storage). `haven whoami` reads `/auth/me`;
  `haven logout` clears it.
- `haven login --email` — email/password → backend `/auth/login` returns the
  user JWT.
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
