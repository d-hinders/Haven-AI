---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/db/migrations/098_owner_company_details.ts
  - packages/backend/src/db/migrations/129_owner_company_details_checkout_fields.ts
  - packages/backend/src/infra/repositories/owner-company-details.ts
  - packages/backend/src/modules/owner-profile/service.ts
  - packages/backend/src/modules/owner-profile/vies-client.ts
  - packages/backend/src/routes/owner-company-details.ts
  - packages/backend/src/openapi/party-model.ts
  - packages/backend/src/modules/payments/receipt.ts
  - packages/backend/src/modules/mpp/evidence.ts
  - packages/sdk/src/payment-mappers.ts
  - packages/frontend/src/hooks/useCompanyDetails.ts
  - packages/frontend/src/components/settings/CompanyDetailsCard.tsx
  - packages/frontend/src/lib/countries.ts
  - packages/frontend/src/components/ui/Select.tsx
  - packages/frontend/src/components/settings/BusinessDataContext.tsx
  - packages/frontend/src/app/(authenticated)/settings/SettingsClient.tsx
  - packages/sdk/src/receipt.ts
  - packages/backend/src/routes/agent-tax-declaration.ts
  - packages/backend/src/modules/agents/tax-declaration.ts
  - packages/backend/src/db/migrations/135_agent_checkout_details_sharing.ts
  - packages/backend/src/routes/agent-checkout-details.ts
  - packages/backend/src/modules/agents/checkout-details.ts
  - packages/frontend/src/components/agent-panel/CheckoutDetailsSharingToggle.tsx
  - packages/sdk/src/client-tax-declaration.ts
  - packages/sdk/src/tax-declaration.ts
  - packages/frontend/src/components/agent-panel/TaxDeclarationToggle.tsx
  - packages/mcp/src/server.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/frontend/src/components/ui/Checkbox.tsx
last-verified: "2026-11-18"
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
| `receipt_email` | Optional (#4870). Where a merchant should send the receipt: one address, at most 254 characters (RFC 5321 §4.5.3.1.3's forward-path limit, less the angle brackets), no display name and no CR or LF. The form SUGGESTS the sign-up email as a prefill only while the owner has no company details saved (#4946: a saved row with no receipt email — cleared, or saved before #4870 — shows the field empty, because the two cannot be told apart); nothing is stored until the owner saves, and the sign-up email is never used as a receipt email anywhere else (owner decision 2026-11-17, #4868). |
| `billing_address` | Optional (#4870). A structured address, stored as one JSONB value in the shape `docs/architecture/13-checkout-details.md` § *The address shape* decides: `line1` (required, ≤70), `line2` (≤70), `line3` (≤70), `city` (required, ≤50), `postCode` (≤16), `subdivision` (≤6, ISO 3166-2) and `country` (required, two uppercase letters). An absent optional member is omitted from the JSON, never stored as `null` or as an empty string. |
| `shipping_address` | Optional (#4870). The same shape as `billing_address`. "Shipping address is the same as billing" is a form convenience only — there is no stored flag; ticking it saves the billing address as the shipping address. |

The three #4870 fields are saved by the same form and the same `PUT` call as
the rest of the row, so an owner with no company row cannot store an email or
an address: `legal_name`, `country` and `org_number` are required, and the
form says so. They are deliberately **not** part of `parties.buyer` (see
*Where it surfaces* below) — this slice stores them and sends nothing to any
merchant.

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
responses, and the Company details card on Settings → Business
(`CompanyDetailsCard`) — the copy must say "checked against VIES" (the
valid badge; with the date beside it), never "verified".
`docs/product/agent-passport.md` reserves that word for a passport tier
that does not exist yet, and the reasoning is identical here:
`vies_status: valid` is a checked fact, not an identity claim.

## The API

Everything below describes the API, which is live today behind the flag.
`GET`/`PUT`/`POST .../vies-check` answer `404` when the flag is off, not
just the settings screen built on top of it; `DELETE` is the one exception
(see its row below).

| Route | Notes |
|---|---|
| `GET /user/company-details` | 404 when the flag is off, and only then. 200 with `null` if nothing is saved. Re-triggers a stale `pending` check (an atomic claim) as a side effect. |
| `PUT /user/company-details` | 404 when the flag is off. Full replacement of the row, with one exception: the three #4870 fields follow **omitted keeps, `null` clears** — a field the request omits keeps its stored value (so a dashboard tab built before #4870 cannot wipe it), and an explicit `null` clears it. Setting/changing `vat_number` starts a VIES check; clearing it clears both `vies_status` and `vies_checked_at`. Rate-limited per owner (a count shared with the owner's other rate-limited routes, from any session; #4955). |
| `DELETE /user/company-details` | **Works regardless of the flag** — the owner's erasure path always works, even after an operator turns the feature back off (owner-privacy default). `{ ok: true }` whether or not a row existed. |
| `POST /user/company-details/vies-check` | 404 when the flag is off. Re-runs the check for the saved VAT number; 404 if there is none. Rate-limited per owner (a count shared with the owner's other rate-limited routes, from any session; #4955). |

An agent API key (a bearer token or `x-api-key` value starting `sk_agent_`)
is refused with a named `403` on `DELETE` always, and on the other three
routes whenever the flag is on. With the flag off those three answer the
flag's `404` first, because `requireFeatureEnabled` runs before
`refuseAgentKey`. This is an owner-only surface (the Company details card on
Settings → Business, on top of the same owner-scoped routes), and an agent
must never manage — or erase — its own owner's company details.

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

The three #4870 fields are **not** in `parties.buyer`: the buyer block keeps
exactly the six fields it had before this slice, and a test pins that key set
exactly (`toEqual`) on the output of `buyerPartyFromJoin`, which both
consumers — payment evidence and the settled-payment receipt — map through,
and a separate test pins the join fragment's selected columns, so the three
fields cannot reach the buyer block through the join fragment (#4946). They are stored for the merchant-facing answer #4871
builds; this slice sends nothing to any merchant. When a merchant does receive
them, a merchant receipt showing the owner's email or address is kept twice:
by the merchant, and by Haven as the owner's own bookkeeping record — stored
immutably in `merchant_receipts` and attached as a PDF in every accounting
connection the owner has (Fortnox, Accounted, Igdrasil), retained under
bokföringslagen 7 kap. 2 § (GDPR Art. 17(3)(b));
`docs/architecture/13-checkout-details.md` § *The receipt flow*.
`DELETE /user/company-details` reaches neither. What the delete removes is the
details row — the one every future Haven read of the owner's details uses.

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
`verifyPaymentReceipt` reads only the bundle's `authorization` and
`onChain.chainId` (the chain id rebuilds the delegation digest; a
`{ receipt, verification }` wrapper is unwrapped one level first), so a
merchant that verifies a receipt is checking the delegate's authorisation signature, not the
buyer's company details. It is not checking Haven's payment facts either: the
signature binds only the hash named by `verifiedOver`, so amount and recipient
stay Haven-asserted and settlement stays an on-chain check.
A merchant only ever sees `parties.buyer` on a receipt the agent chose to hand
over; `GET /payments/:id/receipt` and the receipts list are agent-scoped, so
nothing else can read it through Haven's API.

### Where it does not surface (yet)

`parties.buyer` is additive on `GET /payments/:id/receipt` and the receipts
list (`GET /machine-payments/receipts`, `haven_list_receipts`) only — the same
bundle is now also reachable through MCP as `haven_get_receipt` (#3723),
which returns the endpoint's `{ receipt }` verbatim, `parties.buyer` included.
Two other
payment-status surfaces do NOT carry it, deliberately out of scope for #3332:
`GET /machine-payments/:id/status` (`modules/payments/agent-payment-status.ts`,
`haven_get_payment_status`) and the `POST /machine-payments/evidence` 202
echo — both report payment/settlement state, not the buyer's company
details, and adding it there is a separate, unreviewed change. The OpenAPI
`Parties.buyer` field description is scoped to the receipt surfaces for the
same reason.

### A second reader: the per-agent tax declaration (#3426, #3427)

`parties.buyer` is not the only place these details leave the table. An owner
can opt one agent in to a buyer-side x402 tax declaration with
`PUT /agents/:id/tax-declaration` (owner session only; the toggle on the
agent's Settings tab, `TaxDeclarationToggle`, renders only while the saved VAT
number is VIES `valid`). The route refuses an opt-in with a `409` naming why:
the flag is off, no VAT number is saved, or VIES is not `valid` now.

The agent then reads `GET /agents/:id/tax-declaration` with its own key, for
its own id only: an id that is not the authenticated agent's is refused with a
`403` before any company-details row is read. For its own id the answer is
`200` either way: `{ available: false, reason }`, or a declaration built at read time from the owner's current row —
`jurisdiction` (the saved `country`), `taxId` (the saved VAT number) and a
`validUntil` that is the earlier of 24 hours from the read and 24 hours after
the last VIES check (`resolveTaxDeclaration`). Only the opt-in bit is stored;
the declaration itself is not.

A local SDK client built with the delegate key signs that declaration and
sends it to the merchant as the `X-Tax-Declaration` header on the paid retry
of an EIP-3009 payment (`resolveTaxDeclarationHeader`, attached in
`MerchantCompletion.retryRequest`). Of the installs the connector writes, only
the local MCP server, `@haven_ai/mcp`, carries it, and that is an opt-in
(`--local`); the default install (hosted server plus edge signer) carries none.
A developer's own SDK client built with the delegate key carries it too.
`@haven_ai/mcp` builds its `HavenClient` with the delegate key
(`packages/mcp/src/server.ts`), and its `haven_pay_x402`,
`haven_pay_x402_quote` and `haven_resume_x402_payment` tools reach that retry
through `fetch`, `payX402Quote` and `resumeX402Payment`. An erc7710 payment
never carries one, and neither the hosted server nor the edge signer builds
one. So with an agent opted in, each EIP-3009 paid retry it makes through
such a client carries the country, the VAT number, the taxable-person status
and a signed link to the agent's wallet address to the merchant, whether or
not a receipt is ever handed over. The link is the declaration's
`principalId` (`did:pkh:<network>:<delegate EOA>`) plus its
`principalAttributionHash`, signed with the same delegate key that signs the
payment (`packages/sdk/src/tax-declaration.ts`). The legal name and
organisation number are not in it.

The agent Settings tab's toggle says the same thing in the owner's words
(#4416, reshaped by #4477): the declaration travels only when the agent pays
through a client that holds its own signing key, the default setup sends none,
and the merchant receives the country, the VAT number, the taxable-person
status and the signed link to the agent's wallet address when it accepts the
declaration. The card does not name the payment rail — the owner's copy review
of 2026-09-30 (PR #3490) removed that sentence, and the rail stays stated here
instead.

The row is a `SettingsRow` in the agent Settings tab (#4477). Its one-line
description is always visible and keeps the client condition — "Sends your
VIES-checked VAT number with payments made through a client that holds its own
key." — because the sentence that says the default setup sends none now sits
behind a fold. The long explanation (what the merchant receives, the default
setup sending none, that nothing is submitted to an authority, and that the
owner can switch it off at any time) lives in a closed-by-default **What gets
sent** disclosure in the row's full-width slot. The `Checkbox` sits in the
action slot with a short visible label ("Allow") and the full accessible name
through `aria-label`; it points at the one-line description through
`aria-describedby`, since moving the explanation out of the checkbox's helper
text took it out of the input's accessible description.

The toggle is **disabled** for an agent whose most recent connector setup
reported `hosted_plus_signer` — the default setup, a hosted server with a
separate signer — because that client cannot attach a declaration to a
payment, so an opt-in there would do nothing (#4435). The reason renders in the
row's full-width slot, OUTSIDE the disclosure and never as the checkbox's
helper text: a disabled checkbox is not focusable and its helper text sits
inside the `<label>`, so a reason placed there is never announced. It stays
visible without opening anything because it tells the owner the control they
can see has no effect. Every other value
stays enabled, deliberately: `local_stdio` (the local MCP server holds the
delegate key), `manual` (a developer's own SDK client with a delegate key can
send one, and Haven cannot know), and unknown — no setup row, an `agent_id`
set to NULL by a delete, or a setup that never reported the key. "Cannot tell"
is not "cannot send", and disabling every agent that predates the signal would
be a user-visible regression on deploy. An agent whose bit is already ON stays
interactive even on that setup, so the owner can still switch it off; the PUT
is never gated on OFF. The signal is display-only: `runtime_mcp_mode` on the
agents list read, taken from the sanitized `install_status` of the agent's
latest setup, and nothing in the delegation, budget, enforcement or
client-compat path reads it.

### A third reader: the per-agent checkout-details switch (#4871)

The receipt email and the two addresses are also what a merchant asks for at
checkout. An owner can let ONE agent share them with merchants that ask, with
a per-agent switch that is **off by default** and that only the owner can turn
on (`PUT /agents/:id/checkout-details-sharing`, owner session only; the toggle
on the agent's Settings tab, `CheckoutDetailsSharingToggle`). An agent API key
is refused with a named `403` — an agent cannot switch sharing on for itself.

The switch is stored on the agent (`agents.checkout_details_sharing_enabled`,
migration `135_agent_checkout_details_sharing`), not on the owner's row, so
each agent carries its own consent. It is **independent of the tax declaration
switch**: either can be on while the other is off, and no constraint ties them
together. Unlike the tax toggle it does **not** require a VIES-valid VAT
number, and it does **not** require stored details — the owner may turn
sharing on before saving anything, and the agent's read then answers
`no_details`. Switching ON is refused with a structured `409`
(`reason: 'feature_disabled'`) when the deployment's
`HAVEN_OWNER_COMPANY_DETAILS` is off; switching OFF always succeeds, so the
owner can always withdraw sharing.

The agent then reads `GET /agents/:id/checkout-details` with its own key, for
its own id only: an id that is not the authenticated agent's is refused with a
`403` before any company-details row is read. For its own id the answer is
`200` either way:

- `{ available: true, checkout_details: { receipt_email?, billing_address?,
  shipping_address? } }` when the flag is on, sharing is on for this agent,
  and at least one field is saved. The field names and the address shape are
  the ones `docs/architecture/13-checkout-details.md` §2 decides
  (`line1`, `line2`, `line3`, `city`, `postCode`, `subdivision`, `country`).
  A field the owner has not saved is **omitted**, never `null`.
- `{ available: false, reason }` otherwise — `feature_disabled` (flag off),
  `disabled` (sharing off for this agent, or a foreign agent id) or
  `no_details` (sharing on, nothing saved). Availability is the body, not the
  status code: a temporarily unavailable answer is a state to poll, not an
  error.

The read returns **only a receipt email the owner saved**. It never falls back
to the sign-up email (owner decision 2026-11-17, epic #4868): with sharing on
and no receipt email saved, the content has no `receipt_email` key at all. The
sign-up email is a form prefill in Business details, never a shared value.

This slice sends nothing to any merchant. #4872 attaches the answer to the
paid request, and only to a merchant that asked for it. Turning the switch off
between the agent's read and the paid request does not recall an answer
already attached to that request; the next purchase sees the switch off.

The agent Settings tab's row says the same thing in the owner's words: the
one-line description names what is shared and with whom ("Shares the receipt
email and addresses you saved in Business details with merchants that ask."),
and a closed-by-default **What gets shared** disclosure lists the three
fields, says only a merchant that asks receives them, that the agent can read
the details once sharing is on, that only a saved receipt email is ever shared
(never the sign-in email), and that the owner can switch it off at any time.
When none of the three fields is saved, the row says so.

## The settings screen

The Company details card on Settings → Business (`CompanyDetailsCard`,
`useCompanyDetails`) is the #3332 frontend slice on top of the API above,
reshaped and moved onto the Business tab by #4359 (PR #4382). Things worth
naming about how it is built:

- **Gating without a second flag.** The card has no frontend-side feature
  flag of its own; it reads the STATUS of `GET /user/company-details`, never
  its body. `404` means only one thing — the feature is off
  (`requireFeatureEnabled` in `routes/owner-company-details.ts`) — and the
  card renders nothing. `200` with a `null` body means the flag is on and
  the owner has never saved a row: the card shows **"No company details"**
  with **Add company details**, which reveals the blank form (#4359).
  `200` with a row renders the filled form. A failed read renders the card's
  description, a load error and a retry. Once the reads settle, the Business
  tab is listed only when this card or the accounting connections card has
  something to show (`SettingsClient`), so with the flag off the tab appears
  only when the accounting card has something of its own to show. While the
  reads are pending the tab is absent, except that an explicit
  `?tab=business` (or an accounting OAuth return) keeps it listed, with a
  skeleton body, until they settle.
- **The purpose text is shown above the form** — not behind a tooltip or a
  second screen — because *Purpose, retention and GDPR basis* below is what
  the owner is agreeing to by filling it in. It sits above the Add button in
  the empty state too (#4359). The error state does not show it.
- **Country is a picker, not a text field (#4359).** A native `Select` of the
  officially ASSIGNED ISO 3166-1 alpha-2 codes, labelled in the user's
  locale (`lib/countries.ts`), starting on "Choose a country". It saves the
  same wire value — the alpha-2 code — so nothing on the API changes. A row
  saved with a code OUTSIDE the assigned list ("UK", "EL", "XI", "XK": the
  backend's `^[A-Z]{2}$` accepts any well-formed pair) still displays: the
  picker appends it as its own option labelled with the code, and saving
  without touching Country round-trips it exactly as stored — the buyer
  country on receipts never changes silently.
- **The VIES status renders as a badge** (`StatusBadge`), one per state with
  the tones from #4359: `valid` → "Checked against VIES" (success, beside
  the checked date), `invalid` → "Not found in VIES" (warning), `pending` →
  "Checking with VIES…" (neutral), a timed-out `pending` → "VIES check
  pending" (neutral, with Check again), `not_verifiable` → "VIES couldn't
  check this" (NEUTRAL — never danger, never warning; see *The VIES
  states*). No VAT number or an edited-away one: no badge at all.
- **"Remove company details" lives in the footer row** — a `ghost` button to
  the LEFT of Save, shown once a row is saved (#4359); a past design review
  rejected `tertiary` here because it reads as a secondary call to action.

The VIES status polls `GET /user/company-details` every 4 seconds
(`VIES_POLL_INTERVAL_MS`) while `vies_status` is `pending`, bounded at 60
seconds (`VIES_POLL_MAX_MS`: a check that never resolves stops being polled
rather than polling forever). The read runs once in `BusinessDataProvider`,
which wraps all three Settings tabs, so switching to General or Security does
not stop the poll; leaving Settings does. "Check again" calls
`POST /user/company-details/vies-check` on demand and surfaces its `429` in
plain words. "Remove company details" asks for confirmation before calling
`DELETE /user/company-details`; the card then falls back to the "No company
details" state (#4359).

## Purpose, retention and GDPR basis

This is the owner's own data, about themself, saved voluntarily to appear on
receipts their own agents may hand to merchants. For a sole trader, the
organisation number *is* the personal identity number. This document and
the settings form itself both state that plainly: the form's short purpose line
says it before anything is saved (trimmed in the owner's copy review,
2026-09-30). This document also records the VAT number's own SE-format
personal-number encoding (`SE` + personal number + `01`) for the same reason;
the form no longer repeats that detail.

- **Basis**: consent — the owner opts in by calling `PUT
  /user/company-details` or filling in the Company details form on Settings →
  Business; nothing here is required for an agent or a payment to work. The
  receipt email and the two addresses (#4870) are part of the same consent:
  they are optional, saved by the same form and the same call, and the
  sign-up email is only ever a prefill, shown only while no company details are
  saved (#4946) — it is not stored as a receipt email until the owner saves.
- **Purpose**: stating the buyer on a payment receipt the owner's own agent may
  give to a merchant, (asynchronously) validating the VAT number against
  VIES, and, for an agent the owner opts in, stating the country and VAT
  number in the buyer-side tax declaration that a key-holding client — the opt-in local MCP server,
  `@haven_ai/mcp`, or a developer's own SDK client — sends on its EIP-3009
  payments; an agent on the connector's default hosted install sends none (see
  *A second reader* above). The receipt email and the billing and shipping
  addresses (#4870) are stored so they can be passed to a merchant that asks
  for them — the merchant-facing answer #4871 builds. This slice sends
  nothing to any merchant.
- **Retention**: kept until the owner deletes it. `DELETE
  /user/company-details` works regardless of the feature flag, and with the
  flag ON the owner calls it themselves from the Company details card on
  Settings → Business. With the flag OFF, though, that card renders nothing at all (#3332 review round
  2, M3) — so there is no dashboard way to erase in that state. The owner can
  still call the ungated `DELETE` with their own session, but in practice
  they ask Haven support, who removes the row directly in the database: the
  route only ever erases the CALLER's own row, so support cannot call it on
  the owner's behalf. The three #4870 fields are removed with the row by that
  same `DELETE` — they live on it, so there is no second erasure path to
  forget. A merchant receipt that already shows the owner's email or address
  is kept by the merchant, and by Haven as the owner's bookkeeping record
  (`merchant_receipts` and the accounting attachments, retained under
  bokföringslagen 7 kap. 2 § / GDPR Art. 17(3)(b)); that delete reaches
  neither. What it erases is the details row, the one every future Haven read
  uses.
  Deleting the Haven account WOULD also
  remove these details (`user_id` is `ON DELETE CASCADE`), but account
  deletion is an operator action today — there is no self-serve
  delete-my-account route — so that cascade is not itself something an owner
  can currently trigger. Two other tables reference `users(id)` with no `ON
  DELETE` action at all (`payment_intents.user_id`,
  `agent_rekeys.initiated_by_user_id`); a future self-serve account-deletion
  flow will need to delete rows in those (and this) table explicitly rather
  than relying on cascades alone.
- **The ops console cannot read these details.** Its read-only database role
  (#3510, [`ops-readonly-role.md`](../operations/ops-readonly-role.md)) is not granted
  `owner_company_details`, so internal ops access adds no new reader.

## Env var

`HAVEN_OWNER_COMPANY_DETAILS` — strict boolean (`parseBooleanFlag`), dark by
default. See [`docs/operations/dev-environment.md`](../operations/dev-environment.md#configuration).
