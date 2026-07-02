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

## Experimental: ERC-7710 smart-account payments (testnet-only)

`MERCHANT_X402_ERC7710=1` enables the x402 exact-EVM `assetTransferMethod:
'erc7710'` rail (#747, part of the epic #452 smart-account-settlement
prototype). It is **testnet-only**: startup fails unless `MERCHANT_CHAIN_ID=84532`
(Base Sepolia), so a mainnet deploy can never advertise it. It also requires
`MERCHANT_ERC7710_DELEGATION_MANAGER` — the single DelegationManager contract
this merchant trusts. The payload's `delegationManager` is attacker-supplied,
and simulating an untrusted contract proves nothing (a no-op contract would
"succeed" without moving USDC), so payments naming any other contract are
rejected before simulation.

When enabled, the 402 challenge advertises a second `accepts` entry with
`extra.assetTransferMethod: 'erc7710'` (the default EIP-3009 entry stays first
and unchanged). A smart account (the **delegator**) pays by presenting a signed
ERC-7710 delegation instead of an ECDSA authorization; the payload carries
`delegator`, `delegationManager`, and `permissionContext`. There is no signature
recovery: the merchant **verifies by simulating**
`delegationManager.redeemDelegations([permissionContext], [mode],
[executionCallData])` (the calldata encodes `USDC.transfer(merchant, amount)`),
then settles by submitting that same call from `SETTLEMENT_PRIVATE_KEY`.

Because the merchant self-settles, the settlement key is the **redeemer** — a
delegation with a redeemer caveat must name the settlement account. Each
delegation settles at most one product here (in-process dedupe keyed on the
`permissionContext` hash); scoping of token, amount, recipient, and expiry is
enforced on-chain by the delegation's caveats.

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
