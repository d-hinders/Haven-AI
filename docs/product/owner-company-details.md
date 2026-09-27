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
  - packages/backend/src/modules/payments/receipt.ts
  - packages/backend/src/modules/mpp/evidence.ts
  - packages/sdk/src/payment-mappers.ts
last-verified: "2026-09-27"
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
| `country` | Two uppercase letters (ISO 3166-1 alpha-2 SHAPE — `^[A-Z]{2}$` — not checked against the actual ISO 3166-1 list; a well-formed but non-existent code is accepted). |
| `org_number` | For a company, its registration number. **For a sole trader, this IS the personal identity number** — see *Purpose, retention and GDPR basis* below. |
| `vat_number` | Optional. Normalised on write: uppercase, no spaces (`SE556677889901`, not `se 556677889901`). Its own 2-letter prefix may legitimately differ from `country` (an EU group can register for VAT in a member state that is not its seat of incorporation) — VIES is always asked using the VAT NUMBER's own prefix, never `country` (Greece is the one case: a `GR…` prefix asks VIES as `EL`; see below). A prefix that is not itself a VIES member country code is still accepted and stored, but starts no VIES call at all — see *The VIES states* below. |
| `vies_status` | `null` (no VAT number submitted), `pending`, `valid`, `invalid`, or `not_verifiable`. |
| `vies_checked_at` | When the last VIES check COMPLETED — never set while `vies_status` is `pending` (a check in flight has no completion time yet), and cleared to `null` whenever the VAT number itself is cleared, alongside `vies_status`. |

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
  check", never "we checked and it failed". The same status covers a VAT
  number whose own prefix is not a VIES member country code (EU member states,
  Greece as `EL`, and Northern Ireland's `XI`) — VIES itself has no way to
  confirm it, so no VIES call is made at all. The outcome is recorded by the
  same background check runner (the `PUT` response still shows `pending`
  until it lands, usually at once), and `vies_checked_at` then records when
  Haven recorded that outcome rather than a VIES answer (captain's decision,
  #3332 review m1). A `GR…` prefix is not in this group: it is asked as `EL`.

A row can never get stuck `pending` forever: `GET /user/company-details`
re-triggers a check for its own row if it has been `pending` for more than a
few minutes — a crash or a killed process between the write and the check
completing, or a genuine database failure while recording the result, are the
only ways that happens — and `POST /user/company-details/vies-check` re-runs
it on demand. The re-trigger is an atomic CLAIM (an `UPDATE ... RETURNING`
guarded on `vies_status = 'pending'` and staleness), not a plain read, so two
concurrent `GET`s never both start a check for the same row.

**Naming discipline:** wherever this reaches a person — the API's own
responses today, and the settings screen once the #3332 frontend slice ships
— the copy must say "VAT number checked against VIES on `<date>`", never
"verified". `docs/product/agent-passport.md` reserves that word for a
passport tier that does not exist yet, and the reasoning is identical here:
`vies_status: valid` is a checked fact, not an identity claim.

## The API

There is no settings UI for this yet — that is the #3332 FRONTEND slice, not
built as of this writing. Everything below describes the API, which is live
today behind the flag. `GET`/`PUT`/`POST .../vies-check` answer `404` when the
flag is off, not just the future settings screen; `DELETE` is the one
exception (see its row below).

| Route | Notes |
|---|---|
| `GET /user/company-details` | 404 when the flag is off, and only then. 200 with `null` if nothing is saved. Re-triggers a stale `pending` check (an atomic claim) as a side effect. |
| `PUT /user/company-details` | 404 when the flag is off. Full replacement. Setting/changing `vat_number` starts a VIES check; clearing it clears both `vies_status` and `vies_checked_at`. Rate-limited per session credential (a count shared with the credential's other rate-limited routes). |
| `DELETE /user/company-details` | **Works regardless of the flag** — the owner's erasure path always works, even after an operator turns the feature back off (owner-privacy default). `{ ok: true }` whether or not a row existed. |
| `POST /user/company-details/vies-check` | 404 when the flag is off. Re-runs the check for the saved VAT number; 404 if there is none. Rate-limited per session credential (a count shared with the credential's other rate-limited routes). |

An agent API key is refused with a named `403` on every route above,
including `DELETE` — this is an owner-only surface (an API today; a dashboard
settings screen once the frontend slice ships), and an agent must never
manage — or erase — its own owner's company details.

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
are unaffected. Receipts join the owner's CURRENT details live, at read time —
they are not a point-in-time snapshot taken when the payment settled — so
editing or deleting details changes what past receipts show going forward
(the erasure-friendly side of that: `DELETE /user/company-details` really
does remove the owner's data from every future read of every past receipt,
not just new ones; a receipt states current details, never those the payment
had at settlement time).

The SDK mirrors this through its MAPPED, camelCase surfaces —
`HavenClient.listReceipts()`/`listReceiptsPage()` produce `PaymentParties.buyer`
(camelCase fields) via `payment-mappers.ts`'s `mapParties`, additive the same
way. `HavenClient.getReceipt()` is a narrower exception worth naming
precisely: it passes the backend's JSON bundle through un-remapped, so
`payment.parties.buyer` there is the RAW, snake_case shape on the wire at
runtime on any SDK version (its own published type,
`PaymentReceipt['payment'].parties: RawPaymentParties`, already says so — this
is not a type/runtime mismatch, just a different surface than the mapped one).

This block is **not** part of the receipt's signed payload —
`verifyPaymentReceipt` reads only `receipt.authorization`, so a merchant that
verifies a receipt is verifying the transfer, not the buyer's company details.
A merchant only ever sees `parties.buyer` on a receipt the agent chose to hand
over; `GET /payments/:id/receipt` and the receipts list are agent-scoped, so
nothing else can read it through Haven's API.

### Where it does not surface (yet)

`parties.buyer` is additive on `GET /payments/:id/receipt` and the receipts
list (`GET /machine-payments/receipts`, `haven_list_receipts`) only. Two other
payment-status surfaces do NOT carry it, deliberately out of scope for #3332:
`GET /machine-payments/:id/status` (`modules/payments/agent-payment-status.ts`,
`haven_get_payment_status`) and the `POST /machine-payments/evidence` 202
echo — both report payment/settlement state, not the buyer's company
details, and adding it there is a separate, unreviewed change. The OpenAPI
`Parties.buyer` field description is scoped to the receipt surfaces for the
same reason.

## Purpose, retention and GDPR basis

This is the owner's own data, about themself, saved voluntarily to appear on
receipts their own agents may hand to merchants. For a sole trader, the
organisation number *is* the personal identity number — this document, and
the future settings form (the #3332 frontend slice), state this plainly,
alongside the VAT number's own SE-format personal-number encoding (`SE` +
personal number + `01`) for the same reason.

- **Basis**: consent — the owner opts in by calling `PUT
  /user/company-details` (today) or filling in the future settings form;
  nothing here is required for an agent or a payment to work.
- **Purpose**: stating the buyer on a payment receipt the owner's own agent may
  give to a merchant, and (asynchronously) validating the VAT number against
  VIES.
- **Retention**: kept until the owner deletes it. `DELETE
  /user/company-details` is the owner's actual erasure path today, and it
  works regardless of the feature flag. Deleting the Haven account WOULD also
  remove these details (`user_id` is `ON DELETE CASCADE`), but account
  deletion is an operator action today — there is no self-serve
  delete-my-account route — so that cascade is not itself something an owner
  can currently trigger. Two other tables reference `users(id)` with no `ON
  DELETE` action at all (`payment_intents.user_id`,
  `agent_rekeys.initiated_by_user_id`); a future self-serve account-deletion
  flow will need to delete rows in those (and this) table explicitly rather
  than relying on cascades alone.

## Env var

`HAVEN_OWNER_COMPANY_DETAILS` — strict boolean (`parseBooleanFlag`), dark by
default. See [`docs/operations/dev-environment.md`](../operations/dev-environment.md#configuration).
