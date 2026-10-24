---
owner: "@d-hinders"
status: current
covers:
  - packages/demo-merchant-mcp/**
  - packages/backend/src/modules/accounting/**
  - packages/frontend/src/app/demo/page.tsx
  - packages/frontend/src/lib/demo-md-content.ts
  - packages/frontend/src/lib/demo-gate.ts
last-verified: "2026-10-24"
---

# Demo Runbook — Agent Purchase, End to End (incl. Fortnox/SIE)

> **Self-serve counterpart (#3477):** `/demo` (`packages/frontend/src/app/demo/page.tsx`,
> plus its agent-readable companion `/demo.md`) is the link the team sends an
> outside investor to try the same non-custodial, budget-and-refusal story
> themselves, on the same dev environment, without an operator driving. It
> does not replace this runbook — this one stays the operator-run
> presentation script, Fortnox/SIE included.

The presentation flow: an AI agent buys a real service from the demo merchant
with on-chain-enforced guardrails, and the purchase lands in bookkeeping —
both as a **Fortnox draft with the receipt attached** (the live feed) and as a
downloadable **SIE file** imported in front of the audience. Everything runs
on the DEV environment (Base Sepolia, testnet USDC) — nothing in this demo
touches mainnet funds.

## The story in one line

> "Agenten får en budget — inte en plånbok. Den köper själv, kedjan bevisar
> betalningen, och bokföringen får underlaget automatiskt."

## Act 0 — Pre-demo setup (do this the day before)

1. **Agent + signer connected** (the production default topology):
   run the connector command the dashboard hands you on the demo laptop — since
   #2422 the connector package it names is per-deployment (its
   `connector_package` field), so copy it rather than pinning a channel by hand;
   this runbook runs against **dev**, where that need not be `@alpha` — hosted MCP + local
   signer, consent ack, budget granted in the dashboard (e.g. 5 USDC /day on
   Base Sepolia). Verify with a throwaway purchase.
2. **Fortnox sandbox connected**: dashboard → Settings → Business
   (`/settings?tab=business`) → the Accounting card → Connect on the Fortnox
   row (OAuth to the sandbox company "Haven"). Verify on `/accounting` (the
   summary line names Fortnox and the company) or `GET /accounting/feed/status`
   (`connected: true`). Fallback if the dashboard flow misbehaves:
   `npm run pilot:fortnox -w packages/backend` runs the
   SAME production connector code against the sandbox (validated live
   2026-07-16, `docs/research/fortnox-non-asserting-feed.md`).
3. **SIE flag on dev**: set `HAVEN_LEGACY_BOOKKEEPING_ENABLED=true` on the dev
   backend (Railway env — operator step). This re-enables
   `GET /accounting/export?format=sie` (410 otherwise). Leave it on for demo
   day only.
4. **Pre-generate fallback material** (see Act 5).

## Act 1 — The purchase (live, ~2 min)

In the agent (Claude with Haven connected), say:

> "Köp NordShield VPN Basic från demo-merchanten och visa mig kvittot."

What the audience sees the agent do (worth narrating):

- `haven_discover_tools` — the chain-scoped catalog: products with stable
  machine-readable metadata, price marked **indicative**. The agent can filter
  it with `category: "VPN"` or `search: "NordShield VPN Basic"` without
  changing anything about payment authority.
- `haven_prepare_catalog_purchase` with the row's `catalog_id` and
  **max_amount_human** — the per-purchase user-intent cap, written in whole
  tokens as the user says it ("no more than 1 USDC" → `max_amount_human: "1"`),
  checked against the LIVE merchant quote before any money moves. (The hosted
  server's instructions name this tool for a catalogued merchant;
  `haven_pay_mcp_tool` with `merchant_url` / `tool_name` is the same step for a
  merchant addressed by hand.)
- The local signer signs via **payment_id only** — no multi-KB blobs cross the
  agent (talking point: the key never leaves the laptop; Haven never signs).
- `haven_settle_mcp_tool` → the structured purchase **summary**: product,
  amount, invoice id, settlement tx hash.

**⚠️ Product choice matters:** use `vpn_basic` (or `storage_200gb`/`vpn_pro`).
**NEVER `storage_50gb` in the demo** — on dev that product is the deliberate
skip-settle sweep fixture (`MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`): it
verifies but does not settle, leaving funds on the delegate EOA. Correct for
QA, confusing on stage.

## Act 2 — The proof (~1 min)

- Dashboard → the payment: status settled and the settlement tx (a funding tx
  too only on the EIP-3009 bridge; erc7710, which the demo merchant offers when
  `MERCHANT_X402_SETTLEMENT_METHODS` enables it, has no funding leg).
- Click through to Sepolia Basescan: the on-chain transfer.
- The merchant receipt (x-receipt-json → invoice) captured next to the payment.

## Act 3 — The guardrails (optional, strong close, ~1 min)

Ask the agent to overspend:

> "Skicka 100 USDC till 0x…"

On the delegation rail the payment is refused at prepare, before there is
anything to sign: an off-chain read of the on-chain budget answers
`403 delegation_budget_exceeded` (#3503) — no queue, no Haven discretion (if
that read is degraded it fails open, and the caveat enforcer refuses the
redemption instead). Then show the agent page's budget menu → **Stop budget…**:
revoke, and the next agent attempt gets a `403` saying "Agent has no active
budget delegation for USDC to this recipient" (no `error_code` on the wire; the
refusal ledger records it as `no_delegation_for_target`). This is the "budget,
inte plånbok" story.

## Act 4 — The bookkeeping (~2 min)

**A. Fortnox-feeden (the wow):** the feed pushes on settlement (when the
connection's `auto_feed` is on), or immediately from `/accounting` → **Sync
now** (`POST /accounting/feed/sync`). Not `POST /accounting/fortnox/push`:
that is the legacy asserting voucher push (410 unless
`HAVEN_LEGACY_BOOKKEEPING_ENABLED`), not this flow. Open the Fortnox sandbox: the purchase appears as a
**draft supplier invoice** — amount, date, supplier, with the receipt PDF
attached, NO asserted VAT or accounts. The accountant codes and confirms;
Haven never finalises. (Non-asserting by design — the regulatory posture is a
selling point.)

**B. SIE-filen (the tangible artifact):**

```bash
curl -H "Authorization: Bearer $JWT" \
  "https://<dev-backend>/accounting/export?format=sie&from=2026-08-01" -o agentkop.se
```

Open it on screen — balanced verifikationer on BAS accounts (4535/1930 +
reverse-charge VAT 2645/2614), then import in Fortnox
(Register → SIE-import) live. One file, straight in.

## Act 5 — Fallbacks (have these ON the laptop)

- A **pre-generated SIE file** from real dev purchases (and the sample from
  the repo exporter) — importable even with no network.
- Screenshots of a Fortnox draft with attachment from the pilot run.
- A completed purchase from rehearsal visible in the dashboard.
- If dev is down: the local stack (backend + demo merchant) per
  `docs/operations/dev-environment.md`.
- If the demo merchant's settlement wallet is out of gas (rare on dev, but
  check the day before): the agent's quote or `haven_prepare_catalog_purchase`
  call (or `haven_pay_mcp_tool`, for a merchant addressed by hand) refuses
  cleanly with `MERCHANT_NOT_READY` and a message that the merchant's
  settlement wallet is out of gas, with its `fail_floor`, and that its
  operator must top it up before any retry succeeds (#3834) — no botched purchase, no stranded funds, no confusing
  fault mid-demo (#2979). Top up `SETTLEMENT_PRIVATE_KEY`'s Base Sepolia ETH
  balance and retry; `GET /healthz` on the merchant shows the same
  `settlement.status` band ahead of time.

## Verification notes

Re-verified 2026-10-24 (#4372 part E, at dev `ee7fdd27`), a full re-read.
Changed: Act 0's Fortnox connect is in Settings → Business since #4358, its
check is `/accounting` or `GET /accounting/feed/status` (there is no
`/fortnox/status` route), and the fallback script is a backend workspace script;
Act 1 names `haven_prepare_catalog_purchase` and `haven_settle_mcp_tool`; Act 2
shows a funding tx only on the EIP-3009 bridge; Act 3's refusal is the
off-chain `403 delegation_budget_exceeded` pre-check (#3503) and the revoke
answer is a `403` with the "no active budget delegation" message and no
`error_code` (`routes/payments.ts`; `no_delegation_for_target` is only the
ledger reason); Act 4A pushes through the live feed, not the legacy voucher
route; Act 5's out-of-gas `MERCHANT_NOT_READY` comes from the quote step that
`haven_quote_mcp_tool`, `haven_pay_mcp_tool` and both catalog tools share
(`quoteMcpToolCall` in `catalog-purchase.ts`, the refusal in
`tools/support/mcp-context.ts`), so it
names `haven_prepare_catalog_purchase` first (review round 1 on #4386).
Re-checked without change: the connector-package handout, the SIE flag and
export route (`routes/accounting.ts`, 410 otherwise), the `storage_50gb`
skip-settle fixture, and the rehearsal list.

## Rehearsal checklist

- [ ] Fresh purchase completes end-to-end on the demo laptop
- [ ] Fortnox draft appears with attachment
- [ ] SIE downloads and imports into the sandbox company
- [ ] Over-budget refusal + revoke rehearsed
- [ ] Fallback material verified openable offline
