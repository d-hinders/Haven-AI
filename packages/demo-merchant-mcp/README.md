# @haven_ai/demo-merchant-mcp

Internal x402 demo merchant MCP server for Haven. It exposes a small fake
merchant catalog, gates purchases with standard x402 `X-PAYMENT`, verifies
Base USDC EIP-3009 payments, and returns Swedish invoice-style output.

This package is a technical demo, not a production merchant settlement,
facilitator, acquiring, fiat/card, or merchant-of-record product. Funds do not
flow through Haven.

## What It Demonstrates

- MCP tools that return x402 payment requirements when no valid payment header
  is present.
- Base USDC x402 `exact` payments using EIP-3009 authorization.
- Tiny test prices for repeatable agent-payment demos.
- Duplicate/nonce handling and payment verification before tool handlers run.
- Swedish invoice text and JSON output after a verified purchase.

## Products

| Product | Tool | Price |
|---|---|---|
| NordShield VPN Basic | `buy_vpn` | 0.001 USDC |
| NordShield VPN Pro | `buy_vpn` | 0.003 USDC |
| NordShield VPN Ultra | `buy_vpn` | 0.005 USDC |
| CloudNest 50 GB | `buy_cloud_storage` | 0.0005 USDC |
| CloudNest 200 GB | `buy_cloud_storage` | 0.0015 USDC |
| CloudNest 1 TB | `buy_cloud_storage` | 0.004 USDC |

## Run

```sh
MERCHANT_ADDRESS=0xYourBaseUsdcReceivingWallet \
BASE_URL=http://localhost:3456 \
PORT=3456 \
npm run dev -w packages/demo-merchant-mcp
```

Endpoints:

- `POST /mcp` - MCP endpoint and x402-gated resource
- `GET /healthz` - liveness

`MERCHANT_ADDRESS` is required and must be the Base address that receives USDC.

## Test With Haven

1. Create a Haven agent with a small Base USDC agent budget.
2. Connect the agent through hosted MCP or a direct SDK/MCP integration.
3. Ask the agent to list products, inspect the price, and buy one product.
4. The merchant returns an x402 challenge.
5. Haven funds and tracks the budget-constrained leg when needed.
6. The agent signs the merchant `X-PAYMENT` header and retries the same request.

Keep the amount tiny and demo-only. Do not use this package as a real merchant
acceptance or settlement surface without separate product, legal, and security
review under [`docs/regulatory/casp-risk-guardrails.md`](../../docs/regulatory/casp-risk-guardrails.md).
