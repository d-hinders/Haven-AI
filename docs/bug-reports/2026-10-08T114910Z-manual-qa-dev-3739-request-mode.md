---
owner: "@d-hinders"
status: current
covers:
  - packages/mcp-server/src/tools/plain-http-x402.ts
  - packages/mcp-server/src/tools/state-direct-recovery.ts
last-verified: "2026-10-08"
---

# QA run report — manual live runtime/merchant — #3739 hosted `haven_pay_x402_quote` request mode — dev

> **Secret-safety rule:** No private keys, API keys, setup tokens, Authorization
> headers or credential files appear here. Only public addresses, payment ids,
> transaction hashes and sanitized URLs. The 11 KB erc7710 payment header was
> used from a scratch file outside the repo and is not reproduced.

## Run Metadata

- **Run mode:** manual live runtime/merchant (`/qa-dev`, Layer 2b, non-gating)
- **Flow/scenarios:** #3739 request mode (PR #3762): goals A–E below
- **Started / finished (UTC):** 2026-10-08 ~11:35 / ~11:49
- **Runner:** Claude Code (Opus 5.5), desktop app, owner's laptop
- **Exact command:** none. The run used the already-connected `haven` + `haven-signer` MCP pair (Phase 1 step 1 of `/qa-dev`), so no connector command ran and no `wiring_collision` question came up.
- **Process exit code:** n/a (interactive tool calls)
- **Git branch / SHA:** `dev` / `7efc0b55`
- **Frontend URL / build SHA:** n/a
- **Backend URL / deploy SHA:** dev backend behind the dev hosted MCP; deploy SHA not exposed (`/healthz` returns `{"status":"ok"}` only)
- **Hosted MCP:** `https://haven-ai-hosted-mcp-dev-25c7.up.railway.app/v1`. #3762 is deployed: the `haven_pay_x402_quote` input schema declares `method`, `headers` and `body`, and `payment_required` is optional (no `required` list).
- **Merchant URL / version:** `demo-merchant-dev-84e4.up.railway.app` (`/mcp`), `environment: dev`
- **Chain:** Base Sepolia (`84532`)
- **Runtime:** Claude Code MCP client; local signer `@haven_ai/signer 0.7.0-alpha.0` (from `signer-runtime.json`)
- **Public QA identity:** agent `4c6fb76a-2250-427b-ae96-a01069c3f560` ("Atlas"), account `0x98ffBf30459a98FD80fAce18f519967769641F76`, delegate `0x2b2e66489c4BEdE4D510CD1A3062Ea45Edc8AAC9`, delegate account `0xbb4D807a7BA2DDea2de92aa0b8a725D45918133d`. Open (unpinned) 1 USDC/day budget, delegation `0xf6bde37a…bbf65`. This is not the 5 USDC/day #1063 identity described in `agent-qa.md`, and `~/.haven/qa-delegation.env` was absent, so the identity could not be matched mechanically. The **owner confirmed in-session** that Atlas is the agent to use before any money step.
- **Overall result:** **pass with friction**
- **Completeness:** 5/5 goals passed · 0 failed · 0 skipped (both settlement schemes exercised)

The `haven-claude-cloud` pair configured on the same machine points at the **production** hosted MCP. It was never called.

## Preflight

- [x] Dev/testnet only (Base Sepolia, dev hosted MCP, dev demo merchant).
- [x] Targets confirmed: `claude mcp list` shows `haven` → dev hosted MCP, `haven-signer` → the local Atlas signer.
- [x] Budget before: `haven_get_allowances` remaining `1000000` atomic (1.0 USDC), spent 0, `fundsCoverRemaining: true`.
- [x] Relayer gas: sufficient (the funding UserOp confirmed).
- [x] Delegate balance: n/a for erc7710; the eip3009 funding leg was consumed by the merchant settlement (no stranding).
- [x] No secrets printed.

## Goals

### A. Refusals, nothing moves: **PASS**

| Call | Expected | Got | Created anything? |
|---|---|---|---|
| `{ url: "https://example.com/paid" }`, no cap | `INVALID_INPUT` | `INVALID_INPUT` "A spending cap is REQUIRED…" | no |
| `{ max_amount_human: "0.01" }`, no url / no `payment_required` | `INVALID_INPUT` naming `url` | `INVALID_INPUT` "Pass url (the https URL of the request you quoted…) … or pass payment_required" | no |
| `http://example.com/paid` | `MERCHANT_EGRESS_REFUSED` | ✔ "its scheme is http, not https" | no |
| `https://127.0.0.1/paid` | `MERCHANT_EGRESS_REFUSED` | ✔ "IP-literal host (IPv4)" | no |
| `https://[::1]/paid` | `MERCHANT_EGRESS_REFUSED` | ✔ "IP-literal host (IPv6)" | no |
| `https://localhost/paid` | `MERCHANT_EGRESS_REFUSED` | ✔ "single-label host" | no |
| `https://metadata.internal/paid` | `MERCHANT_EGRESS_REFUSED` | ✔ "internal/reserved suffix .internal" | no |
| `https://example.com/` (answers 200) | `X402_PROBE_NOT_PAYMENT_REQUIRED` | ✔ "answered … with HTTP 200, not 402" | no |

`haven_get_allowances` was unchanged after all eight (remaining `1000000`, spent `0`). Two refusal *reasons* are wrong (F3 below), but the codes and behaviour are correct.

### B. Plain-HTTP testnet x402 target: **PASS**

`haven_quote_x402` on `https://demo-merchant-dev-84e4.up.railway.app/mcp` with `POST`, `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and a JSON-RPC `tools/call` body for `buy_vpn { plan: "basic" }` (0.001 USDC, from `/.well-known/haven-demo-merchant`). It returned a 402 quote: two accepts (eip3009 plus erc7710 with a facilitator pin), `expected_settlement_scheme: "erc7710"`, and `next_tool_name: "haven_pay_x402_quote"` with request-mode `next_arguments` (`url`, `method`, `headers`, `body`, `max_amount_human: "0.001"`, `idempotency_key: "x402q:…"`). **No `payment_required` in `next_arguments`.**

The demo merchant answers a **sessionless** `tools/call` with an x402 402. No MCP `initialize` / session id was needed, so the brief's fallback finding (a session needed first) did **not** occur.

### C. Request mode end to end: **PASS (both schemes)**

| Run | Product | Scheme | `payment_id` | Haven tx | Merchant settlement tx | Merchant | Haven final state |
|---|---|---|---|---|---|---|---|
| C1 | `vpn_basic` (eip3009 + erc7710 offered) | **erc7710** (`funding_leg: false`) | `caea864d-f0f6-458c-b1e0-134ef51ffb5d` | none (no funding leg) | [`0x6ec61d1f…22f0ee`](https://sepolia.basescan.org/tx/0x6ec61d1f9e309cf54a09a1b8cc1efb6ccb0b9a98e3eb20f3ac4debb6c322f0ee) | HTTP 200 "Purchase confirmed", `PAYMENT-RESPONSE` success | `settled: true` after `haven_report_settlement_evidence` |
| C2 | `vpn_legacy` (eip3009 only) | **eip3009** funding leg | `09bf4190-7b15-4088-8f2f-0ec58b71b29a` | funding [`0xa525366d…e10f4f`](https://sepolia.basescan.org/tx/0xa525366d7b0714bd19b763a9cebe8c0b28bed4abe02060d1ddbc62ae11e10f4f) | [`0x0e766ade…a7104a`](https://sepolia.basescan.org/tx/0x0e766ade4af660b5097210960a1c9929016498742e3f991ccdcb04a9d4a7104a) | HTTP 200 "Purchase confirmed" | `haven_report_x402_outcome` accepted → `payment_confirmed`, settlement evidence recorded |

Steps as the tools directed them:

- **C1 (erc7710):** `haven_pay_x402_quote` (the quote's `next_arguments` verbatim) → `pending_signature`, `settlement_scheme: erc7710` → `haven_sign { payment_id }` → `haven_submit { settlement_scheme: "erc7710" }` → `payment_header` + `retry_headers.PAYMENT-SIGNATURE` → own `POST` retry with `PAYMENT-SIGNATURE` → 200. Haven then still showed `status: submitted`, `txHash: null` (F1). `haven_report_x402_outcome` refused with a generic `API_ERROR` 409. `haven_report_settlement_evidence` with the `PAYMENT-RESPONSE` transaction verified it on-chain and recorded `settled: true`.
- **C2 (eip3009):** `haven_pay_x402_quote` → `pending_signature`, `signer_compatibility.x402_expected_context_version: 2` (signer supports 2, 3) → `haven_sign_x402 { payment_id }` (returns `payment_header`) → `haven_submit` → `{ status: confirmed, tx_hash }` with **no next step** (F2) → own retry with `PAYMENT-SIGNATURE` + `X-PAYMENT` → 200 → `haven_report_x402_outcome { outcome: accepted, payment_response }` → recorded, `next_action: none`.

### D. Replay before probe: **PASS**

- The same `next_arguments` with the same `idempotency_key` (`x402q:6f328174-…`) as C1 returned `idempotent_replay: true`, **the same `payment_id`** `caea864d…`, and `status: confirmed`. Its next step was `haven_get_payment_status`, with the reason "nothing was probed or created … Do NOT pay again." No new payment.
- The same key with cap `0.0005` (below the 0.001 price) returned `PRICE_EXCEEDS_MAX` "Price 0.001 USDC (1000 atomic) exceeds your cap 0.0005 USDC". No new payment.

### E. Price cap against the fetched challenge: **PASS**

A fresh quote (`vpn_legacy`, key `x402q:6d4f0f56-…`), then `haven_pay_x402_quote` with that quote's `next_arguments` and `max_amount_human: "0.0005"`, returned `PRICE_EXCEEDS_MAX`. `haven_get_allowances` straight after showed spent `1000` (only C1), so no payment was created. The same key at the quoted cap then succeeded (that is C2), so **a cap refusal does not burn the idempotency key**.

## Budget

| Point | Remaining (atomic) | Spent |
|---|---|---|
| Before | 1000000 | 0 |
| After A + B | 1000000 | 0 |
| After C1 / D / E | 999000 | 1000 |
| After C2 | 998000 | 2000 |

Total spent: 0.002 testnet USDC, exactly the two purchases.

## Friction, Bugs, And Infrastructure Failures

| Sev | Type | Step | Expected | Actual | Repro | Issue | Disposition |
|---|---|---|---|---|---|---|---|
| should-fix | product | C1 erc7710 | After the agent's own retry, guidance names how to record the settlement | The submit says the HTTP retry is the only next step. The payment stays `submitted` / `txHash: null`. `haven_report_x402_outcome` refuses with generic `API_ERROR` 409 and points at `haven_get_payment_status`. Only `haven_report_settlement_evidence` (found by reading tool descriptions) closes it. | always | [#3774](https://github.com/d-hinders/Haven-AI/issues/3774) (F1) | new |
| should-fix | product | C2 eip3009 | `haven_submit` names the next step (retry the merchant, then `haven_report_x402_outcome`) | Bare `{ status, tx_hash }`, no `next_action` / `next_tool` / `next_tool_omitted_reason`; `lint:next-steps` does not see bare success returns | always | [#3774](https://github.com/d-hinders/Haven-AI/issues/3774) (F2) | new |
| nit | product | A | Refusal reasons describe what happened | `X402_PROBE_NOT_PAYMENT_REQUIRED` says "could not be probed under the egress policy" though the probe succeeded (200). `MERCHANT_EGRESS_REFUSED` from `haven_pay_x402_quote` tells the agent to use `merchant_url`, which the tool does not have. | always | [#3774](https://github.com/d-hinders/Haven-AI/issues/3774) (F3) | new |
| friction | product | B | One idempotency key per quote | The `haven_quote_x402` result carries a top-level `idempotency_key: "x402:…"` **and** a different `next_arguments.idempotency_key: "x402q:…"`. Following `next_arguments` is right, but the stray top-level key invites copying the wrong one. | always | — | noted |
| friction | product | B | Quote does not hand the agent the blob it must not copy | The quote still returns the full `payment_required` object while its `reason` says "do not copy payment_required". Harmless, and it costs context. | always | — | noted |
| friction | product | C1 | Header fits comfortably in agent context | The erc7710 `payment_header` is ~11 KB of base64, returned twice (`payment_header` and `retry_headers.PAYMENT-SIGNATURE`), and has to be relayed by hand into the agent's own HTTP client | always | — | noted |
| friction | product | C (signer) | Signer results name the next tool | `haven_sign` / `haven_sign_x402` success results carry no `next_tool_name`. The pay result's guidance carried the agent through, so this is minor. | always | — | noted |

No test-infrastructure or environment failures.

## Cleanup And Residual State

- [x] No stranded delegate funds: erc7710 has no funding leg, and the eip3009 funding was settled to the merchant (`PAYMENT-RESPONSE` payer = delegate).
- [x] Post-run budget captured: 998000 atomic remaining (0.998 USDC); it refills at the period boundary.
- [x] No seed/reset needed for the next run.
- [x] Secret review passed: only public addresses, ids, hashes and sanitized URLs.

## Notes For The Coding Agent

- #3739 request mode behaves correctly on dev: refuse-before-probe ordering, egress policy, replay-before-probe, and the cap check against the re-fetched challenge all hold, on both settlement schemes. The fixes needed are guidance, not behaviour (#3774).
- An agent following only `next_tool` / `next_tool_omitted_reason` finishes an **erc7710** plain-HTTP purchase with Haven still reporting `submitted`. The passive sweeper (#2117) is the safety net, but the agent holds the `PAYMENT-RESPONSE` transaction at that moment and should be told to report it.
- #3739 stays open for the prod Bitrefill check.
