---
owner: "@AntonioSaaranen"
status: current
covers:
  - packages/backend/src/modules/accounting/registry.ts
  - packages/backend/src/modules/accounting/connections.ts
  - packages/backend/src/modules/accounting/oauth-flow.ts
  - packages/backend/src/modules/accounting/company-info.ts
  - packages/backend/src/modules/accounting/feed-orchestrator.ts
  - packages/backend/src/modules/accounting/fortnox.ts
  - packages/backend/src/modules/accounting/fortnox-connector.ts
  - packages/backend/src/modules/accounting/retry-sweep.ts
  - packages/backend/src/modules/accounting/provider.ts
  - packages/backend/src/infra/repositories/accounting-feed-syncs.ts
  - packages/backend/src/routes/accounting-connections.ts
  - packages/backend/src/routes/accounting-feed.ts
  - packages/frontend/src/app/(authenticated)/accounting/page.tsx
  - packages/frontend/src/hooks/useAccounting.ts
  - packages/frontend/src/hooks/useAccountingFeed.ts
last-verified: "2026-09-12"
---

# Accounting connections

Connect the accounting platform your company uses, and each agent payment that
settles appears there with its payment evidence attached. Your accountant books
it. That is the whole feature: Haven delivers the payment and the evidence as
an **unbooked** object; it never chooses an account, never asserts VAT and
never books anything. What the platform calls the object differs — in Fortnox
it is an unattested supplier invoice with the evidence as attachments — but the
line is the same for every provider (epic #2858; the invariants are from #491).

This page is the product's own description. How it is operated — configuration,
the retry sweep, what on-call reads when something is stuck — is in
[`docs/operations/accounting-feed.md`](../operations/accounting-feed.md).

## Where it lives

- **Settings → Accounting** is where a connection is made, changed and removed
  (owner decision 2026-09-11; the card ships in #2868). One row per provider:
  Fortnox, and the platforms listed as *Coming soon* below.
- **`/accounting`** is the feed page (#2869): a one-line summary of the
  connection at the top — which platform, which company, when the last
  payment was delivered, or what needs your attention with a *Fix in
  Settings* action — then every payment the feed has handled, its state,
  **Sync now**, and *Check in Fortnox* for a delivered one. Nothing connects
  or disconnects here; that is Settings. The sidebar's *Accounting* entry
  carries a small dot when the connection needs a reconnect or a payment has
  given up retrying — it says "look", the page says what.
- **Transactions** shows a small badge on each fed payment — *In Fortnox*,
  *Feeding…*, *Not fed* — and links to `/accounting` (#2870).

The feature is **dev-only for now**. Every account on the dev deployment is
entitled; production shows the feature as *Coming soon* (#2869): the
`/accounting` page says what the feed will do and which platforms are lined
up, ending with "Nothing can be connected yet."; the sidebar entry carries a
muted *Soon* pill; the Settings card lists every platform as *Coming soon*
with no action. A self-hosted Haven shows *Not available on self-hosted*
instead (the feed is part of the hosted service) and no sidebar entry.
Exposing the feed in production is a separate, explicit decision (#2876).
Agents and MCP get nothing new from any of this: the feed reads settled
payments, it does not take part in making them.

## Connecting Fortnox

1. In Settings → Accounting, press **Connect** on the Fortnox row. Haven sends
   you to Fortnox to sign in and approve the integration; Fortnox sends you
   back, and the row reads *Connected to \<your company\>*.
2. Choose what to include (the next section).
3. Done. From now on, settled agent payments appear in Fortnox under *Supplier
   invoices*, unbooked, with Haven's payment evidence document attached — and
   the merchant's own receipt as a second, separately labelled attachment when
   one was captured.

Two things on the Fortnox side decide whether step 1 succeeds:

- **Who can connect.** Fortnox decides which of its users may approve an
  integration for a company. If Fortnox refuses the approval, ask your Fortnox
  administrator to approve it or to grant you the right to.
- **What the integration is allowed to do.** Haven asks Fortnox for exactly the
  permissions the feed needs — bookkeeping, supplier invoices, suppliers,
  archive, inbox, file attachments and *Företagsinformation* (company
  information). The last one is how Haven learns which company the connection
  belongs to and shows *Connected to \<company\>*; a Fortnox app registration
  that does not declare it makes the connection *Needs more access*
  immediately (the states below).

**SEK only, for now.** Haven feeds SEK ledgers. A company whose base currency
is not SEK is refused at connect with *"Haven currently feeds SEK ledgers
only"* and nothing is stored. Most agent payments settle in USDC; the SEK amount
on each fed document is the conversion Haven records at settlement.
Multi-currency ledgers are a follow-on (#2877).

**One company per connection.** If you reconnect and approve a *different*
Fortnox company, Haven keeps the connection, switches it to the new company,
and feeds only payments settled from that moment into it. What was fed to the
previous company stays there; *Check in Fortnox* on those rows reports them as
not found in the new company, which is correct.

## What to include: the backfill choice

Right after a connection that has not fed anything yet, Haven asks:

- **Feed from now** (default) — only payments that settle from this moment on.
  Nothing is sent for the past.
- **Include payments since \<date\>** — settled payments from that date are fed
  too, up to 200 at a time; press **Sync now** on `/accounting` for the rest.
  The date must be in the past, `YYYY-MM-DD`, not before 2020-01-01.

The choice can only ever move the starting point **earlier**. Connecting a
second platform later, or making an existing connection the destination again,
starts from *now* — history is never re-fed into a new platform unless you ask
for it with this choice. Reconnecting a connection that has already fed
something (the *Reconnect* action below) does not ask again: its starting
point stands.

## Settings

Two settings per connection, under **Settings** on a connected row:

| Setting | What it does | What it does not do |
|---|---|---|
| **Suggested account** | A four-digit BAS account (e.g. `6540`) carried on each fed document as a hint — in Fortnox, in the reference field as *suggested account 6540*. | It never books, never sets the account field, and your accountant still chooses. Leave it empty to carry no hint. |
| **Feed settled payments automatically** (on by default) | Off means *manual only*: nothing is fed until you press **Sync now** (or choose a backfill). | Off does not remove anything already fed, and does not stop Sync now. |

One supplier per merchant is fixed, not a setting (owner decision 2026-09-11).

## Connection states, and what fixes each

The Fortnox row in Settings shows one of these. Every state has exactly one
resolving action, and in every state the feed history in Haven is kept.

| State on the row | What happened | What to do |
|---|---|---|
| **Connected** | Payments are being fed. The row names the company and when it last fed. | Nothing. *Settings* and *Disconnect* are available. |
| **Sign-in expired** (`needs_reauthorisation`) | Fortnox stopped honouring Haven's sign-in — the approval expired after long disuse (Fortnox retires an unused approval after 45 days), or the integration was removed inside Fortnox. Payments settled in the meantime are held, not lost. | **Reconnect.** You approve the integration again; settings, the starting point and the history are kept, and the held payments are fed afterwards. |
| **Needs more access** (`scope_missing`) | The approval Fortnox recorded lacks a permission the feed needs. The row names which — for example *file attachments* or *company information*. A payment that was already delivered keeps its document; its attachment may be missing. | **Reconnect.** Fortnox shows the full permission list again; approving it grants what was missing. If the row comes straight back as *Needs more access*, the Fortnox app registration itself lacks that permission — an operator fixes that in the Fortnox developer portal, not you. |
| **Access revoked** (`revoked_at_provider`) | Reserved for a provider that tells Haven about a revocation on its side. Fortnox offers such a notification; Haven does not receive it yet, so today a revocation inside Fortnox surfaces as *Sign-in expired* instead, and nothing sets this state. | **Reconnect**, should it ever show. |
| **Not connected** (`disconnected`, or never connected) | No feed. If you disconnected earlier, what was fed stays in Fortnox and the history stays in Haven. | **Connect.** |

A payment that could not be delivered while the connection was in one of the
three middle states is not retried against a sign-in that will refuse again;
it waits, and is fed once you reconnect. A payment that failed for another
reason is retried automatically for about two hours (eight attempts, spacing
out from one minute to one hour); after that its row on `/accounting` says so,
and **Sync now** sends it again once the cause is fixed.

## Disconnect

**Disconnect** on the row asks you to confirm, then: Haven asks Fortnox to
revoke the integration's access (so a sign-in Haven no longer holds is one
Fortnox no longer honours either), clears the stored credentials, and stops
feeding. What was already fed stays in Fortnox; the feed history stays in Haven
and shows again if you reconnect. You can also remove the integration from
inside Fortnox at any time — Haven then shows *Sign-in expired* the next time
it has to renew its sign-in, which happens on the next payment push or sync
after the current sign-in lapses (a Fortnox sign-in lasts an hour; nothing
renews it in the background, so a quiet connection shows the change only when
the next payment settles or you press **Sync now**).

## The other platforms

Accounted, Light and Igdrasil are listed on the Settings card as *Coming soon*
with a disabled Connect. Listing is a product decision about what the module is
built to hold, not an endorsement of any of them, and none of the three is
connectable today: each gets its own connector when access exists (#2873,
#2874, #2875). Switching between platforms is first-class once a second one is
live — several connections, exactly one place payments go, and the starting
point rule above means the switch never re-feeds history.

## What Haven does not do here

- It does not book, code, choose an account or assert VAT — the accountant
  does, in the platform.
- It does not hold your Fortnox password. The connection is Fortnox's own
  approval, stored encrypted, revocable from either side.
- It does not touch money. The feed reads payments that have already settled;
  a Fortnox outage delays the feed, never a payment.
- It does not email you. The state shows on the row, on `/accounting`, and
  as the sidebar dot (#2869).
