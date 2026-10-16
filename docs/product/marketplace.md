---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/db/migrations/088_merchants.ts
  - packages/backend/src/db/migrations/089_marketplace_prospects.ts
  - packages/backend/src/db/migrations/101_merchant_pay_to.ts
  - packages/backend/src/routes/agent-delegations.ts
  - packages/backend/src/modules/catalog/merchant-catalog.ts
  - packages/backend/src/infra/repositories/delegation-budgets.ts
  - packages/backend/src/infra/repositories/merchants.ts
  - packages/backend/src/modules/catalog/marketplace-scope.ts
  - packages/backend/src/modules/catalog/prospect-copy.ts
  - packages/backend/src/routes/merchants.ts
  - packages/backend/src/routes/catalog.ts
  - packages/backend/src/config.ts
  - packages/frontend/src/app/(authenticated)/marketplace/page.tsx
  - packages/frontend/src/app/(authenticated)/marketplace/[slug]/page.tsx
  - packages/frontend/src/components/marketplace/MerchantGrid.tsx
  - packages/frontend/src/components/marketplace/MerchantCard.tsx
  - packages/frontend/src/components/marketplace/MerchantHeader.tsx
  - packages/frontend/src/components/marketplace/OffersTable.tsx
  - packages/frontend/src/components/marketplace/OfferRow.tsx
  - packages/frontend/src/components/marketplace/HowToBuyPanel.tsx
  - packages/frontend/src/components/marketplace/FundMerchantModal.tsx
  - packages/frontend/src/components/marketplace/MerchantBudgetsList.tsx
  - packages/frontend/src/components/DelegationBudgetCard.tsx
  - packages/frontend/src/components/EditBudgetModal.tsx
  - packages/frontend/src/hooks/useDelegationBudget.ts
  - packages/frontend/src/hooks/useMerchantBudgets.ts
  - packages/frontend/src/lib/marketplace.ts
  - packages/frontend/src/lib/merchantBudgetRefusal.ts
  - packages/frontend/src/hooks/useCatalog.ts
  - packages/frontend/src/components/CatalogSubmitModal.tsx
last-verified: "2026-09-27"
---

# Marketplace

The catalog's sell side (epic #3077). The catalog is one flat table of payable
endpoints; the marketplace puts the **merchant** in front of them — the seller
a buyer chooses, whose page then lists what it sells. This document describes
the data and the API (slice 1, #3078); the `/marketplace` screens are slice 2
(#3079) and the "coming soon" prospects slice 3 (#3080).

## Merchants and offers

A **merchant** (`merchants`, migration 088) is a seller with a stable `slug`,
a name, a one-line description, an optional website and logo, a category, a
country when known, and two flags that decide how it is shown:

- `listing_status` — `live` (has payable offers) or `coming_soon` (a prospect
  Haven is talking to; no offers, never payable, see *Prospects*). This is a
  different vocabulary from an offer's `status` (`active | degraded |
  delisted`) on purpose: a merchant is a company, an offer is an endpoint, and
  the two must not be confused in code either.
- `is_test_merchant` — Haven-run test content: the **Haven demo store**
  (CloudNest storage and NordShield VPN tiers on the dev and prod demo hosts —
  real payments, demo goods) and the **Minifetch stranded-funds fixture**
  (its funding leg succeeds and it never settles; listed so clients can prove
  they survive that). This flag is the structural signal a pre-filtering
  client uses; the older `category: 'test-fixture'` stays as data. Not every
  demo-store offer is listed, though: the Sepolia CloudNest 50 GB offer is the
  dev demo merchant's `MERCHANT_SKIP_SETTLE_PRODUCT` verify-without-settle QA
  fixture (`storage_50gb`, chain-gated to 84532), and #3421 delisted it
  (migration `102_delist_skip_settle_catalog_row`) rather than relabeling it
  the way Minifetch is labeled — unlike Minifetch, this fixture is not meant
  to be catalog-reachable, only callable on the merchant directly. Its
  Base-mainnet sibling settles normally and stays listed.

An **offer** is a catalog row. Every operator row has a `merchant_id` (NOT
NULL after 088) and every self-submitted row gets one the moment it is
verified payable (`docs/operations/catalog-ingestion.md`, *The merchant
step*). The **hostname is the find key** for every writer: the seeded map in
088 names the hosts the curated merchants own (Anchor's two paths share one
merchant; the demo store and Ampersend each span a dev and a prod host), the
Bazaar discovery cron and the ingestion lifecycle both call
`findOrCreateMerchantByHost`, and a host nobody owns becomes a merchant named
after itself. A merchant is therefore whoever answers on a host — a
third-party submission on a curated merchant's host joins that merchant.

The Ampersend Demo API (`/api/fact`, `/api/joke`, `/api/quote` on the Base
Sepolia sandbox host and on the Base host, 0.001 USDC per call) is seeded by
088 as one merchant with six offers, `verified_at NULL`: the catalog probe is
what vouches for them, not the seed.

## What a reader sees, and on which chains

`GET /merchants` lists every live merchant with at least one non-delisted
offer on a chain this deployment lists, or a verified self-submitted offer
(those carry no chain and are never chain-filtered). Real merchants sort
before test merchants. `GET /merchants/{slug}` answers the merchant and its
offers on those chains; a live merchant with nothing to show on them is a 404,
so the grid and the page agree.

Which chains are listed (`modules/catalog/marketplace-scope.ts`):

- `HAVEN_MARKETPLACE_CHAIN_IDS` — the marketplace's own list; **prod sets
  `8453`** and hides testnet merchants outright (prod serves Sepolia deploys,
  so "the served chains" would not have hidden them). **Dev sets
  `84532,8453`** so the outreach demo shows the real mainnet merchants next to
  the Ampersend sandbox, each card carrying its network chips.
- unset → `HAVEN_DEPLOY_CHAIN_IDS`; both unset → every supported chain, so no
  test environment returns zero rows by accident.

This list scopes **dashboard users and credential-less readers only**. An
agent's read (`GET /catalog`, `GET /merchants/{slug}` with an agent key) sees
**its own chain** — that clause stands alone, never in conjunction with the
marketplace list. A Sepolia agent on prod still finds the Sepolia demo store;
a mainnet offer shown on dev is not payable from a Sepolia agent, and the
network chip says so.

Live merchants and their offers are readable **without a credential**, in the
same reduced shape `GET /catalog` gives a credential-less caller (host, no
callable URL, no prices): the marketplace is a discovery surface and must not
require the onboarding it leads to (#2530). Every catalog entry now carries
`merchant { id, slug, name, listing_status, is_test_merchant }` for every
caller, including `haven_discover_tools`.

## Merchant-locked budgets (#3331)

An owner can give an agent a budget that pays **one merchant only**. It is an
ordinary recipient-pinned budget delegation, and its pin is the merchant's
verified payTo on the agent's chain. This section covers the backend slice
and the "Set a budget for this merchant" modal, the frontend slice — see *Screens* below
for the modal's own shape.

- **Where a merchant is paid.** The catalog refresh probe (at backend boot,
  then hourly) already reads each offer's 402 challenge for its price. It now
  also records the challenge's `payTo` (`merchant_catalog.pay_to`,
  lowercased). It records one only when every `accepts[]` option on the
  offer's recorded network names the same well-formed address; options on
  other networks do not count. A merchant's **verified payTo** on a chain is
  derived, never stored: it is the one address all its active, verified x402
  operator offers on that network agree on. Self-submitted offers do not
  count, because they carry no network.
- **`GET /merchants/{slug}`** carries `funding`, one entry per listed chain
  with such an offer:
  `{ network, chain_id, pay_to, pay_to_status, erc7710 }`. The chain scope is
  the same one the offers use, and the field is public like the rest of the
  page, since the merchant's own 402 hands the payTo to every caller.
  - `pay_to_status` is `verified` (`pay_to` set), `conflicting` (two offers
    name different addresses), `unstated` (some offer names none, including
    every offer before its first probe after the migration) or `shared`
    (another merchant's offer on that network names the same address, so a
    pin would pay that merchant too; a degraded or not-yet-verified offer
    counts, since it can recover without anyone re-issuing the budget, and
    only a delisted one does not).
  - `erc7710` is true only when **every** such offer on that recorded network
    advertises the ERC-7710 transfer method. A pinned budget cannot fund an
    EIP-3009 payment, because that leg pays the agent's own wallet first, so
    an EIP-3009 merchant is paid from the open budget, if the agent has one.
- **Issuing one.** `POST /agents/{id}/delegations/build` with `merchant_slug`.
  The server fills the recipient from the merchant's verified payTo on the
  agent's chain and records the merchant on the row. It returns 404 for an
  unknown or non-live merchant. It returns 409 when:
  - there is no verified payTo;
  - not every offer there is ERC-7710;
  - the payTo is one of the agent's own addresses (delegate key, delegate
    account or treasury). A pin to the delegate key would let the EIP-3009
    funding leg spend it on any merchant;
  - a sent `recipient_address` differs from the payTo.

  Signing and activation are the ordinary grant flow.
- **Which budget pays — selection keys on the payment's recipient, no
  fallback.** `selectDelegationForPayment`'s own SQL
  (`SELECT_DELEGATION_FOR_PAYMENT_SQL`, `infra/repositories/delegation-budgets.ts`)
  orders the row pinned to the payee FIRST and picks it whenever it matches —
  there is no second query that falls back to the open budget once the pinned
  one exists. A **direct (ERC-7710) settlement**, and a plain `POST /payments`
  sent straight to the merchant's own address, both select on that recipient:
  while a merchant-locked budget is active, every such payment to that
  merchant in that token draws on it alone, and once it is exhausted those
  payments are refused until the next period, never falling back to the
  agent's open budget even if it has one. A payment to anyone else still uses
  the open budget, if there is one; only payments to the LOCKED merchant are
  affected. Two kinds of payment do not follow this rule:
  - a checkout payment that passes through the **agent's own delegate
    first** — the EIP-3009 funding leg a plain-HTTP x402 checkout takes —
    because the on-chain selection key is the redemption's `to`, which is the
    agent's own address there, never the merchant's;
  - a payment made **under a task budget**, which redeems the budget
    delegation it was carved from at creation (`routes/task-budgets.ts` picks
    the parent with the same pinned-first selection), regardless of any
    merchant-locked row: a task opened for this merchant's address while this
    budget is active is carved from THIS budget; a task opened with no
    recipient, or before this budget existed, is carved from the open budget.

  The fund-merchant modal states the rule and both exceptions once, on its
  review step.
- **One address, one slot.** A merchant-locked budget and a plain budget
  pinned to the same address share one `(agent, token, recipient)` slot —
  and so does a merchant-locked budget pinned to a DIFFERENT merchant's payTo
  that happens to land in the same slot (a shared address, or an address a
  merchant later stops using and another later takes up). A slot holds ONE
  live budget (active and unexpired — the wire's `is_live`, #3922): they
  carry the same on-chain authority, and two live grants
  in one slot would make selection ambiguous. Since #3933 a new budget
  cannot be *granted* into a slot that already holds a live one — build and
  activate refuse it (409 `BUDGET_SLOT_OCCUPIED`), because the activation's
  database sweep alone would leave the old delegation enabled on-chain. The
  only way to replace it is the edit flow, which grants the new budget
  naming every live row of the old one as `replaces` (a re-keyed agent's
  budget is two rows) and then stops each on-chain (open task and
  sub-budgets carved from it end with it). So funding a merchant
  whose payTo already holds a live budget — plain, locked to this merchant,
  or locked to another merchant — opens that budget's edit instead of a new
  grant, and the review step names which kind of budget it is and that the
  old one is stopped — with how many Stop signatures that takes (one per
  row the edit replaces: two for a re-keyed budget, #3971). The edit opened from Fund labels the new budget for
  THIS merchant; the agent page's Edit keeps the row's own label. Only a
  direct API caller can still replace a merchant's budget with a plain
  pinned one, which drops its merchant label. A budget for THIS merchant in a *different*
  token, or one still pinned to a payTo the merchant has since rotated away
  from (`stale`, below), is a *different* slot and survives with no warning.
- **Editing one in place (#3166's REPLACE composition) — only a `current`
  row.** `EditBudgetModal`'s Edit on a merchant-locked row keeps the recipient
  READ-ONLY (shown as "pays `<merchant>` only") and forwards the row's own
  `merchant_slug` on the replacement grant, so the edit cannot silently
  downgrade it to a plain pinned budget by retargeting or clearing the
  recipient — the row keeps its merchant label and stays listed on
  `GET /merchants/{slug}/budgets` and the merchant page after the edit lands.
  This only ever reaches activation for a `current` row: a `stale`,
  `unverified` or `not_erc7710` row's build is refused with a 409 naming the
  reason (the 409s listed under *Issuing one*, above; an unlisted merchant is a
  404, not a 409), so nothing changes and the old budget keeps working exactly
  as before the edit was attempted (round 2 review finding R2-2). The way
  forward is named per status, matching `editMerchantRefusalCopy` exactly: a
  `stale` row's way out is **Stop budget**, then fund the merchant again from its
  page, which derives a fresh recipient; an `unverified` row's is the same
  **Stop budget**, then fund again, but only once the merchant confirms an address —
  there is nothing to fund yet. A `not_erc7710` refusal names no single step:
  the build checks ERC-7710 before it compares addresses, so the same refusal
  also comes back when the merchant has BOTH moved to a new address and lost
  ERC-7710 on an offer. The modal therefore says only what holds in both
  cases — the budget keeps paying only the address it was set up with — and
  points at the merchant page, whose row status (`merchantPinStatus` checks
  the address first) tells "Old address" apart from "Not every offer". An ordinary
  (non-merchant-locked) budget is unaffected: its recipient stays editable
  exactly as before.
- **`GET /merchants/{slug}/budgets`** is dashboard-session only (an agent key
  gets 403). It lists the owner's active, unexpired merchant-locked budgets
  for the merchant on agents that are not revoked, each with:
  - `remaining_atomic`, read from the period enforcer, the same read
    `GET /allowances` makes; `remaining_is_from_chain: false` means that read
    failed and the figure is the full budget;
  - `pin_status`, which is one of:
    - `current`;
    - `stale`: the merchant now names a different payTo. The signed budget
      still pays only the old address, and payments to the new one fall to
      the open budget, if there is one;
    - `unverified`: the merchant names no single payTo there now, including
      a `shared` one;
    - `not_erc7710`: the payTo still matches, but not every offer there
      advertises ERC-7710 any more. A pinned budget pays only through
      ERC-7710, so it cannot pay the offers that dropped it.

  A budget on a chain this deployment no longer lists is still judged against
  that chain's payTo.
- **The agent page.** `GET /agents/{id}/delegations` rows carry
  `merchant_id`, `merchant_slug` and `merchant_name`, so a budget card can
  name its merchant. A deleted merchant leaves the budget pinned and drops
  only the label.

## The per-offer budget answer (#4004)

The merchant page's offers table answers, per offer, **which of the owner's
agents can pay it** — a named, truthful answer (`agentsThatCanPay` in
`packages/frontend/src/lib/marketplace.ts`), not the old cap-only
`withinBudget` check, which compared the price against the CAP of any agent's
allowance and could say yes when no agent could actually pay (it ignored what
is left, which agent, recipient pins and networks).

The answer mirrors how a payment picks its budget
(`SELECT_DELEGATION_FOR_PAYMENT_SQL`) — it is a display mirror, not a second
authority:

1. The agent is active and its account chain is the offer's chain; otherwise
   the agent **cannot** pay (or is unknown, when the chain itself is unknown).
2. For an ERC-7710 offer, the selected budget is the one locked to the
   merchant's verified pay-to **if one exists**, else the open budget; a
   bridge-only offer selects only the open budget. A budget locked to the
   offer's payee always wins over the open one, whatever is left on it.
3. The selected budget must be live, in the offer's token, and its
   **remaining** amount must cover the price. The cap (`allowance_amount`)
   is read only for the period word, never for the comparison.

**Unknown is silent, never "can't pay"** (the #2295 misleading-direction
rule): a `remaining_atomic` of null, a from-chain flag of false on either
budget wire, missing decimals, and an agent that pays from a received
sub-budget (`receivedSubBudgets[].open`, #3988 — a power the helper does not
model) all answer **unknown**, and unknown renders as NO line at all — the
absence is the honest state, not a warning.

The row then says one of:

- "`Atlas` can pay this", or "`Atlas` and 2 other agents can pay this";
- "More than `Atlas` has left this week" — the period word ("today", "this
  week") comes from the selected budget's period. Only a no that is ABOUT the
  offer's token is named this way: "insufficient" (the selected budget's
  remaining is below the price) or "no budget in the token";
- "No agent can pay this yet" — when every agent's answer is a known no,
  whatever the reasons. A wrong-chain or paused agent is never named as
  "more than … has left": its balance was never measured, and the sentence
  would state a fact nobody has;
- nothing, when the remaining answers cannot honestly fill either form —
  a wrong-chain or paused agent beside an unknown one, or all unknown.

**Data.** The helper reads two wires already on the page or the dashboard —
`GET /dashboard/budget-remaining` (per budget: `remaining_atomic`, cached up
to 60 s) and `GET /merchants/{slug}/budgets` (the merchant-locked budgets)
— plus `GET /agents` for the agent's name, status, account chain and the
period word. #4004 added two additive, nullable fields to
`DashboardBudgetRemainingEntry` — `recipient_address` (the pin; null = open)
and `start_date` — so the locked-vs-open and live-vs-dormant distinctions can
be made client-side without widening the byte-frozen `GET /agents`
projection. The future-dated re-key row is still returned by the route (#3802
owner decision stands); the HELPER is what skips a row whose `start_date` is
in the future — the dormant half of a re-key is not spendable.

## The "How to buy" panel (#4005)

Between the header and the offers, a live merchant with at least one offer
renders a one-Card panel (`components/marketplace/HowToBuyPanel.tsx`) —
its title in the house `Card.Header` band, one hairline above step 1
(#4015) — with three steps, each claimed from data the page already loads — `useAgents`,
the two budget wires (#4004) and the funding targets — never asserted.
Coming-soon and no-offer merchants show no panel.

1. **Connect an agent.** Done when the user has at least one ACTIVE agent —
   "Atlas is connected on Base Sepolia"; with several, the count names one.
   Open when there are none: "Connect an agent to buy from <merchant>" with
   a link to `/agents`. A FAILED agents read says "Haven couldn't load your
   agents" and never "Connect an agent" (the same distinction the page's
   funding slot draws). While agents load, the step is a skeleton.
2. **Give it a budget it can spend here.** The merchant-level reduction of
   #4004's per-offer verdicts (`howToBuy` in `lib/marketplace.ts`), so the
   panel and the offers answer from one set of computations:
   - **Done** when an active agent can pay at least one offer — the line
     names the agent and the SELECTED budget's remaining and cap ("Atlas has
     $0.65 left of $1.00 today, and can pay anyone — so it can pay
     <merchant>"), or "can pay only <merchant>" when the paying budget is
     merchant-locked. The step reads the offers on the named agent's own
     chain — the offers table's split (#4015): when the agent cannot pay
     every offer THERE, the line says "for some offers"; offers on another
     network have their own disclosure line and never make it partial. When
     the agent's chain is not the default account's chain, the line names
     the network ("…so it can pay <merchant> on Base"); when agents on
     several chains can pay, one on the default chain is named first. The any-recipient
     requirement (the old offer-level note, moved here in #4005) reads the
     same per-chain set through one predicate (`anyRecipientRule`): in the
     done line it renders only when that set is mixed ("The offers marked
     'any-recipient budget' need a budget that can pay anyone") — an open
     budget's "can pay anyone" already says the rest.
   - **A budget fix** when no agent can pay and a budget-shaped no exists:
     the panel names the first agent with one (one on the default
     account's chain first, as in the done line) and offers "Set a budget for
     this merchant" (the same modal as the header action) ONLY when the
     action is available AND an eligible agent is ACTIVE —
     `eligibleFundingAgents` admits paused and pending agents, the panel
     does not point a paused agent at an action. A merchant-locked budget
     wins over the open one for this payee, so the action is never offered
     while an open budget already covers the offers (that state is "done"
     instead) — and since #4015 the header action follows the same rule
     (see *"Set a budget for this merchant"* below). Otherwise the fix links
     to the agent's page. The fix line keeps the any-recipient sentence in
     both forms, mixed or not. A depleted
     budget names what is left ("not enough for any offer here"); a budget
     locked to another recipient is simply "no budget that can pay
     <merchant>" — true either way.
   - **Wrong network** when every known no is a chain no: the step names the
     agent's chain and the offers' chains and says plainly that Haven can't
     add a second account from here — no fix button.
   - **No claim** when the answers are unknown (remaining unreadable, a
     received sub-budget in play) — "couldn't confirm what your agent can
     spend here just now". A failed budget read (either wire) is a
     retryable "Haven couldn't check budgets — try again".
3. **Ask your agent to buy.** "Copy an offer's prompt below and paste it
   into <agent>'s chat. It pays from its budget and brings back the result.
   The payment shows up in Transactions", linked to `/transactions`. The
   named target is the agent step 2 claimed can pay, else the only active
   agent, else the generic "your agent's" — never a name the data does not
   single out.

The panel is one unpadded `Card` whose three steps sit in one
`Card.Section divided`, each row owning its padding — the shared row-list
pattern, so the dividers meet the card's edges (#4014) — with no nested
filled cards (CLAUDE.md § UI Surface Hierarchy). The copy confirmation on an
offer's "Copy prompt" button becomes "Copied — paste it to <agent>" when
exactly one agent can pay that offer (`CopyButton`'s optional `copiedText`,
shown on `/design-system`), and the longer label wraps rather than widening
the row.

## Prospects

A `coming_soon` merchant is a company Haven is in conversation with — migration
089 (#3080) seeds two: **Berget AI** (`berget.ai`, category `ai`, "Sovereign
Swedish inference — open models on Swedish data centres, OpenAI-compatible
API") and **Redpine** (`redpine.ai`, category `data`, "Grounding API for
licensed, non-public data — API, MCP and CLI"). Neither has a logo — a
monogram only (decision 7). **Opper is not seeded**: it has no CRM record yet
(decision 8); adding it later is one seed row in a migration plus that CRM
record, nothing else.

**These rows are not agreements.** Owner decision 2026-09-17 #9 on epic #3077,
recorded verbatim because neither CRM record covers it on its own: *"a dev-only
'Coming soon' card for Berget AI and Redpine is within each record's
external-mention ceiling — it is shown only in private meetings with that
company, never on prod, never in public copy. Each CRM record gets a line
saying so (owner step in the promotion checklist)."* The copy itself is
guardrail-tested: `modules/catalog/prospect-copy.ts` exports the shared banned
word list (`partner`, `customer`, `integration`, `planned`, `pilot`) and
`089_marketplace_prospects.test.ts` asserts every seed's name and description
is clean of it, read from the migration's own exported `PROSPECT_SEEDS`
constant — not from the database.

A prospect has **zero offers**, enforced twice: `GET /merchants` and
`GET /merchants/{slug}` never attach one (there is nothing to attach — a
`coming_soon` row has none by construction), and the write side refuses on its
own — `findOrCreateMerchantByHost`'s FIND query only matches a `live` merchant,
and `assertMerchantAcceptsOffers` (`infra/repositories/merchants.ts`) throws a
named `ProspectMerchantWriteError` if a caller ever tries to attach an offer to
a `coming_soon` merchant anyway. A cross-table CHECK cannot express "this
merchant has no rows in another table" without a trigger, so this application
assertion is the rule, not a stand-in for one. A third-party submission that
lands on a prospect's host (e.g. someone submits `api.berget.ai`) does **not**
become the prospect: the slug collides and the submission founds `berget-ai-2`
instead, leaving the prospect untouched.

It is listed **only** to an authenticated dashboard user, **only** when
`HAVEN_MARKETPLACE_PROSPECTS=true`, and **only** when
`HAVEN_MARKETPLACE_CHAIN_IDS` itself names a testnet chain — the second line
of defence (decision 14, 2026-09-20): prod's own list is `8453`, so a prod env
with the flag copied over cannot publish them; and a prod list that DID name
`84532` would already be leaking testnet merchants to dashboard users, a
misconfiguration that shows on the grid before it shows a prospect. The
fallback to `HAVEN_DEPLOY_CHAIN_IDS` does not count (prod deploys
`8453,84532`), and neither does "every chain". Until decision 14 the gate was
the inverse — "no mainnet listed" — which made prospects and the mainnet
merchants of decision 11 mutually exclusive on dev; the owner wants both
standing. `GET /merchants/{slug}` answers **404, never 403**, to anyone who
may not see a prospect, so the URL does not confirm the row exists.

### Standing state on dev (decision 14)

Dev's standing env is `HAVEN_MARKETPLACE_PROSPECTS=true` **and**
`HAVEN_MARKETPLACE_CHAIN_IDS=84532,8453` (the list is restored to that value
as the operator step after PR #3202 lands; for the 2026-09-20 demo it was
narrowed to `84532`), so a logged-in dev user sees the mainnet merchants, the
Ampersend sandbox and the "Coming soon" prospects on one grid, all the time;
nothing is flipped before or after a meeting. Two things still hold: agents and
credential-less readers never see a prospect (measured 2026-09-20 on dev at
`84532`, before this rule change — the property, not the count, is what the
route test pins: `haven_discover_tools` from the dev QA agent returned Sepolia
offers only, none `coming_soon`; `GET /merchants/berget-ai` → 404), and prod
never sets the flag — and could not show them if it did, because its list is
`8453`.
Showing the grid to a prospect's own people is still a private meeting, per
each CRM record's external-mention ceiling (decision 9).

### Promotion: prospect → live

A prospect becomes `live` only through this sequence, never implicitly through
a catalog write:

1. The merchant has a **verified payable offer** on its host — the same
   verification any third-party submission goes through
   (`docs/operations/catalog-ingestion.md`), or an operator-added row the
   catalog probe has confirmed live.
2. The **CRM record says `live` first** — update
   `Haven Labs/crm/partners/<slug>.md` (or `accounts/`) before the SQL step, so
   the guardrail on external-mention language is lifted in the one place that
   tracks it before the product surface changes.
3. The operator flips `listing_status` by hand:

   ```sql
   UPDATE merchants SET listing_status = 'live' WHERE slug = 'berget-ai';
   ```

   Record the change (who, when, which offer verified it) on the CRM record.
   From this point the merchant is an ordinary live merchant: public-readable,
   scoped like any other, and `findOrCreateMerchantByHost` will happily attach
   further offers to it.

Migration 089's `down()` refuses loudly, naming the slug, if a seed has already
been promoted this way (still `coming_soon` with zero offers is the only state
it will remove) — a rollback must never silently delete a merchant that has
since become real inventory.

**What the rule does and does not guarantee.** The zero-offers rule is
application-level, twice: the catalog writer never returns a `coming_soon`
merchant for a host, and it refuses to attach an offer to one. It is not a
database invariant — a direct `INSERT INTO merchant_catalog` with a
prospect's `merchant_id` is unguarded (no trigger, no CHECK), and the
migration's `down()` will then refuse by name. And the flip runs one way: a
live merchant with offers flipped back to `coming_soon` by hand is not
"un-promoted" — the next verified submission or discovery row on its host
founds a second merchant (`<slug>-2`) rather than attaching to it. Flip a
merchant back only if it has no offers.

## Submitting an endpoint

`POST /catalog/submit` takes two optional fields besides the resource URL:
`merchant_name` (at most 120 characters) and `merchant_website` (an https
URL). They are used only if no merchant owns the host when the submission is
verified; on a curated merchant's host they are ignored. The `website` field
of that request is the bot honeypot and is unrelated. The submit modal exposes
both as optional inputs (`components/CatalogSubmitModal.tsx`), reachable from
the marketplace grid — a merchant page carries no seller entry point (#3981).

## Screens (#3079)

`/marketplace` replaces `/catalog` (a permanent redirect preserves the query
string, `next.config.ts`); the sidebar label is "Marketplace", same index in
`baseNavItems`, same More-sheet position.

- **Grid** (`components/marketplace/MerchantGrid.tsx`,
  `MerchantCard.tsx`) — one card per merchant on the shared entity-card
  idiom (`entityCardClassName`: hover lift, product focus ring): a monogram
  (`components/ui/Monogram.tsx`, promoted on its third copy — `/contacts`,
  the card, the merchant header) or a logo when `logo_url` is set, name,
  the category as plain `ink-3` text (acronyms kept: API, AI — deliberately
  not a chip, so it stops dressing up like the network chips beside it),
  description clamped to two lines, network chips, and a bottom-pinned footer
  that answers "can I pay this, and what does it cost?" (#3980): live
  merchants show "From <price> USDC" — the lowest USDC price over the counted
  offers, served as the nullable `lowest_price_atomic` on `GET /merchants`
  (atomic units; the card formats it with the backend's two-decimal rule —
  trailing zeros trimmed to at least two decimals, "0.10" and "1.00" but
  "0.001" stays — the ONE price format on the frontend, matching the offer
  row's `price_display`; #4008), with the offer count after it
  when there is more than one offer, and the offer count alone when no
  counted offer prices in USDC — while a coming-soon merchant shows no footer
  at all (nothing there is comparable), renders muted, and carries "Coming
  soon" in the badge slot. The grid sorts payable merchants before
  coming-soon ones, CLIENT-side in `MerchantGrid`'s `visible` memo — the
  endpoint's own order (test merchants last, then by name) is preserved
  within each group and must not change for its other clients. Verified is a
  quiet check after the name (`title` = the meaning, sr-only "Verified" so
  the card link's accessible name stays the merchant's) — the merchant page
  still spells the meaning out in visible text; the Haven test-merchant label
  renders on a test merchant. Filters, in
  two rows (#3979): first a search over name and description (leading icon,
  filling the row, as on Contacts) with the network dropdown beside it, shown
  only when the listed chains are more than one; then category pills
  (`components/ui/FilterPill.tsx`, moved out of `CatalogPanel.tsx`) on the
  left and the "Verified only" and "Show test merchants" checkboxes on the
  right (the row's bottom margin trimmed below `sm`, where the 44px tap
  boxes add their height). The network dropdown starts on the chain of the user's default
  account (`resolveDefaultAccount`) when the listed merchants serve it, else
  "All networks"; it is derived at read time, so it holds once the user and
  the merchants load, and any choice overrides it. A merchant that lists no
  network — coming soon, or every offer self-submitted — stays visible under
  any network filter. "Show test merchants" is the one control for test
  content: the `test-fixture` category gets no pill, and a
  `?category=test-fixture` deep link opens as "All". The pills are built
  from the merchants that pass the NETWORK filter and the "Show test
  merchants" toggle — not the category or search filters (#4008) — so pills
  never vanish while you use them, and a selected category that has no pill
  under the current network filter resets to "All", derived at read time: a
  deep link such as `?category=media` under the Base Sepolia default opens
  as "All", the same no-filter-without-a-pill rule. The checkbox defaults
  **on** when any of the merchants' listed networks is a testnet (core's
  faucet field, `isTestnetChain`, not a hard-coded id), read off the served
  data rather than `NEXT_PUBLIC_HAVEN_ENV` (epic decision 10). Any other
  `/catalog?category=…` deep link keeps its category — unless the current
  network filter leaves it no pill, in which case it opens as "All" (#4008).
  A failed load offers
  "Try again"; a filter that hides everything offers "Clear filters" (which
  returns the network to "All networks"); an empty marketplace shows no
  filter row, only the submit entry point. Below a populated grid, a note for
  sellers ("Sell an API or MCP tool?") opens the submit modal — listing a
  service is not a toolbar action.
- **Merchant page** (`app/(authenticated)/marketplace/[slug]/page.tsx`,
  `MerchantHeader.tsx`, `OffersTable.tsx`) — header (monogram/logo, name,
  category, website link, networks, the Verified marker as the quiet check
  plus the word "Verified" in sentence case — the ONE treatment, shared with
  the grid card (#4008) — with its meaning as VISIBLE text
  under the description — never only a tooltip — the Haven test-merchant note
  as a wrapping line on a test merchant, where a payment is one paste away,
  and "Set a budget for this merchant" in the header's actions slot when the
  action shows — its helper capped at `16rem`; below the text until `xl`
  (1280px), beside it from there, so the merchant's own text keeps the
  width (#4015, `merchant-page-fit-measure.spec.ts`)), and ONE offers section (#3981): each offer is a single row —
  a table from `md` up, one stacked card below — carrying name, description,
  price with the `withinBudget()` per-agent hint (so the warning is never
  behind a horizontal scroll on a phone), the network's chain name and a
  labelled **Copy prompt** button (#3998, #4003 wording) that copies the full
  paste-into-agent instruction (`agentInstruction()`, byte-stable in
  `lib/marketplace.ts`). The instruction is not printed under every offer:
  the row carries a quiet line under the description — the resource URL
  without its scheme, truncated with the full URL as its title, then the
  freshness — and prints the instruction (monospace, wrapping, never
  truncated) only where the user must see it: when it carries a placeholder
  to replace (`instructionNeedsEdit`: an MCP offer with a tool, "… for
  <what you want>", with a "Replace <what you want> before sending" hint),
  or after the clipboard refused a copy, when it is revealed in place. The
  button's accessible name keeps its visible words ("Copy prompt for
  <offer>"). There is no Method column (the MCP tool name survives inside the
  printed instruction) and no per-row Verified badge — the trust claim lives
  once, in the header. Offers on the
  user's own network (the chain of the default account,
  `resolveDefaultAccount`) come first; offers on other networks sit behind an
  "n more on <chain names>" disclosure (#4003 — with "— none of your agents
  can pay on that network" when no active agent's account chain is among the
  hidden chains). The nested table inside the disclosure shares the outer
  table's fixed column layout — one `table-layout: fixed` and one `colgroup`
  for both, and no extra horizontal padding on the disclosure's cell — so
  their columns line up to the pixel (#4008); the rows stay in the DOM while
  the disclosure is collapsed, and the phone `OfferCard` disclosure is
  unchanged. Every offer renders flat when the
  user's default network serves none of the merchant's offers. (#4005: the
  offer-level any-recipient NOTE is gone from the table — the "How to buy"
  panel's step 2 states that requirement in plain words, next to the state
  that makes it matter; the per-offer TAG stays in a mixed merchant. The copy
  confirmation names the ONE agent that can pay — "Copied — paste it to
  <agent>" via `CopyButton`'s `copiedText` — and stays "Copied" when the
  answer is none, unknown or more than one.) No "EIP-3009" and no
  "unpinned" reaches the page, and where one network's offers are mixed
  the offers there that need it carry an "any-recipient budget" tag —
  decided per chain through the panel's own `anyRecipientRule` (#4015), so
  step 2 never points at a tag on another network.
  A `coming_soon` merchant renders its description, website and
  "Coming soon — not payable yet" — no offers section, no price. Loading,
  empty, error (with "Try again") and unknown-slug (404 via
  `next/navigation`'s `notFound()`, landing on the segment's own
  `not-found.tsx` with "Back to Marketplace") states are covered by unit
  tests, not baselines — except the unknown slug, whose `notFound()` →
  `not-found.tsx` join is a visual-spec scenario (`merchant-not-found`).
  The visual spec freezes the clock (`page.clock.setFixedTime`) and asserts
  the literal "verified 2d ago", because the Freshness cell is
  `Date.now()`-relative and the fixtures carry fixed `verified_at` values.
- `CatalogPanel.tsx` and `app/(authenticated)/catalog/page.tsx` are deleted;
  `CatalogCard` is now `components/marketplace/OfferRow.tsx`;
  `hooks/useCatalog.ts` gains `useMerchants()` / `useMerchant(slug)`, and
  `useMerchant`'s response now also carries `funding` (#3331).
- **"Set a budget for this merchant"** (`components/marketplace/FundMerchantModal.tsx`,
  #3331) — the action shows on the merchant page ONLY when ALL of these hold:
  the merchant is live, AT LEAST ONE listed chain's `funding` entry is
  `verified` and `erc7710`, AND the owner has at least one ELIGIBLE agent for
  one of those chains (`eligibleFundingAgents`) — a qualifying chain with no
  eligible agent hides the action too, rather than opening a modal that can
  only ever say "no eligible agent". In the header it is also withheld when
  an active agent's OPEN budget already pays every offer on the user's
  network (`openBudgetCoversOffers` over `offersOnUserNetwork`, the same
  per-offer verdicts step 2 reads; only once both budget wires answered) —
  owner decision (a), 2026-10-16, #4015: "No need to push for merchant
  specific budgets here." A merchant-locked budget does not count, so the
  action stays beside one; it may reappear as the open budget drains. The
  modal is unchanged. The action's old funding-level
  "open-budget note" is gone since #3981: the offers section's own
  plain-language payment note (above) is offer-level and covers it — when no
  offer is `erc7710` the note shows and the action is withheld. The modal: pick
  one of the eligible agents, an amount in whichever token the merchant
  actually sells in on that chain (`merchantTokenOptions`, restricted to its
  ERC-7710 offers) and a period, a review step naming the agent, the budget
  (the SIGNED atomic amount, not the typed string), and the merchant's payTo
  (shortened, never editable in the UI — but SENT as `recipientAddress`
  alongside `merchant_slug`, so the server's own comparison catches a payTo
  that rotated between page load and Sign as a 409 rather than resolving
  silently), then ONE signature through `useDelegationBudget`'s own `grant()`
  — the same build → sign → activate composition the agent page's budget form
  uses, extended with `merchant_slug` rather than forked. The review step
  states which payments this budget pays and which still use the open budget
  (see "Which budget pays" above) and, if a LIVE (active and unexpired, #3922) row already occupies the same
  `(agent, token, recipient)` slot — plain, locked to this merchant, or locked
  to a DIFFERENT merchant — warns that signing replaces it, naming whichever
  one it is; a budget for this merchant in another token, or one pinned to a
  payTo the merchant has rotated away from, is a different slot and survives
  with no warning. `grant()`'s build-step refusals — the four merchant-locked
  409s AND the ordinary grant refusals any caller can hit (revoked agent, off
  the delegation rail, chain not enabled, re-key in flight) — each surface
  their own plain sentence; anything else falls to one generic sentence
  ("Haven could not set up this budget."), always followed by "Nothing
  changed." Copy never says "delegation", "recipient pin" or "ERC-7710" —
  outcome language only, per `EditBudgetModal.tsx`'s established shape
  (asserted directly against the error-state copy, not only the happy path).
- **Merchant-locked budgets on the merchant page**
  (`components/marketplace/MerchantBudgetsList.tsx`, reading
  `useMerchantBudgets` → `GET /merchants/{slug}/budgets`) — one row per
  BUDGET (an agent with more than one merchant-locked budget for this
  merchant — different tokens, or one `stale` and a newer replacement — gets
  one row each, not one row per agent): remaining vs. total this period, the
  agent name linking to its page, and `pin_status` as a plain label with one
  outcome sentence each — `current` shows the "Current" badge with no
  further explanation, `stale` ("Old address"), `unverified` ("Address
  unconfirmed" — it still pays the pinned address on-chain; Haven just cannot
  confirm it is still the merchant's), `not_erc7710` ("Not every offer" — offers that no longer accept this kind of budget are paid from the open budget, if any; any that still accept it keep using this one; this holds whether some or all offers dropped it) — plus
  the #1319 provenance note when `remaining_is_from_chain` is false. An
  unknown token shows the raw atomic amounts labelled "unknown token" rather
  than guessing 18 decimals. Renders nothing when the merchant has none — the
  same "nothing yet" absence `DelegationBudgetCard` uses for a fresh agent,
  not an empty section; a failed read is a retryable one-line error instead
  (`page.tsx`).
- **The agent page's budget card** (`components/DelegationBudgetCard.tsx`)
  names a merchant-locked budget's merchant ("pays `<merchant>` only") instead
  of its raw recipient address, reading the `merchant_name` `GET
  /agents/{id}/delegations` now carries (#3331). A budget whose merchant was
  since deleted falls back to the address. A re-key carries the merchant
  label to every replacement piece (carry, steady, reanchor, #3386), so an
  ordinary re-key does not fall back here.
