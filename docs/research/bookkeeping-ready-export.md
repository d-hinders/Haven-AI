---
owner: "@d-hinders"
status: research
covers:
  - packages/backend/src/lib/accounting-entry.ts
  - packages/backend/src/lib/machine-payment-evidence.ts
  - packages/backend/src/lib/reporting/reporting-transaction.ts
  - packages/backend/src/routes/accounting.ts
  - packages/backend/src/routes/reporting.ts
last-verified: "2026-06-28"
---

# Architecture — bookkeeping-ready export (Fortnox / SIE / beyond)

> **Superseded in direction by [epic #491](https://github.com/d-hinders/Haven-AI/issues/491)
> (accounting data feed).** This doc's "audit-ready / verifikat-grade / agent-era
> Fortnox" framing — Haven *asserting* finished VAT + vouchers — was walked back:
> on thin payment data those are guesses, and asserting them carries trust +
> liability risk. The shipped product **feeds drafts / source documents** into
> the customer's tool and the accountant codes and confirms. The foundation here
> (book-time FX, `AccountingEntry`) is reused; the "asserting" framing and copy
> are not. See [`fortnox-non-asserting-feed.md`](fortnox-non-asserting-feed.md).
>
> Original status: design proposal / business-thesis companion (historical).

## 1. TL;DR / recommendation

Buyers who let agents spend end up with a pile of USDC transactions and tx
hashes — not something an accountant can book. Haven already records every
payment and fee; the gap is turning that into **verifikat-grade accounting
records** a Swedish SMB can file. Recommendation:

1. **Capture the book-time SEK value at settlement** (the keystone — see §4).
   Without it, no downstream export is trustworthy. Do this first, regardless of
   which export ships.
2. **Build one canonical accounting record** per payment (§5), and a
   **rail-agnostic `LedgerExporter`** (§7) — the same shape as the fee module's
   `RailFeeExecutor` and the x402 rail taxonomy.
3. **Ship SIE 4I first** (§7) — the Swedish text standard every accounting system
   imports (Fortnox, Visma, Bokio). One format unblocks the whole market with no
   per-vendor OAuth.
4. **Then add a Fortnox API direct-push tier** (§9) for a one-click,
   no-file-handling premium experience.

This is the moat made concrete: execution stays cheap; the **audit-ready,
bookkeeping-grade history is what a customer can't rebuild** if they leave.

## 2. Why / who

The buyer is the prosumer / SMB / agency that has to *account for* what their
agents spent. Today that's manual and error-prone. "Bookkeeping-ready export"
means they (or their accountant) can file agent spend with near-zero handwork —
ideally a one-click push into Fortnox, at minimum a file their accounting tool
imports.

## 3. What "bookkeeping-ready" means in Sweden (the target)

Concrete requirements the design must satisfy:

- **SEK, at the booking date.** Books are in SEK; a USDC payment must carry its
  SEK value *as of settlement* (FX moves — you cannot recompute it later).
- **Verifikation per event.** Each payment becomes a voucher (verifikation) with
  balanced debit/credit lines against the **BAS** chart of accounts.
- **VAT treatment.** Foreign B2B API/services are typically **reverse charge**
  (omvänd skattskyldighet) — the record needs supplier country + VAT treatment,
  not a guessed VAT line.
- **Receipt / underlag.** Each verifikation needs an attachable proof — Haven's
  existing payment evidence (merchant, amount, tx hash, x402 resource).
- **Account mapping.** Which BAS account the spend lands on (e.g. an IT/services
  expense account) + the fee.

## 4. The keystone: book-time FX capture

A crypto-native ledger that records only token amounts is **not** bookkeeping-
ready — the accountant needs SEK at the booking date. So at **settlement time**
Haven must capture and freeze:

- `amount_atomic` + token (what moved on-chain)
- `fx_rate` (token→SEK) and its **source + timestamp**
- `amount_sek` (booked value), computed once and **immutable**

Recomputing later from "today's" rate is wrong and unauditable. This is a small
addition to the settlement path now that pays off for every export forever. (FX
source: a rate provider keyed to the settlement block time; cache per
day/token.)

## 5. Canonical accounting record

One record per settled payment, enriched at settlement, append-only:

```
AccountingEntry {
  payment_id, tx_hash, chain_id, settled_at
  direction            // out (expense) | in (income/refund)
  counterparty         // merchant address + name (+ country, for VAT)
  token, amount_atomic
  amount_sek, fx_rate, fx_source, fx_at      // book-time FX (§4)
  fee_sek                                     // Haven fee (from #386 ledger)
  category                                    // → BAS account (§8)
  vat_treatment        // none | reverse_charge | standard
  resource_url, receipt_ref                   // underlag (evidence)
}
```

This is the single source the exporters read — derived from the existing
`machine-payment-evidence`, transactions, and fee ledger, plus the §4 FX fields.

## 6. Pipeline

```
payment settles
  → evidence recorded (today)
  → enrich: book-time FX (§4), counterparty country, category, VAT treatment
  → AccountingEntry (append-only)
  → LedgerExporter.export(entries, period)  →  SIE 4I file | Fortnox voucher | CSV
```

Enrichment is where the accounting judgment lives; the exporters are mechanical.

## 7. Export adapters (rail-agnostic)

Mirror the fee module: shared record + accounting logic, pluggable per-target
output.

```ts
interface LedgerExporter {
  export(entries: AccountingEntry[], opts: ExportOptions): Promise<ExportResult>
}
```

| Target | What | Lift | Ship |
|---|---|---|---|
| **CSV** | the generic columns (already shipped, #411) | done | now |
| **SIE 4I** | Swedish standard import file (verifikationer, BAS accounts) — imported by Fortnox, Visma, Bokio, etc. | low–medium | **first** |
| **Fortnox API** | direct voucher push via OAuth2 (no file handling) | medium | second |
| **(later)** | DATEV (DE), QuickBooks/Xero (US/UK) — same record, new adapter | per-market | geo expansion |

**Why SIE first:** one text file unblocks *every* Swedish accounting tool with no
per-vendor integration or OAuth. SIE **4I** is exactly "import of transactions
(verifikationer)" and needs no chart-of-accounts section — the smallest correct
artifact. It's also the geo-expansion template: new market = new exporter over
the same `AccountingEntry` (SIE → DATEV → QuickBooks/Xero), matching the
"Nordics → Europe → US" GTM.

## 8. Account mapping & VAT

- **Categorization → BAS account.** Seed from the merchant catalog category
  (e.g. media/API → an IT-services expense account); let the user override and
  remember the mapping per merchant. Keep a small default BAS map; the user's
  accountant can adjust.
- **VAT.** Default foreign-supplier API spend to **reverse charge** and flag it,
  rather than inventing a VAT line. Surface the supplier country (from the
  merchant registry) so the treatment is explicit and the accountant can confirm.
- **The Haven fee** is its own line (a Swedish-supplier service with standard
  VAT) — already captured in the fee ledger (#386).

> Invariant: Haven produces *proposed* accounting records with explicit,
> reviewable treatments — it is not a tax authority. The accountant remains in
> the loop; we make their work near-zero, not invisible.

## 9. Fortnox specifics

- **Auth:** OAuth2 Authorization Code flow; register the integration in the
  Fortnox Developer Portal for a client id/secret; the customer grants the
  **Bookkeeping** scope.
- **Object:** create **Vouchers** (verifikationer) via the REST v3 API — balanced
  debit/credit lines per `AccountingEntry`. (Supplier-invoice objects are an
  alternative for the AP framing; vouchers are the most direct fit for settled
  payments.)
- **No voucher webhook** — push on settlement (or batch per period) from Haven;
  don't rely on Fortnox callbacks.
- **No-OAuth alternative:** the SIE 4I file the user imports into Fortnox
  manually — same `AccountingEntry`, zero integration. Good for the long tail and
  for non-Fortnox tools.

## 10. Phasing

- **P0 — capture.** Add book-time FX (§4) to the settlement path + the
  `AccountingEntry` record. Extend the existing CSV (#411) to the full columns
  incl. `amount_sek`/`fee_sek`. Pure value, no external integration.
- **P1 — SIE 4I export.** `LedgerExporter` + the SIE writer + a basic BAS map.
  Unblocks Fortnox/Visma/Bokio via import.
- **P2 — Fortnox API push.** OAuth2 connect flow + voucher push; one-click.
- **P3 — VAT/categorization rules + reconciliation** (per-merchant memory,
  reverse-charge handling, matching booked entries to on-chain settlement), then
  the next-market adapter.

## 11. Custody / compliance fit

No new custody surface — this reads settled-payment data Haven already has and
emits files/records. It strengthens the audit trail (Layer 5) and is the
concrete form of the "agent-era Fortnox" moat: the more an agent transacts, the
deeper the bookkeeping integration and the higher the switching cost — and that
data, unlike behavioral telemetry, *cannot leave with the customer's memory*.

## 12. Open questions

1. **FX rate source** — which provider, and pin to settlement block time vs.
   daily close? (Recommend daily close per token for simplicity; store it.)
2. **Who owns the BAS account mapping** — Haven defaults, user, or their
   accountant? (Recommend Haven defaults + per-merchant user override.)
3. **VAT default** — reverse charge for all foreign suppliers, or per-merchant?
4. **Voucher granularity** — one verifikation per payment, or a daily/period
   summary voucher? (Per-payment is most auditable; offer period rollups later.)
5. **Multi-entity** — one company per Haven account, or map Safes → entities?
6. Does this become its own export package/module, reusing the fee ledger
   ([#386](https://github.com/d-hinders/Haven-AI/issues/386)) and CSV
   ([#411](https://github.com/d-hinders/Haven-AI/issues/411))?

## 13. References

- Fortnox developer portal / vouchers + OAuth2 (REST v3, Bookkeeping scope):
  https://www.fortnox.se/developer
- SIE file format (Swedish accounting interchange; 4I = transaction import):
  https://sie.se / https://en.wikipedia.org/wiki/SIE_(file_format)
- BAS chart of accounts: https://en.wikipedia.org/wiki/BAS_(accounting)
- Haven fee ledger epic [#386](https://github.com/d-hinders/Haven-AI/issues/386);
  CSV export [#411](https://github.com/d-hinders/Haven-AI/issues/411).
