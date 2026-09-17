---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/db/migrations/088_merchants.ts
  - packages/backend/src/infra/repositories/merchants.ts
  - packages/backend/src/modules/catalog/marketplace-scope.ts
  - packages/backend/src/routes/merchants.ts
  - packages/backend/src/routes/catalog.ts
  - packages/backend/src/config.ts
last-verified: "2026-09-17"
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

## Prospects

A `coming_soon` merchant is a company Haven is in conversation with (#3080
seeds Berget AI and Redpine). It is not an agreement and the copy never says
partner, customer, integration, planned or pilot. It has no offers and is
never payable; it never appears in `GET /catalog`, in any agent read or in
the credential-less shape.

It is listed **only** to an authenticated dashboard user, **only** when
`HAVEN_MARKETPLACE_PROSPECTS=true`, and **only** when the marketplace lists no
mainnet chain — the second line of defence: a prod env copied from dev with
the flag left on cannot publish them, because prod lists `8453`.
`GET /merchants/{slug}` answers **404, never 403**, to anyone who may not see
a prospect, so the URL does not confirm the row exists. Owner decision 9 on
the epic is the authority for showing the card at all: a dev-only card in a
private meeting is within each CRM record's external-mention ceiling.

## Submitting an endpoint

`POST /catalog/submit` takes two optional fields besides the resource URL:
`merchant_name` (at most 120 characters) and `merchant_website` (an https
URL). They are used only if no merchant owns the host when the submission is
verified; on a curated merchant's host they are ignored. The `website` field
of that request is the bot honeypot and is unrelated.
