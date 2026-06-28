---
owner: "@d-hinders"
status: research
covers: []  # narrative — no direct code mirror
last-verified: "2026-06-28"
---

# Architecture — accounting data feed (Fortnox-first, hosted add-on)

> Status: **design proposal.** Forward-looking; tracked by epic
> [#491](https://github.com/d-hinders/Haven-AI/issues/491). Re-aims the
> bookkeeping work in [`bookkeeping-ready-export.md`](./bookkeeping-ready-export.md)
> (#462) from *asserting finished books* to *feeding clean transaction data* the
> accountant codes. Reuses the data layer already shipped; changes the output and
> the packaging.

## 1. TL;DR / recommendation

Buyers who let agents spend end up with crypto transactions their accountant
can't easily book. #462 answered this by **asserting** the booking — auto-deriving
VAT treatment + BAS accounts and pushing finished **vouchers** into the
customer's live ledger (plus SIE files). On the data Haven actually has (amount +
merchant + maybe a resource URL — **no line items, no VAT breakdown**) those
assertions are guesses, and pushing them as final bookings is a trust *and*
liability risk (§6).

Recommendation: keep the data keystone, change the output and the packaging.

1. **Feed transactions, don't assert books.** Push each settled payment into the
   tool the customer already uses (**Fortnox first**) as a **non-asserting**
   draft / source document — receipt attached, *suggested* account at most. The
   accountant codes and confirms. Haven is a clean data source, not the books.
2. **Reuse the keystone.** Build on the canonical `AccountingEntry` + book-time
   FX (#467) and verifiable receipts (#486). Capture-once-at-settlement SEK stays;
   only what we emit changes.
3. **One pluggable connector.** An internal `AccountingConnector` interface with
   Fortnox as adapter #1; Visma / Bokio / Xero slot in later (§7).
4. **Ship it as a hosted, paid add-on** (§8). Self-hosted / local-MCP users don't
   get it. v1 gates on a manual entitlement; tiers plug in later.

## 2. Why / who

The buyer is the prosumer / SMB / agency that has to *account for* agent spend.
The win is "your agent payments show up automatically where your accountant
already works" — a retention/distribution feature that leverages data only Haven
has, **without** making Haven a bookkeeping engine or a tax authority. This is
the standard fintech playbook: Stripe, Wise, Pleo and Qonto all *feed* accounting
tools rather than replacing them.

## 3. The core principle — feed, don't assert

A spectrum of how much accounting judgment a vendor takes on, lightest first:

| Model | What Haven asserts | Who codes it | Risk |
|---|---|---|---|
| **Transaction / bank-feed** | almost nothing (date, amount, counterparty, receipt) | accountant | low |
| **Supplier invoice / source doc** | a *suggested* account, reviewable | accountant | low–med |
| **Draft / preliminär voucher** | double-entry structure (unposted) | accountant confirms | medium |
| **Posted voucher** (#462 today) | full booking incl. VAT, in the live ledger | nobody — it's filed | **high** |

This epic lives in the top two rows. The invariant: **Haven proposes; the
accountant disposes.** Nothing lands in the ledger without a human action. The
chosen Fortnox mechanism is resolved by the spike (§9 / #494).

## 4. What we have to feed (reuse, don't recompute)

Everything the feed needs already exists from the #462 data work:

- **Book-time FX (#467).** `machine_payment_evidence.amount_sek` / `fx_rate_sek` /
  `fx_source` / `fx_at`, captured once at settlement in
  `recordMachinePaymentEvidenceBase` and frozen (`COALESCE` on conflict). The
  accountant's tool expects SEK; this is what makes feeding crypto viable. Never
  recompute from a later rate.
- **Canonical `AccountingEntry`** (`lib/accounting-entry.ts`) — one per settled
  payment, derived from evidence + the fee ledger.
- **Verifiable receipts (#486 / #487)** — the underlag we attach (§9.3).
- **Fortnox OAuth + token lifecycle (#469)** — `lib/fortnox-connection.ts`
  (`getValidFortnoxAccessToken`, refresh-on-expiry). Reused as-is; no second
  connection store.

## 5. `ReportingTransaction` — the non-asserting shape

The feed must be **structurally incapable** of carrying an asserted VAT line, so
it uses a reduced type derived from `AccountingEntry` — *not* `AccountingEntry`
itself (which carries `vatTreatment` and feeds the legacy voucher path).

```ts
interface ReportingTransaction {
  paymentId: string
  settledAt: string
  direction: 'out' | 'in'
  counterparty: { address: string | null; name: string | null }
  resourceUrl: string | null
  token: string
  amountAtomic: string
  // book-time, frozen (from #467) — null only if a pricing outage left it unset
  amountSek: string | null
  fxRate: string | null
  fxSource: string | null
  fxAt: string | null
  receiptRef: string          // -> attach the verifiable receipt (#486)
  suggestedAccount?: string   // optional, explicitly a suggestion — never VAT
}
```

`toReportingTransaction(entry: AccountingEntry): ReportingTransaction` drops
`vatTreatment` and any posted double-entry. (Issue #495.)

## 6. Why not posted vouchers / SIE-as-a-product (regulatory note)

Detail in the epic; the short version, so it isn't re-litigated:

- **VAT determination needs facts we don't have** (supplier taxable status,
  establishment, goods vs services). Defaulting all foreign spend to reverse-charge
  EU is a guess. Asserting it into the ledger makes Haven the de-facto VAT
  determiner.
- **Posted vouchers carry liability.** A wrong booking → Skatteverket correction /
  *skattetillägg*; the customer blames the vendor that filed it. It also implicates
  *verifikat* completeness + 7-year retention/immutability under Bokföringslagen.
- **A SIE *file* is low-risk** (a manual import = a human checkpoint); **auto-push
  of finished vouchers is not** (no checkpoint). This epic keeps the human in the
  loop everywhere.
- The legacy asserting paths are not deleted — they go **dark behind a flag**
  (#492). SIE / posted-voucher / auto-VAT can be revisited later with legal sign-off.

> Not legal advice. A Swedish redovisnings-/skattejurist should review the chosen
> Fortnox mechanism (§9) before it ships, especially anything touching VAT.

## 7. Connector architecture — pluggable, Fortnox first

```
ReportingTransaction ──> AccountingConnector ──> Fortnox adapter (#1)
                                            └──> Visma / Bokio / Xero (later)
```

```ts
interface PushResult { externalRef: string | null; status: 'pushed' | 'skipped'; reason?: string }
interface AccountingConnector {
  provider: string                                  // 'fortnox'
  isConnected(userId: string): Promise<boolean>
  pushTransaction(userId: string, tx: ReportingTransaction): Promise<PushResult>
}
```

**Per-provider, not an aggregator — for now.** Unified accounting aggregators
(Codat, Rutter, Merge, Apideck) are US/UK-centric; Nordic coverage of
Fortnox / Visma / Bokio is weak. So for the SE market we build Fortnox directly,
behind one internal interface, and add Visma/Bokio directly as demand warrants.
Reach for an aggregator only when expanding to Xero/QuickBooks territory, where
the one-to-many economics pay off. (Issue #495 / #496.)

## 8. Packaging — hosted-only paid add-on

The feed is a capability of the **hosted offering** (managed backend / hosted
MCP), because that's where Haven controls execution and can monetize. Gate =
**all three** true:

```
config.hosted (HAVEN_HOSTED=true on the managed deploy)
  && config.reportingFeedEnabled (HAVEN_REPORTING_FEED_ENABLED — global kill-switch)
  && hasEntitlement(userId, 'reporting_feed')
```

Entitlements are a table, not a boolean, so future **pricing tiers** map
`plan → {entitlements}` without reworking the gate:

```
account_entitlements (user_id, entitlement, granted_at, revoked_at)
```

v1 grants `reporting_feed` manually (admin path / script); no self-serve billing
yet. Self-hosted deployments can't enable it with env alone — the entitlement is
still required. When unavailable, feed + Reporting routes return `404` (don't
advertise the feature). (Issue #493.)

## 9. Fortnox mechanism — the open question (spike #494)

The one real unknown: *which* Fortnox API call is non-asserting. Candidates,
in increasing assertion:

1. **Inbox / file attachment** (e.g. Fortnox "Inkorg" / archive / supplier-invoice
   file upload) — push the receipt as a source document for the accountant to
   attach + code. Lightest; pairs naturally with §9.3.
2. **Supplier invoice** (`/supplierinvoices`) — models each payment as a supplier
   invoice the accountant reviews. Natural for spend; assumes a supplier + an
   invoice that may not exist.
3. **Draft / preliminär voucher** — confirm whether Fortnox exposes an
   unposted/preliminary state via API; still asserts double-entry structure.

The spike (#494) picks one and documents: idempotency key / stable external ref
(§9.2), attachment support (§9.3), required scopes (current scope is
`bookkeeping`), rate limits, sandbox steps, and multi-currency presentation
(crypto + frozen book-time SEK).

### 9.1 Auto-feed on settlement

Hook the feed into `recordMachinePaymentEvidenceBase` — the same best-effort,
swallow-on-error spot where the fee ledger is already written. Guard on the §8
gate + an active connector, then `claimSync → pushTransaction → markPushed/Failed`.
**A feed failure must never throw into settlement.** Connecting backfills prior
settled spend through the same idempotent path. (Issue #499.)

### 9.2 Idempotency & dedup (never double-post)

Persist every push so re-syncs, backfills, and retries can't double-post — the
fastest way to lose an accountant's trust.

```
reporting_feed_syncs (
  id, user_id, provider, payment_id, external_ref,
  status,           -- pending | pushed | failed | skipped
  error, attempts, created_at, updated_at,
  UNIQUE (provider, payment_id, user_id)
)
```

`claimSync` inserts `pending` with `ON CONFLICT DO NOTHING` (mirrors
`payment_fees` / `recordSettledFee`); a `pushed` row with an `external_ref`
short-circuits any re-push. (Issue #497.)

### 9.3 Receipt / underlag attachment

Attach the verifiable receipt (#486) to the fed transaction when the chosen
mechanism supports it; otherwise include a stable receipt **link** in the
reference and record the degradation. A missing receipt (e.g. FX/receipt not yet
available) never blocks the feed — the sync stays retryable. (Issue #498.)

## 10. Dashboard — "Reporting"

The dashboard page is **Reporting** (`/reporting`), superseding the `/accounting`
page (#471). It's entitlement-gated (§8): an add-on upsell state when not
entitled, hidden when self-hosted, full UI when entitled — connect/disconnect
Fortnox, per-transaction sync state (pushed / pending / failed) with retry. The
legacy SIE export + "Push vouchers" controls are removed (dark via #492). UI
follows the surface hierarchy in `CLAUDE.md` / `/design-system` (no nested filled
cards; `Card.Section` / `Row`). (Issue #500.)

## 11. Positioning + ToS

Frame as a **data feed**, not bookkeeping: "your agent payments appear
automatically in your accounting tool; your accountant codes and confirms them."
Drop "audit-ready / bookkeeping-grade / we do your books" from these surfaces.
The connect flow shows a short disclaimer before authorization: Haven provides
data tooling, **not** accounting or tax advice; the customer + accountant own
correctness and filing. (Issue #501.)

## 12. Open questions

1. **Fortnox mechanism** — resolved by the spike (#494).
2. **Multi-entity** — v1 assumes one Fortnox company per Haven account; Safe →
   entity mapping deferred.
3. **Who connects** — v1: the account owner connects their own Fortnox; the
   accountant works inside Fortnox afterward. No separate accountant-invite flow.
4. **Billing** — v1 is a manual entitlement; the `plan → entitlements` mapping and
   self-serve checkout are a follow-up.
5. **Feed latency target** — define the acceptable settle-to-appears window for
   the orchestration AC (#499).
