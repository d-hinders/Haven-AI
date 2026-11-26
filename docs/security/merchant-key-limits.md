---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/middleware/merchantAuth.ts
  - packages/backend/src/routes/merchant-keys.ts
  - packages/backend/src/domain/merchant-keys.ts
  - packages/backend/src/db/migrations/127_merchant_keys.ts
last-verified: "2026-11-17"
---

# The Sales key — what a merchant key can and cannot do

A **Sales key** is the credential a merchant's server uses to report sales to
Haven. The owner creates it on the Sales page, sees the secret once, and can
revoke it at any time. This page is the one place the key's limits are written
down for merchants; the merchant kit's README links here.

The key is **receive-only**. It describes payments that already reached the
merchant's Haven account. It cannot cause a payment, and it cannot change what
Haven reads from the chain.

## What the key can do

- Report a sale record for a transaction that Haven has itself read from the
  chain as a USDC transfer into the key's account (the ingest route is #4897).
- Read back what the merchant routes return about that account's sales.

## What the key cannot do

- **Move funds.** It cannot send, sweep, sign, or authorize a transfer.
- **Sign anything.** It is not a signer and holds no key material.
- **Change signers, budgets or agents.** It cannot add or remove a signer, open
  or change a budget, create or re-key an agent, or change the account's
  settings.
- **Read another account.** The key is bound to one merchant account. It cannot
  read another user's account, and it cannot read the same owner's other
  accounts either.
- **Read anything else about the account.** Only what the merchant routes
  return — not balances, transactions, contacts, analytics or the dashboard.
- **Create a sale with no matching on-chain transfer.** Haven accepts a sale
  record only when it has read a transfer with that transaction hash into the
  key's account. A leaked key or a faulty kit can mislabel a real payment; it
  cannot invent revenue.
- **Authenticate anywhere else.** The key is refused at every agent, payment and
  dashboard route. It works only on the merchant routes.

## The accepted residual

Until it is revoked, a leaked key can:

- attach wrong product labels to real payments of that account;
- read back whatever the merchant routes return about that account's sales;
- take the one sale-record slot a transaction carries before the genuine record
  arrives (a transaction carries only one sale record).

The owner's remedy is to **revoke the key first**, then clear the wrong record
(the route is in #4897, the action on the Sales page in #4900). After the record
is cleared, a new record for that transaction is accepted. The payment shows
with no product until one arrives. Revoke first: an unrevoked leaked key could
take the slot again at once.

## Turning merchant services off

While merchant services are turned off for the account, **every** Sales key for
that account is refused, including keys created before the feature was turned
off. Turning the feature back on makes the unrevoked keys work again.

## The secret is shown once

The secret is returned by the create call only. Haven stores a hash and a short
display prefix (`sk_merchant_` plus twelve characters), and no later read can
produce the secret again. If it is lost, revoke the key and create another.

## Revoking

Revoking records who revoked the key and when, and the key is refused on the
next request. Revoking twice changes nothing. A revoked key stays in the list
with its revocation time.

## Last used

The list shows when each key was last used to make an **accepted** request. The
time is updated at most once a minute per key, so a busy kit does not cause a
write per call.

## Where the key lives in the code

- `packages/backend/src/middleware/merchantAuth.ts` — the check that accepts it
  on the merchant routes.
- `packages/backend/src/routes/merchant-keys.ts` — create, list and revoke.
- `packages/backend/src/domain/merchant-keys.ts` — the fixed prefix and the
  refusal codes.
- `packages/backend/src/db/migrations/127_merchant_keys.ts` — the table.
