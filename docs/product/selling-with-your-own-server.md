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
  - packages/sdk/src/mcp-merchant-transport.ts
  - packages/sdk/src/merchant-completion.ts
  - packages/sdk/src/client.ts
  - packages/backend/src/modules/transactions/merchant-sales.ts
  - packages/frontend/src/components/sales/SalesSetupTab.tsx
  - packages/mcp-server/src/tools/support/resource-address.ts
  - packages/backend/src/modules/catalog/merchant-products.ts
last-verified: "2026-11-26"
---

# Selling with your own server

A seller that runs its own MCP server or HTTP API does two things: it asks each
buyer to pay into the Sales account, and it reports each settled payment to
Haven with a Sales key. This page is one short, complete example of both, for
an HTTP API (sections 1 and 2) and for an MCP server (section 3). The
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

**Who can pay.** Any x402 buyer that pays your challenge can pay. A payment
from the Sales account owner's own agents or accounts goes through too, but it
shows as a move between the owner's accounts, not a sale. A Haven agent needs an open, unpinned
budget; one whose budget is pinned to named merchants cannot pay a merchant it
was not given. Every live run of this guide so far used a Haven agent as the
buyer; a buyer outside Haven has not been exercised.

If you use a third-party x402 server library rather than writing the challenge
yourself, check its call shape against its current documentation. The reference
implementation is
[`@x402/express`](https://github.com/x402-foundation/x402/tree/main/typescript/packages/http/express):
`paymentMiddleware(routes, resourceServer)` with
`new x402ResourceServer(facilitator).register('eip155:84532', new ExactEvmScheme())`,
and `payTo` inside each route's `accepts`.

Build `facilitator` from your own Coinbase developer key, not from a URL alone.
`HTTPFacilitatorClient({ url })` with no credentials does not use your key.
The package [`@coinbase/x402`](https://www.npmjs.com/package/@coinbase/x402)
does it for you: `new HTTPFacilitatorClient(createFacilitatorConfig(keyId, secret))`
signs each call with your key and sends it to Coinbase's facilitator. You create
the key in the Coinbase developer portal. The merchant kit's README covers
which key type to pick and how to store the secret:
[Coinbase developer keys](../../packages/paywall-proxy/README.md#coinbase-developer-keys).
Section 3 shows the whole thing in a running server.

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
| `425` | `transaction_not_visible`: Haven cannot see the transaction with 3 confirmations yet. A report sent right after settlement may get it, or may get `201` straight away. When it comes, send the same record again after `Retry-After` seconds. It is the only 4xx answer a reporter retries. |
| `409` | `sale_record_conflict`: this transaction already has a different sale record on the account, and the first stands. |
| `422` | Refused, not retryable: `chain_mismatch` (the chain is not the account's network) or `no_payment_to_account` (the transaction did not pay this account). |
| `429` | Rate limited: 120 a minute per Sales key. |
| `401` | Missing, invalid or revoked Sales key. |
| `403` | Merchant services are turned off for the account. |

Every refusal carries `error` and `error_code` with the same machine-readable
code, and `message` in words. A `422` is the same answer whether the
transaction paid another Haven account, an unregistered address or nobody, so a
key cannot test whether a hash paid another account.

## 3. Selling MCP tools

An MCP server sells the same way: it asks for payment into the Sales address,
settles with your own key, and reports the sale in section 2's form. What is
different is how the challenge and the payment travel. This section explains
that, then gives a complete server you can copy and run on Base Sepolia.

The example uses [`@x402/mcp`](https://www.npmjs.com/package/@x402/mcp), the
public x402 library for MCP (Apache-2.0). The facts below were checked against
these exact versions on 2026-11-26. A later version may behave differently, so
pin them:

```bash
npm install --save-exact @x402/mcp@2.32.0 @x402/core@2.32.0 @x402/evm@2.32.0 \
  @coinbase/x402@2.1.0 @modelcontextprotocol/sdk@1.32.2 express@5.3.0 zod@4.6.7 ulid@3.0.2
```

### How a paid tool call carries the challenge and the payment

An MCP server never answers HTTP `402`. An unpaid `tools/call` of a paid tool
gets an ordinary HTTP 200 answer. Its tool result has `isError: true` and
carries the same x402 challenge as section 1, in `structuredContent` and again
as JSON text in `content[0].text`:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "isError": true,
    "structuredContent": {
      "x402Version": 2,
      "error": "Payment required to access this tool",
      "resource": {
        "url": "https://mcp.example.com/mcp",
        "description": "A three-line poem about a topic you name.",
        "mimeType": "application/json"
      },
      "accepts": [
        {
          "scheme": "exact",
          "network": "eip155:84532",
          "amount": "1000",
          "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          "payTo": "0x3333333333333333333333333333333333333333",
          "maxTimeoutSeconds": 300,
          "extra": { "name": "USDC", "version": "2" }
        }
      ]
    },
    "content": [{ "type": "text", "text": "(the same challenge, as JSON text)" }]
  }
}
```

The buyer then calls the same tool again. This time the signed payment is in
the request's `params._meta["x402/payment"]`, as a JSON object. Haven's buyer
also sends the same payment, base64-encoded, in a `PAYMENT-SIGNATURE` HTTP
header (`packages/sdk/src/mcp-merchant-transport.ts`); `@x402/mcp` reads
`_meta`. After settlement, the tool's answer carries the result in
`result._meta["x402/payment-response"]`: `success`, `transaction`, `network`
and `payer`. `@x402/mcp` builds the challenge, reads the payment and adds
the result for you.

### Four rules Haven's buyer needs

1. **Issue an MCP session id.** Run the streamable HTTP transport with sessions
   (`sessionIdGenerator: () => randomUUID()`), so the answer to `initialize`
   carries an `Mcp-Session-Id` header, and serve `GET` and `DELETE` on the
   endpoint too. Today Haven's buyer refuses a server without one at the quote,
   before any payment is made: "The merchant did not establish an MCP session
   before the x402 quote. No payment was created."
   (`packages/sdk/src/client.ts`). Support for servers without sessions is
   planned (#5089) and not available yet.
2. **Set `resource.url` to your MCP endpoint**, the https address buyers call,
   for example `https://mcp.example.com/mcp`. If you leave it out, `@x402/mcp`
   fills in an `mcp://tool/…` address. Haven's paid-MCP tools
   (`haven_pay_mcp_tool` or `haven_prepare_catalog_purchase`, then
   `haven_settle_mcp_tool`) accept that too since #5086: they deliver the
   payment to the endpoint they called when they quoted, whatever the
   challenge names (`packages/mcp-server/src/tools/support/resource-address.ts`).
   Haven's SDK called directly, and the hosted `haven_pay_x402_quote` tool,
   still compare the two string for string
   (`packages/sdk/src/merchant-completion.ts`), so the endpoint is the value
   to use.
3. **Set `maxTimeoutSeconds: 300` yourself.** It is how long the buyer's
   signed payment stays valid, and Haven's buyer needs time to fund, sign and
   send it. The library's README gives a default of 60 while its code uses
   300; do not rely on either. The merchant kit uses 300
   (`packages/paywall-proxy/src/challenge.ts`).
4. **Report `payer` as the address that signed.** For a Haven agent that is
   the agent's delegate address, the `from` of the signed authorization, never
   the Haven account
   ([§5 *The payer address*](../architecture/12-merchant-kit.md#the-payer-address)).
   Send `tx_hash` lower-cased.

### Settle with your own Coinbase key

`@x402/mcp` verifies and settles the payment through a facilitator. Use
Coinbase's, with your own developer key, as section 1 says. Haven's own key is
not offered and is never needed: `createFacilitatorConfig(keyId, secret)` from
`@coinbase/x402` takes your key and returns the configuration
`HTTPFacilitatorClient` expects. Create the key in the Coinbase developer
portal; the kit's README says which type to pick
([Coinbase developer keys](../../packages/paywall-proxy/README.md#coinbase-developer-keys)).
The example refuses to start without it.

### Use each payment once

`@x402/mcp` 2.32.0 verifies the payment, runs your tool, then settles. Once a
payment has settled, the chain refuses it a second time. Before that, nothing in
the library stops two calls that carry the same payment: both can pass
verification and both get the tool's answer, though only one settles. Keep your
own record of the payments you have used, the way the merchant kit does
([§6 *The consumed-payment store*](../architecture/12-merchant-kit.md#6-the-consumed-payment-store)):

- **The key is the payment's identity:** `eip3009:<chain id>:<payer>:<nonce>`,
  lower-cased, not the nonce alone.
- **A known key must also match.** Store a digest of the signed authorization
  with the key. A request with a known key and a different digest is a
  different payment: refuse it and leave the record alone.
- **Reserve the key before the payment is verified**, so a second call with
  the same payment is refused while the first is in progress.
- **Release it on every failure before settlement**, a failed verification
  included. Once settlement may have started, never release it.

The example keeps this record in memory, which a restart forgets. Keep it in a
database before you take real traffic.

### Name your products on the Sales page (optional)

The Sales page's Products tab can list what you sell. Serve a product list at
`<your origin>/.well-known/x402`, as the example does (its fields are in
[§4 *The demo merchant's reduced kit document*](../architecture/12-merchant-kit.md#the-demo-merchants-reduced-kit-document-4987)).
Then the account owner enters your origin, with no path, under **Sales → Setup
→ Product list address**. An account has one product list address. Without one,
sales still show the `product_name` your record sends.

### The example server

One free tool (`ping`) and one paid tool (`haiku`, 0.001 USDC). Save it as
`server.mjs` next to a `package.json` with `"type": "module"`, set the
environment variables below, and run `node server.mjs` (it was run on
Node.js 24). Buyers call `$PUBLIC_URL/mcp`, so it must be a public https
address. On your own machine a tunnel (for example
`cloudflared tunnel --url http://localhost:4402`) gives you one. A new tunnel
address can take a few minutes before Haven can reach it; until then a
quote fails with the session message from rule 1, and nothing is paid.

| Variable | What it is |
|---|---|
| `PUBLIC_URL` | Your server's public https origin, no trailing slash. |
| `SALES_ADDRESS` | Your Sales account's address, the `payTo`. |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | Your own Coinbase developer key. |
| `HAVEN_SALES_URL` | Haven's API origin, from the setup prompt. |
| `HAVEN_MERCHANT_KEY` | Your Sales key. Keep it in the environment, never in the file. |

```js
// A paid MCP server on Base Sepolia: one free tool, one paid tool.
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { ulid } from "ulid";
import { z } from "zod";

const env = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
};
const PORT = Number(process.env.PORT ?? 4402);
const PUBLIC_URL = env("PUBLIC_URL"); // https://mcp.example.com, no trailing slash
const ENDPOINT = `${PUBLIC_URL}/mcp`; // the address buyers call
const PAY_TO = env("SALES_ADDRESS"); // your Sales account's address
const NETWORK = "eip155:84532"; // Base Sepolia
const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HAVEN_SALES_URL = env("HAVEN_SALES_URL"); // Haven's API origin
const HAVEN_MERCHANT_KEY = env("HAVEN_MERCHANT_KEY"); // your Sales key
const PRODUCT = { id: "haiku-1", name: "One haiku", description: "A three-line poem about a topic you name.", price: "1000" }; // 0.001 USDC

// Settle with your own Coinbase developer key.
const facilitator = new HTTPFacilitatorClient(
  createFacilitatorConfig(env("CDP_API_KEY_ID"), env("CDP_API_KEY_SECRET")),
);
const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());
await resourceServer.initialize();

const accepts = await resourceServer.buildPaymentRequirements({
  scheme: "exact",
  network: NETWORK,
  payTo: PAY_TO,
  price: { amount: PRODUCT.price, asset: USDC, extra: { name: "USDC", version: "2" } },
  maxTimeoutSeconds: 300,
});

// One use per payment. A Map forgets on restart: keep this in a database.
const payments = new Map();
const keyOf = (payment) => {
  const a = payment?.payload?.authorization;
  return a ? `eip3009:${CHAIN_ID}:${a.from}:${a.nonce}`.toLowerCase() : null;
};
const digestOf = (payment) => {
  const a = payment.payload.authorization;
  const fields = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, payment.payload.signature];
  return createHash("sha256").update(JSON.stringify(fields.map((f) => String(f).toLowerCase()))).digest("hex");
};
const refuse = (text) => ({ content: [{ type: "text", text }], isError: true });

async function reportSale(sale) {
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const res = await fetch(`${HAVEN_SALES_URL}/merchant/sales`, {
      method: "POST",
      headers: { Authorization: `Bearer ${HAVEN_MERCHANT_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(sale),
    }).catch(() => null);
    console.log("sale report", sale.tx_hash, res?.status ?? "no answer");
    if (res && res.status !== 425 && res.status < 500) return res.status;
    const wait = Number(res?.headers.get("retry-after") ?? 10);
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 60) * 1000));
  }
}

const paid = createPaymentWrapper(resourceServer, {
  accepts,
  resource: { url: ENDPOINT, description: PRODUCT.description, mimeType: "application/json" },
  hooks: {
    // The tool succeeded and settlement is next: from here the payment is never released.
    onAfterExecution: async ({ paymentPayload, result }) => {
      if (!result.isError) payments.get(keyOf(paymentPayload)).state = "settling";
    },
    onAfterSettlement: async ({ paymentPayload, settlement }) => {
      const entry = payments.get(keyOf(paymentPayload));
      entry.state = "settled";
      const sale = {
        version: 1,
        tx_hash: settlement.transaction.toLowerCase(),
        chain: NETWORK,
        product_id: PRODUCT.id,
        product_name: PRODUCT.name,
        amount: PRODUCT.price,
        payer: paymentPayload.payload.authorization.from.toLowerCase(),
        merchant_reference: entry.reference,
      };
      setImmediate(() => reportSale(sale).catch(console.error)); // don't hold the buyer's answer
    },
  },
});

// Reserve the payment before the library verifies it; release it on every failure before settlement.
const oncePerPayment = (handler) => async (args, extra) => {
  const payment = extra?._meta?.["x402/payment"];
  if (payment == null) return handler(args, extra); // no payment yet: the library answers with the challenge
  const key = keyOf(payment);
  if (!key) return refuse("Only EIP-3009 payments are accepted.");
  const digest = digestOf(payment);
  const known = payments.get(key);
  if (known && known.digest !== digest) return refuse("This is not the payment recorded under this authorization.");
  if (known) return refuse(known.state === "settled" ? "This payment has already been used." : "This payment is in progress, or its settlement is unknown.");
  payments.set(key, { digest, state: "reserved", reference: `sale_${ulid()}` });
  try {
    return await handler(args, extra);
  } finally {
    if (payments.get(key).state === "reserved") payments.delete(key);
  }
};

function buildServer() {
  const mcp = new McpServer({ name: "haiku-shop", version: "1.0.0" });
  mcp.tool("ping", "Free. Answers pong.", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
  mcp.tool(
    "haiku",
    `Paid: ${PRODUCT.description} Costs 0.001 USDC on Base Sepolia.`,
    { topic: z.string().min(1).max(60) },
    oncePerPayment(paid(async ({ topic }) => ({
      content: [{ type: "text", text: `${topic} at dawn,\na small payment clears,\nthe poem arrives.` }],
    }))),
  );
  return mcp;
}

// Streamable HTTP with sessions: Haven's buyer needs the Mcp-Session-Id that initialize returns.
const sessions = new Map();
const app = express();
app.use(express.json({ limit: "64kb" }));

app.post("/mcp", async (req, res) => {
  const id = req.get("mcp-session-id");
  let transport = id ? sessions.get(id) : undefined;
  if (!transport) {
    if (req.body?.method !== "initialize") {
      return res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session" }, id: req.body?.id ?? null });
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => sessions.set(sessionId, transport),
    });
    transport.onclose = () => sessions.delete(transport.sessionId);
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});
const bySession = (req, res) => {
  const transport = sessions.get(req.get("mcp-session-id") ?? "");
  return transport ? transport.handleRequest(req, res) : res.status(404).end();
};
app.get("/mcp", bySession);
app.delete("/mcp", bySession);

// Optional: the product list Haven's Products tab reads.
app.get("/.well-known/x402", (_req, res) => res.json({
  version: 1,
  operator: { name: "Haiku shop" },
  name: "Haiku shop",
  network: NETWORK,
  asset: USDC,
  pay_to: PAY_TO,
  products: [PRODUCT],
}));

app.listen(PORT, () => console.log(`listening on ${PORT}; buyers call ${ENDPOINT}`));
```

What to expect when a Haven agent buys `haiku`: the agent's first call gets
the challenge; its second carries the payment; the tool's answer comes back
with the settlement in `_meta`; and a moment later the console prints
`sale report <tx hash> 201`. A resent report gets `200`. A Haven buyer
must be another Haven user's agent with an open budget: a payment from one of
the Sales account owner's own agents shows on the Sales page as a move between
the owner's accounts, not a sale.

## What the Sales key can and cannot do

The key is receive-only: it can report sales and nothing else. It cannot move
money, sign, or change signers, budgets or agents. Its limits, and how
revocation works, are in
[`docs/security/merchant-key-limits.md`](../security/merchant-key-limits.md).
