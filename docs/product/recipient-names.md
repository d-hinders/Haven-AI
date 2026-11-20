---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/transactions/counterparty-name.ts
  - packages/backend/src/modules/transactions/recipient-name-index.ts
  - packages/backend/src/infra/repositories/merchants.ts
  - packages/backend/src/routes/agent-activity.ts
  - packages/backend/src/modules/transactions/csv-export.ts
last-verified: "2026-11-17"
---

# How Haven names who you paid

Haven names the other side of a payment in **one order** (#4882, epic
#4879), computed once on the server:

- **On screen:** analytics' merchants table and each agent's top merchant;
  the dashboard's top merchant, the agent cards' last payment and the
  first-payment card; and, since #4883, the dashboard activity feed, the
  transactions list and its detail drawer, and an agent's Activity tab
  (payments and refused attempts). An outgoing row's title is the server's
  name; the paid API's host or the browser's own lookups stand in only when
  the server named nobody. An incoming row keeps its rule: "From <account>"
  for another of your own accounts, "Sale · <product>" (or "Sale" with no
  recorded product) for a sale into your Sales account by the Sales page's
  rule (#5000), else "Deposit".
- **The analytics kind line** under a name reads "Paid API" for a catalog
  merchant, as for a host-named one.
- **Search and exports:** transactions search matches every name the order
  can find for a row (all of steps 1–4, not only the winner); the
  transactions CSV and the agent ledger CSV name rows in this order.

## The order

The first source that has a name wins:

1. **One of your own accounts.** The account on the payment's network first,
   else the oldest of your accounts at that address.
2. **Your contact.** The name you saved for the address in your address book.
3. **The Haven catalog's merchant.** Used when the address is the receiving
   address of exactly one Haven-curated merchant in the catalog, on that
   network, and that merchant's active, verified paid-API offers there all
   name this one address (none disagrees, none leaves it unstated — the same
   "verified" the merchant-locked budget uses). An address that two merchants
   advertise names neither. Seller-listed catalog entries never name a
   payment. Where a row adds up payments across networks (analytics'
   merchants, the dashboard's top merchant), the catalog names it only when
   every network names the same merchant.
4. **The seller name on the merchant's receipt.** The receipt's top-level
   `saljare.name`, else its flat `merchant_name`. A receipt cannot borrow a
   catalog merchant's name: names are compared after folding case, spacing,
   punctuation, invisible characters and accents away. If the seller name
   matches a Haven-curated merchant's, it is used only at an address a
   curated entry records for that name, so a seller-listed copy of the name
   cannot vouch for itself. If it matches only seller-listed merchants, it is
   used only at their own recorded addresses, so an honest seller keeps its
   receipt name on its own payments. If that check cannot be read, no
   receipt name is used at all.

   A receipt name is also **refused when it names nobody** (#4932), and a
   refused name counts as no name at all — the order falls through to the
   next step, exactly as for an empty one:

   - **an address**, written in full (`0x…`, 40 hex characters, either `0x`
     or `0X`) or in Haven's own short form (`0xA873…DD35`, `0xa873...dd35`,
     `0xA873 … DD35`);
   - **one of Haven's own fallback words** — "New recipient", "Unknown
     recipient", "Deposit", "Sale", "Agent payment", "Machine payment",
     "Moved between your accounts", "None in this range" — matched exactly
     after case folding and whitespace collapsing, or any name starting with
     "From ", "Returned from " or "Sale · ", the frontend's templated
     fallbacks. A seller therefore cannot make a payment read as a sale.

   The rule applies to **receipt names only**. Your contacts and your own
   account names are your own words, so they are never refused. The
   accounting underlag is out of scope too: it quotes the invoice's seller as
   written (see [`merchant-receipt-shape.md`](../operations/merchant-receipt-shape.md)).
5. **The paid API's host**, for example `api.example.com`.
6. **Nothing.** The screen shows its own fallback: "Unknown recipient" or
   "New recipient".

This order replaced two older ones. Analytics used to put the host first
(#4332), and the activity feed used to put your own accounts after contacts
and receipts (#4099).

## What changed in the exports

- **Transactions CSV.** The `counterparty_name` column follows this order. It
  used to hold only a contact name or one of your own account names, and was
  empty otherwise. Since #4882 a payment can be named by a catalog merchant,
  a receipt's seller name or the paid API's host.
- **Agent ledger CSV.** The `counterparty_name` column for payments and
  refusals follows this order too. It used to be host first, then your own
  account, then your contact.

The address columns are unchanged. In the transactions CSV this means a row
can name one party and show another's address: on the funding leg of a
paid-API payment, `counterparty_name` names the merchant (the party the
payment was for) while `counterparty_address` stays the agent's funding
address the money moved to, as before. The agent ledger CSV names and shows
the same address.

## What a catalog or receipt name is, and is not

- **A receipt name is the payee's own claim**, relayed by the agent, and can
  be false. That is why it comes after your accounts, your contacts and the
  catalog, and why it cannot borrow a catalog merchant's name.
- **A catalog name** comes from a curated listing. The catalog records the
  receiving address from the merchant's own payment challenge, so it proves
  the listing, not that the merchant controls the address. A curated merchant
  that advertised someone else's address would name that person's payments.
  This is the risk the owner accepted on 2026-11-17 (#4882), limited to
  Haven-curated entries.
- **The borrowing check compares spelling, not appearance.** A name written
  in another script (a Cyrillic "а" for a Latin "a"), or with no Latin letter
  or digit at all, is not caught by it.

## For developers

The order lives in `modules/transactions/counterparty-name.ts`; every
consumer calls it, and the module owns the lookup key (`recipientAddressOf`).
Transaction rows carry the result as optional fields: `recipientName` and
`recipientNameSource` on `GET /transactions`, `counterparty_name` and
`counterparty_name_source` on the agent ledger's kinded reads. The analytics
`kind` gains the value `catalog`.
