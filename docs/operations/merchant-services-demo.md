---
owner: "@d-hinders"
status: current
covers:
  - packages/demo-merchant-mcp/src/sales.ts
  - packages/demo-merchant-mcp/src/index.ts
  - packages/demo-merchant-mcp/src/http.ts
  - packages/backend/src/routes/merchant-keys.ts
  - packages/backend/src/routes/merchant-sales.ts
  - packages/backend/src/routes/merchant-sales-reads.ts
  - packages/backend/src/routes/merchant-deposit-addresses.ts
  - packages/frontend/src/components/settings/StripeDepositAddressesSection.tsx
  - packages/frontend/src/components/sales/SalesKeysSection.tsx
  - packages/frontend/src/components/sales/CreateSalesKeyDialog.tsx
  - packages/frontend/src/components/sales/SalesPaymentPanel.tsx
last-verified: "2026-11-19"
---

# Merchant Services Demo

This is how to run the merchant-services demo for an outside audience, on Haven's
**dev** environment (Base Sepolia, test USDC, the Stripe sandbox). The demo
shows one merchant, Haven's own demo merchant, selling two products to a Haven
agent. Each sale then appears on the merchant's **Sales** page in Haven:

| Product | Where the money lands | What the audience sees |
|---|---|---|
| **Haven Field Notes** (`field_notes`, 0.0025 USDC) | The merchant's Haven **Sales account** | A sale on the Sales page, in Revenue |
| **Haven Joke** (`joke`, 0.01 USDC) | The merchant's **Stripe sandbox** deposit address | A payment in Stripe's dashboard, and a sale on the Sales page marked as received in Stripe |

Scope is the owner's decision (2026-11-18): one Haven product plus the Stripe
joke. The demo merchant's other products are not sales: they keep paying
`MERCHANT_ADDRESS` and never appear on the Sales page.

> **Not yet verified.** Nothing here has been run end to end on dev. Every step
> is marked *not yet verified* until it has been. When you run a step, record
> the date next to it and remove the mark. The code each step relies on is
> merged to `dev`.

Placeholders appear in angle brackets, for example `<DEV_API>`. This file
holds no email address, no key, and no address that is not already public.

## Who is who

The demo needs **two different Haven users**. Haven counts a payment from the
merchant's own accounts and own agents as a move between their accounts, not a
sale (#4897). If the merchant's own agent buys Field Notes, the Sales page shows
a row marked "Moved between your accounts" / "Not counted", outside Revenue.
If it buys the joke, Haven refuses the report and nothing appears.

- **The merchant.** A dedicated test user on dev, created by the owner for this
  demo and signed in with a passkey. This user owns the Sales account, the
  Sales key and the Stripe deposit address registration.
- **The buyer.** An agent of the owner's usual dev user, a different Haven
  user. It needs an open budget on Base Sepolia that covers both purchases.

## 1. One-time setup

Do these in order. Steps that involve a passkey or the Railway dashboard are
the owner's.

### 1.1 Create the merchant user *(not yet verified)*

1. In a private browser window, open the dev dashboard (`<DEV_DASHBOARD>`) and
   sign up with a new passkey. This is the merchant.
2. Note nothing from the account in this file or in any issue.

### 1.2 Turn Sales on *(not yet verified)*

1. As the merchant, open **Settings → Business → Sales** and turn Sales on
   (#4904). Pick **Base Sepolia**.
2. A new account named **Sales** appears. Copy its address from the Accounts
   screen or the Sales page's Receive dialog, in its **checksummed** (mixed-case)
   form: the demo merchant refuses an address that is not checksummed. This is
   `<SALES_ACCOUNT_ADDRESS>`.

### 1.3 Create a Sales key *(not yet verified)*

1. As the merchant, open the **Sales** page and its **Setup** tab. Under
   **Sales keys**, choose **Create Sales key**, then **Create Sales key** again
   in the dialog (#4905).
2. The **Your new Sales key** dialog shows the key **once**: `sk_merchant_…`.
   Choose **Copy key**. This is `<SALES_KEY>`. Paste it straight into Railway
   (step 1.4), nowhere else.
3. Choose **Done**. From then on the list shows only the key's first
   characters. If you lose the key, revoke it (step 4.3) and create a new one.

The same through the API, with the merchant's dashboard session. The session
token is the `haven_token` entry in the dev dashboard's local storage. Treat it
as a password: use it only in your own terminal, never in an issue or a chat.

```bash
curl -s -X POST "<DEV_API>/merchant-keys" \
  -H "Authorization: Bearer <MERCHANT_SESSION_TOKEN>"
```

The answer's `secret` field carries the key once.

### 1.4 Configure the dev demo merchant *(not yet verified)*

In Railway, open the **Demo-merchant** service in the **dev** environment
([railway-services.md](railway-services.md)) and set these variables. The
owner pastes secrets into Railway directly, never through chat.

| Variable | Value | For |
|---|---|---|
| `MERCHANT_SALES_KEY` | `<SALES_KEY>` | Both products' reports |
| `MERCHANT_HAVEN_BASE_URL` | `<DEV_API>` | Both products' reports |
| `MERCHANT_SALES_ADDRESS` | `<SALES_ACCOUNT_ADDRESS>` | Field Notes only (offered only when set) |
| `STRIPE_SECRET_KEY`, `STRIPE_DEPOSIT_ADDRESS` | already set on dev (#4854) | The joke |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | already set on dev (#4852) | The joke (it settles through Coinbase's facilitator) |

Leave `MERCHANT_ADDRESS` as it is. The other products, and every QA target,
keep paying it.

Redeploy the service.

### 1.5 Register the Stripe deposit address, before the first joke payment *(not yet verified)*

Haven accepts a Stripe-settled sale only when its deposit address was
registered under the Sales account **at or before the payment's block time**
(#4952). The demo merchant never resends a refused report, so a joke paid
before registration is lost for good: it never appears on the Sales page.

Signed in as the merchant user, open **Settings → Business → Sales**. Under
**Stripe deposit addresses**, choose **Register address**, paste
`<STRIPE_DEPOSIT_ADDRESS>` and register it (#4954). The address is listed with
"Not verified by Haven".

The same through the API, with the merchant's dashboard session:

```bash
curl -s -X POST "<DEV_API>/merchant-deposit-addresses" \
  -H "Authorization: Bearer <MERCHANT_SESSION_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"address": "<STRIPE_DEPOSIT_ADDRESS>"}'
```

`<STRIPE_DEPOSIT_ADDRESS>` is the dev demo merchant's
`STRIPE_DEPOSIT_ADDRESS`. Its `/healthz` shows it under
`stripe.deposit_address`. The answer carries `verified: false`. Haven cannot
check that the address is the merchant's (owner decision 2026-11-18, demo
only), and the screens say "registered by you, not verified by Haven".

### 1.6 Fund *(not yet verified)*

- **The buyer agent:** test USDC on Base Sepolia, at least the two prices
  (0.0125 USDC) plus room for a rehearsal, inside its budget.
- **The demo merchant's settlement key** (`SETTLEMENT_PRIVATE_KEY`): Base
  Sepolia ETH for gas. Field Notes settles with it.
- **Nothing else.** The joke settles through Coinbase's facilitator, which pays
  the gas, and the Sales account needs no funds to receive.

## 2. The click path

Have two windows open:
- the merchant, signed in to the dev dashboard on the **Sales** page;
- the buyer's agent client, connected to dev with the owner's agent.

The Stripe sandbox dashboard is optional, for the joke.

### 2.1 A sale received in Haven *(not yet verified)*

1. **Say:** "A merchant sells to AI agents. Here is its Sales page in Haven."
   **Show:** the Sales page, Overview tab. Note the Revenue and Sales figures:
   after a rehearsal they are not zero (see 3.2).
2. **Say:** "An agent buys a field note, paying in USDC." In the agent client,
   ask the agent to buy **Haven Field Notes** from the demo merchant's MCP
   endpoint (`<DEV_DEMO_MERCHANT>/mcp`): it is not in Haven's catalog, so the
   agent quotes it with `haven_quote_mcp_tool`. **Show:** the agent's answer,
   which is the note itself.
3. **Say:** "The money went straight into the merchant's Haven Sales account,
   and the merchant reported the sale." Reload the Sales page. Expect 10 to 30
   seconds: Haven waits for three confirmations, and the first report usually
   gets a "retry in 10 seconds" answer.
4. **Show:**
   - **Revenue** up by 0.0025 USDC, and **Sales** up by 1;
   - the row for Haven Field Notes, with the buyer shown as **Wallet**. Haven
     never tells the merchant that the buyer is a Haven user;
   - opening the row: the on-chain payment, with its transaction hash.

### 2.2 A sale received in Stripe *(not yet verified)*

1. **Say:** "The same merchant can choose to receive into Stripe instead." In the
   agent client, ask the agent to buy **Haven Joke**. **Show:** the joke.
2. **Show Stripe:** in the Stripe sandbox dashboard, under **Payments**, a new
   crypto payment for the joke's price, whose metadata carries the
   transaction hash (#4854).
3. **Show Haven:** reload the Sales page.
   - the joke's row carries the **Received in Stripe** mark, and it is **not**
     in Revenue: Stripe-held sales are kept out of every account tile;
   - a separate **Received in Stripe** tile shows their amount, and the
     payments line names it beside Revenue;
   - opening the row: the payment into the Stripe deposit address, with its
     transaction hash, and no Sales account.
4. **Say:** "Haven shows the sale, but the money is in Stripe's custody: it never
   counts in a Haven balance."

### 2.3 More to show, if there is time *(not yet verified)*

- **Find a payment.** On the Sales page's Overview tab, the payments list has a
  search box and **Product**, **Payer** and **Recorded** filters (#4959, #4960).
  With a filter set, the tiles and breakdowns follow it.
- **Revenue beside spending.** Open **Analytics** and switch from **Spending**
  to **Revenue** (#4901).
- **The merchant's currency.** Amounts follow the merchant user's display
  currency. In SEK or EUR they are priced at today's rate, and repriced totals
  carry "≈" (#4963).

## 3. Checks before a showing

Run these on the day of a showing.

### 3.1 The demo merchant is up and configured *(not yet verified)*

```bash
curl -s "<DEV_DEMO_MERCHANT>/healthz"
```

Expect:
- `stripe.configured: true`, with `stripe.deposit_address` equal to the
  registered address;
- a `sales` block with `configured: true` and `address` equal to the Sales
  account;
- `sales.refused: 0` and `sales.gave_up: 0`.

The service's startup log has a `Sales:` line:
- **Healthy:** `reporting joke (Stripe-settled); field_notes $0.0025 paid into <SALES_ACCOUNT_ADDRESS> to <DEV_API>`.
- **`not reporting …`:** the Sales key or the base URL is unset or unusable.
- **`… field_notes not offered …`:** `MERCHANT_SALES_ADDRESS` is unset or
  unusable. The joke still reports.

### 3.2 One test purchase of each product *(not yet verified)*

Run the whole click path (section 2) once. The page does not return to empty
afterwards: clearing a Field Notes sale record (step 4.1) keeps the payment as
"No product recorded", still in Revenue. To show an empty page, rehearse with a
second merchant user, or present the figures as changes from what is already
there.

### 3.3 What a failure looks like *(not yet verified)*

- **The sale appears only after 10 to 30 seconds.** Haven answers
  `425 transaction_not_visible` until the payment has three confirmations, and
  the reporter retries after 10 seconds. That is normal.
- **The sale never appears, and `sales.refused` went up.** Haven refused the
  report. Usually one of these:
  - for the joke, the deposit address was not registered before the payment
    (step 1.5);
  - for the joke, the buyer is the merchant's own agent or account: a transfer
    to the Stripe address from the merchant's own addresses is not a sale;
  - the Sales key was revoked;
  - Sales is off.

  The service log's `[sales]` line shows the refusal's `code=`.
- **Field Notes shows as "Moved between your accounts".** The buyer is the
  merchant's own agent or account. Haven counts that as a move between the
  merchant's accounts, outside Revenue. Use an agent of a different user ("Who
  is who").
- **`sales.gave_up` went up.** Every retry failed: Haven was unreachable,
  answered a 5xx such as `503 chain_unavailable`, or the payment stayed
  `425 transaction_not_visible` longer than the retries last. Check that
  `MERCHANT_HAVEN_BASE_URL` points at the dev API, then buy again.

## 4. Reset and rotation

### 4.1 Clear a sale record *(not yet verified)*

The payment stays, but its sale record goes. An account sale then shows as a
payment with no product. A Stripe-held sale leaves the list. A new record for
the same transaction is accepted afterwards.

On screen: open the payment on the Sales page and choose **Clear sale record**.
Through the API:

```bash
curl -s -X DELETE "<DEV_API>/merchant-sales/payments/<TX_HASH>/record" \
  -H "Authorization: Bearer <MERCHANT_SESSION_TOKEN>"
```

### 4.2 Rotate the Stripe deposit address *(not yet verified)*

1. Create the new address in the Stripe sandbox. It is public.
2. **Register the new address in Haven first** (step 1.5, with the new
   address).
3. Set `STRIPE_DEPOSIT_ADDRESS` to it, and `STRIPE_PREVIOUS_DEPOSIT_ADDRESS` to
   the old one, then redeploy
   ([secret-rotation.md](secret-rotation.md)).
4. Only after the last payment to the old address has settled, retire the old
   registration: **Retire** beside it under Settings → Business → Sales →
   Stripe deposit addresses. It stays listed as Retired. Through the API:

   ```bash
   curl -s "<DEV_API>/merchant-deposit-addresses" \
     -H "Authorization: Bearer <MERCHANT_SESSION_TOKEN>"        # find its id
   curl -s -X POST "<DEV_API>/merchant-deposit-addresses/<ID>/retire" \
     -H "Authorization: Bearer <MERCHANT_SESSION_TOKEN>"
   ```

### 4.3 Rotate the Sales key *(not yet verified)*

1. Create a new key (step 1.3), set it as `MERCHANT_SALES_KEY` and redeploy.
2. Revoke the old one: on the Sales page's **Setup** tab, under **Sales keys**,
   choose **Revoke** beside it, then **Revoke key**. It stays listed as Revoked. Through
   the API:

   ```bash
   curl -s "<DEV_API>/merchant-keys" -H "Authorization: Bearer <MERCHANT_SESSION_TOKEN>"   # find its id
   curl -s -X DELETE "<DEV_API>/merchant-keys/<ID>" -H "Authorization: Bearer <MERCHANT_SESSION_TOKEN>"
   ```

A report sent with a revoked key is refused, and is not resent.

## 5. What the demo does not show yet

| Not yet | Why |
|---|---|
| The demo merchant's other products on the Sales page | Owner decision 2026-11-18: one Haven product plus the Stripe joke. The rest keep paying `MERCHANT_ADDRESS`. |
| What a sale was worth on the day it was made | SEK and EUR amounts use today's rate, not the rate at the time of the sale (#4963). |
| What Stripe shows for a payment the merchant never recorded there | Not tested (#4902). Every joke sale in the demo goes through the recorder, so the case does not arise. |

Production use is out of scope. Before any production use, a proof that the
merchant owns its deposit address is required (owner decision 2026-11-18,
#4902).
