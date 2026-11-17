---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/modules/transactions/counterparty-name.ts
  - packages/backend/src/modules/transactions/recipient-name-index.ts
  - packages/backend/src/infra/repositories/merchants.ts
last-verified: "2026-11-17"
---

# How Haven names who you paid

Wherever Haven shows the other side of a payment, it names it in **one
order** (#4882, epic #4879). Every surface uses the same order:

- the dashboard's activity feed, top merchant, the agent cards' last payment
  and the first-payment card;
- the transactions list, its search and its CSV export;
- analytics' merchants table;
- an agent's Activity tab and its CSV export.

## The order

The first source that has a name wins:

1. **One of your own accounts.** The account on the payment's network first,
   else the oldest of your accounts at that address.
2. **Your contact.** The name you saved for the address in your address book.
3. **The Haven catalog's merchant.** Used when the address is the receiving
   address of exactly one Haven-curated merchant in the catalog, on that
   network. An address that two merchants advertise names neither. A
   merchant whose payment challenge recorded no address matches nothing.
   Seller-listed catalog entries never name a payment.
4. **The seller name on the merchant's receipt.** The receipt's top-level
   `saljare.name`, else its flat `merchant_name`. A receipt cannot borrow a
   catalog merchant's name: if the seller name equals a catalog merchant's
   name (ignoring case and spacing) and the payment did not go to one of that
   merchant's addresses, the receipt name is not used.
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

The address columns are unchanged.

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

## For developers

The order lives in `modules/transactions/counterparty-name.ts`; every
consumer calls it, and the module owns the lookup key (`recipientAddressOf`).
Transaction rows carry the result as optional fields: `recipientName` and
`recipientNameSource` on `GET /transactions`, `counterparty_name` and
`counterparty_name_source` on the agent ledger's kinded reads. The analytics
`kind` gains the value `catalog`.
