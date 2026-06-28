# @haven_ai/demo-merchant-mcp

Internal x402 demo merchant MCP server for Haven. It exposes a small fake
merchant catalog, gates purchases with standard x402 `PAYMENT-SIGNATURE`,
self-settles Base USDC EIP-3009 authorizations to the configured merchant
wallet, and returns Swedish invoice-style output.

This package is a technical demo for a merchant-controlled wallet, not a Haven
custody, facilitator, acquiring, fiat/card, third-party merchant settlement, or
merchant-of-record product. Funds do not flow through Haven.

## What It Demonstrates

- MCP tools that return x402 payment requirements when no valid payment header
  is present.
- Base USDC x402 `exact` payments using EIP-3009 authorization.
- Standard x402 headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
  `PAYMENT-RESPONSE`.
- Haven compatibility: `X-PAYMENT` is accepted as an alias for
  `PAYMENT-SIGNATURE` while Haven SDK clients transition.
- Merchant self-settlement with `transferWithAuthorization`; the submitter key
  only pays gas and does not need to be the receiving wallet.
- Tiny test prices for repeatable agent-payment demos.
- In-process duplicate/nonce handling and payment verification before tool
  handlers run.
- Swedish invoice text and JSON output after a settled purchase.

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
BASE_RPC_URL=https://base-mainnet.example/rpc \
SETTLEMENT_PRIVATE_KEY=0xGasFundedSubmitterPrivateKey \
BASE_URL=http://localhost:3456 \
PORT=3456 \
npm run dev -w packages/demo-merchant-mcp
```

Endpoints:

- `POST /mcp` - MCP endpoint and x402-gated resource
- `GET /healthz` - liveness

`MERCHANT_ADDRESS` is required and must be the Base address that receives USDC.
`SETTLEMENT_PRIVATE_KEY` is the gas-funded key that submits USDC
`transferWithAuthorization`; it does not need to be the receiving wallet and
should not hold user or agent funds.

**`MERCHANT_CHAIN_ID`** selects the chain (default `8453`, Base mainnet). Set it
to **`84532`** for a **Base Sepolia** testnet deploy — e.g. the dev instance used
by the QA harness (#575). On Base Sepolia the merchant uses Circle's testnet USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) and the correct per-chain EIP-712
domain name (`"USDC"` vs mainnet's `"USD Coin"`). `BASE_RPC_URL` must point at the
matching chain's RPC (Base mainnet, or `https://sepolia.base.org` for Sepolia),
and `SETTLEMENT_PRIVATE_KEY` must be gas-funded on that chain.

## Test With Haven

1. Create a Haven agent with a small Base USDC agent budget.
2. Connect the agent through hosted MCP or a direct SDK/MCP integration.
3. Ask the agent to list products, inspect the price, and buy one product.
4. The merchant returns an x402 challenge.
5. Haven funds and tracks the budget-constrained leg when needed.
6. The agent signs the merchant payment header and retries the same request
   with `PAYMENT-SIGNATURE` or Haven's compatible `X-PAYMENT` alias.
7. The merchant submits `transferWithAuthorization`, waits for confirmation,
   returns `PAYMENT-RESPONSE`, and includes the settlement tx in the invoice.

Keep the amount tiny and demo-only. Do not use this package for third-party
merchant acceptance, merchant dashboards, fees, fiat/card, swaps, refunds, or
production settlement without separate product, legal, and security review
under [`docs/regulatory/casp-risk-guardrails.md`](../../docs/regulatory/casp-risk-guardrails.md).
