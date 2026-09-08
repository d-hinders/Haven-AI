---
owner: "@d-hinders"
status: current
covers: []  # narrative — no direct code mirror
last-verified: "2026-09-08"
verified:
  - "#2640: the Safe-retirement CLOSURE SEQUENCE removed and replaced with a link to the canonical record (`docs/archive/decision-log.md` § *retire the Safe rail entirely (#1440)*). This file was retelling the #1984/#1986/#1987/#1988/#1989 sequence in its own words while nine `docs/**` files were deduped in the same change — caught by a doc-reviewer gravity-file check, not by any gate. The SURVIVING-facts half is deliberately kept verbatim, because it is not a retelling and it is the correction #2669 made here: rows untouched and readable to a direct query, no account/agent/dashboard surface displaying them, and the transactions picklist exception. Scope: the retired-rails paragraph only; nothing else in this file was re-verified."
  - "#2669: \"Existing Safe accounts stay fully READABLE — balances, tokens, agents and history all render\" re-read and EDITED. Every clause of it was false after #2413, which filters the six list queries to `account_type = 'delegator_hybrid'` and deletes `RetiredRailNotice`. Qualified to the database rows. Scope: that one sentence; the surrounding retirement narrative was checked for the same claim and carries none. A later round narrowed \"no Haven surface displays them\" to the six account/agent/dashboard list queries: review found the transaction aggregation (`LIST_BASIC_SAFES_FOR_USER_SQL`) carries no rail predicate, so `GET /transactions` still spans every account row. A THIRD round corrected that narrowing where it had been relocated rather than removed: the clause listing what \"no longer renders\" still named transaction history, which DOES render — `LIST_BASIC_SAFES_FOR_USER_SQL` and `LIST_AGENTS_FOR_TRANSACTION_FILTERS_SQL` have no rail predicate, so legacy account and agent names still appear in the `/transactions` picklists. The exception is now named with BOTH halves; a first statement of it gave only the account half."
  - "#2258: Re-read the legacy Safe retirement, live delegation boundary, and covered claims for this implementation."
  - "#1992: re-based on the delegation rail. This file is `covers: []` narrative, so NO gate could implicate it — it was missed by my own repo-wide sweep (its phrasing never says \"import-only\" or \"two rails\") and found by haven-doc-reviewer. It is the first-read mental-model doc per `docs/README.md`, and it still described Safe + AllowanceModule as the only model that exists, flatly contradicting CLAUDE.md and README. Corrected: Core Model (custody, budget grant, authority, and the auto-queue claim -> over-budget REVERTS), the spend-gate line, all 7 Payment Flow steps, the x402 rail branch, Guardrails, the tech summary, the Mental Model block, and the surfaces list (the approvals surface is deleted). Added a `Retired Rails` section stating the retirement AND what survives (accounts readable, `POST /safe/exec` open, sweep/monitor kept for the #946 bridge). Also corrected an internal contradiction: the body called the #946 bridge \"when it lands\" while this file's own #1459 note recorded it as built. Scope: those sections; the credential/rotation and MCP-packaging sections were re-read and unchanged."
  - "#1702: the delegate-key-loss answer here was the PRE-#1694 one — \"pause or revoke the agent and create a new key path\". Epic #1694 made a delegation-rail agent's key REPLACEABLE (re-key: same agent, new key, budget remainder and period boundary carried), so the guidance is now split by rail rather than stated as one blanket answer. Found by the cross-epic doc sweep #1702's acceptance criteria asked for, not by the coupling gate — no `covers:` glob connects this file to `routes/agent-rekey.ts`. Scope: that one sentence; no other capability claim re-tested."
  - "#1459: the #946 EIP-3009 bridge was described as \"planned\"; it has been built and live-proven since 2026-07, and #1450 made erc7710 the preferred scheme with the bridge as the merchant-reach fallback."
---

# About Haven

## Product Summary

Haven is an agentic stablecoin payment wallet. Users create or link a Haven account, add funds to a Haven wallet, and give AI agents constrained spending ability through agent rules and budgets.

Haven is non-custodial smart account software. It helps users configure, verify, relay, and understand payment activity, but it does not hold funds, hold user or agent private keys, make API credentials sufficient to spend, or make discretionary transfer decisions.

## Core Model

- User funds live in a user-controlled **MetaMask Hybrid DeleGator smart account**, shown in product copy as a Haven wallet. (Legacy **Safe** accounts still exist and still hold funds, but the Safe rail is retired — see *Retired rails* below.)
- Each agent has a Haven identity, an API credential for authentication, and a credential address / delegate address for payment authority.
- The user grants an agent a budget by **signing a delegation** to its credential address — a period budget with native refill, an optional recipient pin, and an expiry, enforced by audited caveat enforcers.
- The agent runtime holds and signs with its delegate private key. Haven's backend never holds that key.
- The API key identifies the agent. It is not spending authority.
- Spending authority comes from a valid agent/delegate signature redeeming an on-chain delegation the user signed.
- Payments within the remaining on-chain budget execute automatically.
- Payments outside the budget, recipient pin or expiry **revert on-chain during gas estimation**. They are not queued: the delegation rail has no approval queue.
- Users can pause, revoke, reject, or stop agent authority.

## What Exists Today

- Haven account and Haven wallet flows.
- Agent creation with per-token budget and reset period.
- Agent credential generation and handoff artifacts.
- Prompt-first **Connect your agent** handoff with hosted MCP snippets for common runtimes.
- Hosted/keyless MCP server and local edge signer split.
- Local MCP server for runtime-local credential-file integrations.
- Direct agent payments through the Haven SDK.
- x402 and Haven machine-payment challenge quote/pay/resume handling in the SDK and local MCP.
- `get_allowances` tooling for live "what can this agent spend?" questions.
- Dashboard, account, agent, transaction, activity, and tool-invocation surfaces.
- Agent pause, resume, revoke, and API-key rotation flows.
- Internal demo merchant MCP package for Base USDC x402 test purchases and Swedish invoice output.
- Quality, review, and agent workflow documentation for implementation work.

## Agent Credentials

The generated agent credential file is a handoff artifact for the agent runtime. It should include enough context for the agent to authenticate, identify the correct wallet, and sign payments without implying that Haven is the custodian or controller of funds.

Current credential context should include:

- Haven API URL.
- Agent ID.
- API key.
- Haven wallet / Safe address.
- Credential address / delegate address.
- Chain ID and token context when needed by the runtime.
- Current budget summary as a snapshot, not the authority source.
- Revoke URL and creation timestamp where useful.
- Delegate private key only when Haven generated it client-side for the user and shows it once.

If the user brings their own credential address, Haven must not invent, recover, or store the private key. The generated instructions should tell the user or agent runtime to provide the matching delegate key through their own secret handling.

Haven stores only API-key hashes and display prefixes. Rotating an API key creates a new one-time-visible key and invalidates the old API key immediately. API-key rotation is useful when the API key was exposed or lost; it does not rotate the delegate signing key. If the delegate private key was exposed or lost, a delegation-rail agent is **re-keyed** (epic #1694): the owner authorises a rotation that revokes the old delegation, issues a new one to a freshly generated key, and rotates the API key alongside it — the agent keeps its id, name and history, and its budget remainder and period boundary carry over. The delegate never held owner authority, which is why losing it is recoverable at all. Legacy AllowanceModule agents are historical records only in the dashboard: Haven does not offer payment credentials, pause/resume, re-key, or revoke controls for them there. Owners manage any remaining Safe permission outside Haven where they have access; replacement agents use the live delegation flow.

## Connect-Agent And MCP

The primary connect-agent flow is now hosted MCP plus local signing:

- Hosted MCP receives the agent API key as Bearer identity.
- Hosted MCP reads state, constructs unsigned payment payloads, and relays signatures.
- The local runtime or `@haven_ai/signer` holds the delegate private key and signs.
- Hosted snippets and deep links must never include the delegate private key.
- MCP tool calls are tagged and audited so users can see activity and last-seen status.

The local `@haven_ai/mcp` package remains available for stdio deployments where the MCP server runs beside the agent and reads a local credential file. It signs locally and should not be run as a hosted multi-tenant signer.

Audit logs and last-seen timestamps are informational UX and debugging surfaces. They are not the spend gate. The on-chain delegation and its caveat enforcers remain the spend gate.

## Payment Flow

1. Agent requests a payment with token, amount, recipient, and optional memo/context.
2. Haven authenticates the API key and selects the agent's budget delegation for that token and recipient.
3. The agent/delegate signature provides payment authority — signed over the account's exact EIP-712 typed data.
4. The delegation's caveat enforcers check budget, recipient and expiry **on-chain during gas estimation**.
5. If the request is inside the envelope, Haven submits the sponsored UserOperation and funds move account→recipient directly, with no funding leg.
6. If it is outside the envelope, it **reverts on-chain**. There is no approval queue on this rail.
7. Haven records status and presents the result in transaction history.

Haven can help construct and relay the transaction, but it must not alter the signed payment amount, token, recipient, route, or authority boundary.

## x402 And Machine Payments

The SDK supports `haven.fetch()`, quote-first helpers, and resume helpers for standard x402 and Haven machine-payment challenge flows.

x402 settles on the delegation rail. The scheme is chosen per payment:

- **Delegation-rail accounts settle directly via ERC-7710** with **no funding leg**. The agent's budget delegation is the settlement instrument: it re-delegates a narrowed slice (exact amount, payee pin, short expiry) to the merchant, who redeems it so funds move account→merchant directly, metered on-chain by the same budget. No delegate hot balance, no sweep. The limit today is **merchant reach**: erc7710 needs facilitator-side support, which is still thin, so EIP-3009-only merchants are not yet reachable on this rail. That bridge is **built** and live-proven since 2026-07: EIP-3009 support on the delegation rail (issue #946) reintroduces a bounded, transient funding leg for interop, selected per payment. Since the #1450 decision, erc7710 is the **preferred** scheme whenever a delegation-rail account meets a merchant that advertises it — the bridge is the fallback that keeps EIP-3009-only merchants reachable, not the default.
- **Legacy (AllowanceModule) accounts are RETIRED** and settle nothing: `POST /x402/authorize` answers HTTP 410 (#1986), and the orchestration behind it is deleted (#1987).

The legacy two-leg flow, kept as the record of what that rail did — **it no longer runs**:

1. Agent encounters an HTTP 402 challenge.
2. Haven checks agent identity, wallet context, and remaining allowance.
3. Haven can construct and relay a budget-constrained Safe-to-delegate funding step.
4. The agent signs the merchant-facing EIP-3009 payment from the delegate wallet.
5. The SDK retries the request with the standard `X-PAYMENT` header.
6. Haven tracks funded, executed, failed, and stranded-payment states where relevant.

On any funding-leg flow — today that means the **#946 EIP-3009 bridge**, which is built and live — the delegate key is a hot payment key and should be treated carefully. Keep x402 budgets small and reset-bound, rotate exposed keys, and reconcile/sweep stranded delegate balances before scaling high-volume payment traffic.

Production merchant facilitation, Stripe MPP, fiat/card rails, and merchant settlement are not current production surfaces. Treat them as future or review-required work under `docs/regulatory/casp-risk-guardrails.md`.

## Retired Rails

Haven runs **one live on-chain policy rail**: the delegation rail.

- **Safe + AllowanceModule — RETIRED (epic #1440).** Not frozen: nothing can enter
  it, nothing on it can spend — HTTP 410 fail-closed with nothing written — and its
  execution machinery is deleted. The closure sequence is recorded once in the
  [decision log](docs/archive/decision-log.md#2026-08-14--retire-the-safe-rail-entirely-1440)
  and is not restated here (#2640). **Existing Safe rows are untouched and still readable to a
  direct database query, but since #2413 no account, agent or dashboard surface displays them** —
  balances, tokens and agents no longer render there. Transaction history is the named
  exception: `GET /transactions` carries no rail predicate on either its account or its
  agent list, so legacy names still appear in its picklists. `POST /safe/exec` stays open for
  owner-signed execution relayed for gas, but Haven no longer offers a screen that
  composes such a transaction: a wallet-owned Safe's owner signs at Safe's own
  interfaces, while a **passkey-owned** Safe currently has no self-serve way to
  move funds out. See `docs/product/account-recovery.md`.
- **Smart Sessions / ERC-7579 session rail — retired (#834).** `session_key`
  accounts get HTTP 410 from the payment paths.

Sweep and delegate-balance monitoring are **kept**, because the #946 EIP-3009
bridge is a live funding-leg rail — they are shared machinery, not residue.

## Guardrails

Haven must stay within these product and architecture constraints:

- Haven does not custody user assets.
- Haven does not hold user or agent private keys on the backend.
- API credentials alone cannot spend.
- Off-chain database policy is not the real spend control.
- Automated payment execution must be constrained by an on-chain control the user signed — today, a delegation with audited caveat enforcers.
- User-signed on-chain authority — never an off-chain record — establishes or modifies agent authority.
- Users can enumerate and revoke live delegation authority without Haven. Legacy Safe permissions are owner-managed outside Haven; Haven does not revoke them.
- Haven must not operate swaps, ramps, fiat/card rails, merchant settlement, yield, treasury management, or financial advice flows without separate product, legal, and security review.

Use `docs/regulatory/casp-risk-guardrails.md` before changing payment execution, agent authority, Safe setup, relaying, SDK payment APIs, x402/MPP flows, merchant-facing demos, fiat/card surfaces, swaps, yield, or treasury features.

## Product Language

Prefer these terms in primary UX and user-facing docs:

- Haven account.
- Haven wallet.
- Agent rules.
- Agent budget.
- Haven credential.
- Approve actions.
- Connect your agent.

Avoid exposing Safe, module, relayer, signer, owner, transaction hash, and raw address detail in primary UX unless the surface is explicitly advanced, account detail, transaction detail, or developer-facing.

## Current Tech Snapshot

- Frontend: Next.js and React.
- Backend: Fastify, TypeScript, and PostgreSQL.
- SDK: `@haven_ai/sdk`.
- MCP: local `@haven_ai/mcp`, hosted/keyless `@haven_ai/mcp-server`, and local `@haven_ai/signer`.
- Smart account model: MetaMask Hybrid DeleGator plus signed delegations. (Safe plus AllowanceModule is the retired legacy model.)
- Current chain focus: Base (primary/default) and Gnosis; Base USDC for standard x402 demo merchant flows.
- Payment surfaces: direct payments, x402, Haven machine-payment challenge demos, and internal demo merchant MCP.

## Mental Model

```
User controls the Haven wallet and budgets.
Agent requests payments and signs with its credential.
Haven authenticates, verifies, relays, records, and presents status.
On-chain delegation rules decide what can move automatically.
Nothing moves outside them — an out-of-envelope payment reverts on-chain.
```

## Future Work

The following are possible future directions, not current production promises:

- Broader protocol adapters.
- Merchant acceptance or facilitator flows.
- Stripe MPP, fiat rails, card rails, or merchant settlement.
- Session keys, guards, or alternative on-chain permission systems.
- Multi-chain expansion.
- Micropayment batching, tabs, or payment channels.

Any future work in these areas must preserve the non-custodial model and pass the guardrails in `docs/regulatory/casp-risk-guardrails.md` before being treated as product behavior.
