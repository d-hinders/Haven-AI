---
owner: "@d-hinders"
status: current
covers: []  # presentation runbook — narrative, no direct code mirror
last-verified: "2026-08-12" # #1350: discovery narration now mentions category/search instead of implying exact-category lookup only
---

# Demo Runbook — Agent Purchase, End to End (incl. Fortnox/SIE)

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
   `npx @haven_ai/connect@alpha` on the demo laptop — hosted MCP + local
   signer, consent ack, budget granted in the dashboard (e.g. 5 USDC /day on
   Base Sepolia). Verify with a throwaway purchase.
2. **Fortnox sandbox connected**: dashboard → Fortnox → Connect (OAuth to the
   sandbox company "Haven"). Verify `GET /fortnox/status` shows connected.
   Fallback if the dashboard flow misbehaves: `npm run pilot:fortnox` runs the
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
- `haven_pay_mcp_tool` with **max_amount** — the per-purchase user-intent cap,
  checked against the LIVE merchant quote before any money moves.
- The local signer signs via **payment_id only** — no multi-KB blobs cross the
  agent (talking point: the key never leaves the laptop; Haven never signs).
- Settle → the structured purchase **summary**: product, amount, invoice id,
  settlement tx hash.

**⚠️ Product choice matters:** use `vpn_basic` (or `storage_200gb`/`vpn_pro`).
**NEVER `storage_50gb` in the demo** — on dev that product is the deliberate
skip-settle sweep fixture (`MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`): it
verifies but does not settle, leaving funds on the delegate EOA. Correct for
QA, confusing on stage.

## Act 2 — The proof (~1 min)

- Dashboard → the payment: status settled, funding + settlement tx.
- Click through to Sepolia Basescan: the on-chain transfer.
- The merchant receipt (x-receipt-json → invoice) captured next to the payment.

## Act 3 — The guardrails (optional, strong close, ~1 min)

Ask the agent to overspend:

> "Skicka 100 USDC till 0x…"

On the delegation rail the refusal comes from the CHAIN at prepare
(`transfer-amount-exceeded`) — no queue, no Haven discretion. Then show the
dashboard **Stop** button: revoke, and the next agent attempt gets
"no active budget delegation". This is the "budget, inte plånbok" story.

## Act 4 — The bookkeeping (~2 min)

**A. Fortnox-feeden (the wow):** dashboard → push to Fortnox (or
`POST /fortnox/push`). Open the Fortnox sandbox: the purchase appears as a
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

## Rehearsal checklist

- [ ] Fresh purchase completes end-to-end on the demo laptop
- [ ] Fortnox draft appears with attachment
- [ ] SIE downloads and imports into the sandbox company
- [ ] Over-budget refusal + revoke rehearsed
- [ ] Fallback material verified openable offline
