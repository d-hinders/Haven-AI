---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/db/migrations/088_merchants.ts
  - packages/backend/src/db/migrations/089_marketplace_prospects.ts
  - packages/backend/src/db/migrations/096_merchant_pay_to.ts
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
  - packages/frontend/src/components/marketplace/PayWithHavenBlock.tsx
  - packages/frontend/src/lib/marketplace.ts
  - packages/frontend/src/hooks/useCatalog.ts
  - packages/frontend/src/components/CatalogSubmitModal.tsx
last-verified: "2026-09-20"
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
  client uses; the older `category: 'test-fixture'` stays as data.

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
verified payTo on the agent's chain. This section covers the backend slice;
the "Fund this merchant" modal on the merchant page is the frontend slice.

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
  - `erc7710` is true only when **every** such offer advertises the ERC-7710
    transfer method. A pinned budget cannot fund an EIP-3009 payment, because
    that leg pays the agent's own wallet first, so an EIP-3009 merchant is paid
    from the open budget, if the agent has one.
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
- **Which budget pays.** Nothing limits an agent to one active delegation.
  The merchant-locked budget sits beside the open one, and the existing
  payment selection already prefers a budget pinned to the payee. A payment
  to the merchant uses the merchant-locked budget, and a payment to anyone
  else uses the open one, if there is one.
- **One address, one slot.** A merchant-locked budget and a plain budget
  pinned to the same address share one `(agent, token, recipient)` slot.
  Activating either replaces the other: they carry the same on-chain
  authority, and two live grants in one slot would make selection ambiguous.
  Activating a plain pinned budget to a merchant's payTo therefore replaces that
  merchant's budget, and drops its merchant label. The fund-merchant modal
  (the frontend slice, not shipped yet) is to warn about this before the
  owner signs.
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
- **Known gap: a re-key drops the label.** The replacement grant a re-key
  issues keeps the recipient pin but not the merchant. After a re-key, the
  budget still pays only the merchant, but it no longer appears in
  `GET /merchants/{slug}/budgets` or carries the merchant's name. Tracked in
  #3386.

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
the marketplace grid and from a merchant page.

## Screens (#3079)

`/marketplace` replaces `/catalog` (a permanent redirect preserves the query
string, `next.config.ts`); the sidebar label is "Marketplace", same index in
`baseNavItems`, same More-sheet position.

- **Grid** (`components/marketplace/MerchantGrid.tsx`,
  `MerchantCard.tsx`) — one card per merchant on the shared entity-card
  idiom (`entityCardClassName`: hover lift, product focus ring): a monogram
  (`components/ui/Monogram.tsx`, promoted on its third copy — `/contacts`,
  the card, the merchant header) or a logo when `logo_url` is set, name,
  category chip (acronyms kept: API, AI), description clamped to two lines,
  network chips, and a bottom-pinned footer with the offer count or "Coming
  soon", plus the Haven test-merchant label on a test merchant. Filters:
  category pills (`components/ui/FilterPill.tsx`, moved out of
  `CatalogPanel.tsx`), a network dropdown shown only when the listed chains
  are more than one, search over name and description, "Verified only", and
  "Show test merchants" — defaulted **on** when any of the merchants' listed
  networks is a testnet (core's faucet field, `isTestnetChain`, not a
  hard-coded id), read off the served data rather than
  `NEXT_PUBLIC_HAVEN_ENV` (epic decision 10). A `/catalog?category=…` deep
  link keeps its category. A failed load offers "Try again"; a filter that
  hides everything offers "Clear filters"; an empty marketplace shows no
  filter row, only the submit entry point.
- **Merchant page** (`app/(authenticated)/marketplace/[slug]/page.tsx`,
  `MerchantHeader.tsx`, `PayWithHavenBlock.tsx`, `OffersTable.tsx`) — header
  (monogram/logo, name, category, website link, networks, Verified with its
  meaning as VISIBLE text under the description — never only a tooltip — and
  the Haven test-merchant note as a wrapping line on a test merchant, where a
  payment is one paste away), a "Pay this with Haven"
  block with one paste-into-agent instruction per offer, each labelled with
  the offer's name and price and printed in full (`agentInstruction()`, moved
  to `lib/marketplace.ts`) with a copy button, the line "This merchant
  settles by EIP-3009 — the paying agent needs an unpinned budget" **once**
  when any offer's `asset_transfer_methods` lacks `erc7710` (the offers that
  need it are tagged when the merchant is mixed), and the offers: a table from
  `md` up (Offer · Method · Description · Price · Network · Freshness — the
  network cell names the chain) and one stacked card per offer below `md`,
  both reusing `withinBudget()` for the per-agent budget hint so the warning
  is never behind a horizontal scroll on a phone. A `coming_soon` merchant renders its description, website and
  "Coming soon — not payable yet" — no instruction block, no offers table, no
  price. Loading, empty, error (with "Try again") and unknown-slug (404 via
  `next/navigation`'s `notFound()`, landing on the segment's own
  `not-found.tsx` with "Back to Marketplace") states are covered by unit
  tests, not baselines — except the unknown slug, whose `notFound()` →
  `not-found.tsx` join is a visual-spec scenario (`merchant-not-found`).
  The visual spec freezes the clock (`page.clock.setFixedTime`) and asserts
  the literal "verified 2d ago", because the Freshness cell is
  `Date.now()`-relative and the fixtures carry fixed `verified_at` values.
- `CatalogPanel.tsx` and `app/(authenticated)/catalog/page.tsx` are deleted;
  `CatalogCard` is now `components/marketplace/OfferRow.tsx`;
  `hooks/useCatalog.ts` gains `useMerchants()` / `useMerchant(slug)`.
