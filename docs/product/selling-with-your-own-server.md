---
owner: "@d-hinders"
status: current
covers:
  - packages/backend/src/routes/merchant-sales.ts
  - packages/backend/src/openapi/spec.ts
  - packages/paywall-proxy/src/challenge.ts
  - packages/paywall-proxy/src/chains.ts
  - packages/merchant-payments/src/sale-report.ts
  - packages/merchant-payments/src/merchant-reference.ts
  - packages/frontend/src/components/sales/SellerSetupPrompt.tsx
  - packages/frontend/src/lib/i18n/messages/en.ts
last-verified: "2026-11-20"
---

# Selling with your own server

A seller that runs its own MCP server or HTTP API does two things: it asks each
buyer to pay into the Sales account, and it reports each settled payment to
Haven with a Sales key. This page is one short, complete example of both. The
architecture's account of the same two steps is
[`docs/architecture/12-merchant-kit.md` § *Selling without the kit*](../architecture/12-merchant-kit.md#selling-without-the-kit);
the route's contract is `POST /merchant/sales` in
`packages/backend/src/openapi/spec.ts`.

Every value below is a placeholder. Replace the address, the transaction hash,
the payer and the reference with your own. Never paste a real Sales key into a
document, a repository or a chat.

## 1. Ask for payment into the Sales address

Answer an unpaid call with an x402 `402` and one `accepts` entry. This is the
answer the merchant kit's proxy sends (`packages/paywall-proxy/src/challenge.ts`),
and a server of your own sends the same shape:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/v1/chat",
    "description": "One chat completion, up to 1,000 output tokens.",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "payTo": "0x3333333333333333333333333333333333333333",
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "name": "USDC", "version": "2" }
    }
  ],
  "error": "Payment required"
}
```

- `scheme: "exact"` is the EIP-3009 exact-amount scheme.
- `network` is CAIP-2. Base Sepolia is `eip155:84532`; Base mainnet is
  `eip155:8453`. The merchant kit refuses Base mainnet at startup in this
  release (#5061), so a started proxy's challenge names Base Sepolia only; the
  mainnet facts below stay for go-live.
- `asset` is USDC on that network. On Base Sepolia it is
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; on Base mainnet,
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  (`packages/paywall-proxy/src/chains.ts`).
- `payTo` is the Sales account's address — the account the Sales key belongs to.
- `amount` is atomic USDC units, as a decimal string: `10000` is 0.01 USDC.
- `maxTimeoutSeconds` is how long the buyer's signed authorization stays valid.
- `extra` is the USDC EIP-712 signing domain the buyer signs over: `USDC` / `2`
  on Base Sepolia, `USD Coin` / `2` on Base mainnet
  (`packages/paywall-proxy/src/chains.ts`).

**Settlement is yours.** The payment is verified and settled through the
merchant's own Coinbase facilitator key, not Haven's: Haven never holds a
merchant's facilitator credentials and never settles on a merchant's behalf
(owner decision (a) on epic #4884). Haven's own key is not offered to sellers.

**Who can pay.** During the pilot only a Haven agent with an open, unpinned
budget can pay an arbitrary merchant. A buyer whose budget is pinned to named
merchants cannot pay a merchant it was not given.

If you use a third-party x402 server library rather than writing the challenge
yourself, check its call shape against its current documentation. The reference
implementation is
[`@x402/express`](https://github.com/x402-foundation/x402/tree/main/typescript/packages/http/express):
`paymentMiddleware(routes, resourceServer)` with
`new x402ResourceServer(new HTTPFacilitatorClient({ url })).register('eip155:84532', new ExactEvmScheme())`,
and `payTo` inside each route's `accepts`.

## 2. Report the sale

After the payment settles, send one record to `POST /merchant/sales` with the
Sales key you created on Sales → Setup → Sales keys:

```bash
curl -X POST "$HAVEN_SALES_URL/merchant/sales" \
  -H "Authorization: Bearer $HAVEN_MERCHANT_KEY" \
  -H "Content-Type: application/json" \
  -d @sale.json
```

```json
{
  "version": 1,
  "tx_hash": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "chain": "eip155:84532",
  "product_id": "chat-completion-1k",
  "product_name": "Chat completion, 1,000 output tokens",
  "amount": "10000",
  "payer": "0x2222222222222222222222222222222222222222",
  "merchant_reference": "sale_01JEXAMPLE0000000000000000"
}
```

The body is the sale record of `docs/architecture/12-merchant-kit.md` §5. The
required fields are `tx_hash`, `chain`, `product_id`, `amount`, `payer` and
`merchant_reference`; `version` is optional and absent means `1`, so send `1`
explicitly. `product_name`, `receipt_number` and `vat_treatment` are optional.

- `tx_hash` is the settlement transaction. Haven reads the chain with it; the
  sale's amount, payer, token and time are copied from that read, so `amount`
  and `payer` are validated and stored nowhere.
- `chain` must be the Sales account's network.
- `product_id` is your own product id. Haven stores it and does not interpret it.
- `merchant_reference` is your own reference, a `sale_<ULID>` generated **once
  per payment** and kept: a retried call or a resent record carries the same
  one, which is what makes a resend identical.

### The answers to expect

| Status | Meaning |
|---|---|
| `201` | A new sale was stored. |
| `200` | An identical resend: the sale already stored for this transaction. Nothing was written. |
| `425` | `transaction_not_visible`: the receipt is not found yet, or has fewer than 3 confirmations. Send the same record again after `Retry-After` seconds. It is the only 4xx answer a reporter retries. |
| `409` | `sale_record_conflict`: this transaction already has a different sale record on the account, and the first stands. |
| `422` | Refused, not retryable: `chain_mismatch` (the chain is not the account's network) or `no_payment_to_account` (the transaction did not pay this account). |
| `429` | Rate limited: 120 a minute per Sales key. |
| `401` | Missing, invalid or revoked Sales key. |
| `403` | Merchant services are turned off for the account. |

Every refusal carries `error` and `error_code` with the same machine-readable
code, and `message` in words. A `422` is the same answer whether the
transaction paid another Haven account, an unregistered address or nobody, so a
key cannot test whether a hash paid another account.

## What the Sales key can and cannot do

The key is receive-only: it can report sales and nothing else. It cannot move
money, sign, or change signers, budgets or agents. Its limits, and how
revocation works, are in
[`docs/security/merchant-key-limits.md`](../security/merchant-key-limits.md).
