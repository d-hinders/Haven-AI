---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/db/migrations/098_owner_company_details.ts
  - packages/backend/src/infra/repositories/owner-company-details.ts
  - packages/backend/src/modules/owner-profile/service.ts
  - packages/backend/src/modules/owner-profile/vies-client.ts
  - packages/backend/src/routes/owner-company-details.ts
  - packages/backend/src/openapi/party-model.ts
last-verified: "2026-09-26"
---

# Owner company details

**Onboarding data about the owner, not a passport tier.** Behind
`HAVEN_OWNER_COMPANY_DETAILS`, the signed-in owner can save a legal name,
country, organisation number and VAT number, and Haven checks the VAT number
against the EU's VIES service. It is optional, never gates an agent or a
payment, and signup itself stays passkey-only and unchanged.

See [Agent Passport](agent-passport.md) for why this is a deliberately
separate thing from a passport tier.

## Why it exists

An agent can hand its receipt to a merchant. Today that receipt states the
addresses involved (`parties.treasury_account`, `.delegate`, `.merchant`, …)
and nothing about who the owner behind the agent actually is. When the owner
has saved company details, Haven carries them additively onto the same
`parties` block as `parties.buyer` — the buyer's legal name, country,
organisation number, VAT number and VIES status — so the receipt can state the
buyer the way an ordinary invoice would.

## What is stored

One row per owner, keyed on `user_id` (migration `098_owner_company_details`):

| Field | Notes |
|---|---|
| `legal_name` | 1–200 characters. |
| `country` | ISO 3166-1 alpha-2, e.g. `SE`. |
| `org_number` | For a company, its registration number. **For a sole trader, this IS the personal identity number** — see *Purpose, retention and GDPR basis* below. |
| `vat_number` | Optional. Normalised on write: uppercase, no spaces (`SE556677889901`, not `se 556677889901`). |
| `vies_status` | `null` (no VAT number submitted), `pending`, `valid`, `invalid`, or `not_verifiable`. |
| `vies_checked_at` | When `vies_status` last changed. |

There is no organisation entity above the user (migration 080's own recorded
decision) and this is **not** the `agent_organizations` folder tree (migration
094) — that tree files an owner's own agents into folders; this table
describes the owner.

## The VIES states, and why an outage is never "invalid"

Setting or changing the VAT number moves `vies_status` to `pending` and starts
a check against the EU's VIES REST API asynchronously — the API response
returns before the check completes. The check resolves to exactly one of:

- **`valid`** — VIES confirmed the number.
- **`invalid`** — VIES itself said the number is not valid. This is the one
  status that is a statement about the number.
- **`not_verifiable`** — the check could not complete: a timeout, a malformed
  or unrecognised response, VIES or the member state reporting itself
  unavailable, or any other failure. **This is deliberate and load-bearing**: a
  busy VIES endpoint must never be read as "this VAT number is wrong" (owner
  decision recorded on #3332). `not_verifiable` is Haven saying "we could not
  check", never "we checked and it failed".

A row can never get stuck `pending` forever: `GET /user/company-details`
re-triggers a check for its own row if it has been `pending` for more than a
few minutes (a crash or a killed process between the write and the check
completing is the only way that happens), and `POST
/user/company-details/vies-check` re-runs it on demand.

**Naming discipline:** the settings copy says "VAT number checked against
VIES on `<date>`" — never "verified". `docs/product/agent-passport.md` reserves
that word for a passport tier that does not exist yet, and the reasoning is
identical here: `vies_status: valid` is a checked fact, not an identity claim.

## The API

Behind the flag; every route answers `404` when it is off, not just the
settings screen.

| Route | Notes |
|---|---|
| `GET /user/company-details` | 404 if nothing is saved. Re-triggers a stale `pending` check as a side effect. |
| `PUT /user/company-details` | Full replacement. Setting/changing `vat_number` starts a VIES check; clearing it clears `vies_status` too. |
| `DELETE /user/company-details` | `{ ok: true }` whether or not a row existed. |
| `POST /user/company-details/vies-check` | Re-runs the check for the saved VAT number; 404 if there is none. |

An agent API key is refused with a named `403` — this is an owner-only
settings surface, and an agent must never manage its own owner's company
details.

## Where it surfaces: `parties.buyer`

When the flag is on and the paying agent's owner has saved details, Haven adds
an additive `buyer` object to the `parties` block already emitted on
`GET /payments/:id/receipt` and the agent's receipts list (`GET
/machine-payments/receipts`, `haven_list_receipts`):

```json
"parties": {
  "treasury_account": "0x...",
  "delegate": "0x...",
  "delegate_account": "0x...",
  "merchant": "0x...",
  "buyer": {
    "legal_name": "Acme AB",
    "country": "SE",
    "org_number": "556677-8899",
    "vat_number": "SE556677889901",
    "vies_status": "valid",
    "vies_checked_at": "2026-09-20T10:00:00.000Z"
  }
}
```

`buyer` is **absent** (the key is missing, never present-and-null) when the
flag is off or the owner has no saved details — existing readers of `parties`
are unaffected. The SDK mirrors this as `PaymentParties.buyer` (camelCase
fields), additive the same way.

This block is **not** part of the receipt's signed payload —
`verifyPaymentReceipt` reads only `receipt.authorization`, so a merchant that
verifies a receipt is verifying the transfer, not the buyer's company details.
A merchant only ever sees `parties.buyer` on a receipt the agent chose to hand
over; `GET /payments/:id/receipt` and the receipts list are agent-scoped, so
nothing else can read it through Haven's API.

## Purpose, retention and GDPR basis

This is the owner's own data, about themself, saved voluntarily to appear on
receipts their own agents may hand to merchants. For a sole trader, the
organisation number *is* the personal identity number — the form states this
plainly, alongside the VAT number's own SE-format personal-number encoding
(`SE` + personal number + `01`) for the same reason.

- **Basis**: consent — the owner opts in by filling in the form; nothing here
  is required for an agent or a payment to work.
- **Purpose**: stating the buyer on a payment receipt the owner's own agent may
  give to a merchant, and (asynchronously) validating the VAT number against
  VIES.
- **Retention**: kept until the owner deletes it (`DELETE
  /user/company-details`) or deletes their Haven account, whichever comes
  first — the table's `user_id` foreign key is `ON DELETE CASCADE`, so account
  deletion removes these details with it; there is no separate "please also
  forget my company details" step.

## Env var

`HAVEN_OWNER_COMPANY_DETAILS` — strict boolean (`parseBooleanFlag`), dark by
default. See [`docs/operations/dev-environment.md`](../operations/dev-environment.md#configuration).
