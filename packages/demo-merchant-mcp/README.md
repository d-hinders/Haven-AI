# @haven_ai/demo-merchant-mcp

Internal x402 demo merchant MCP server for Haven. It exposes a small fake
merchant catalog, gates purchases with standard x402 `PAYMENT-SIGNATURE`,
supports ERC-7710 and EIP-3009 settlement options for Base USDC, and returns
Swedish invoice-style output.

This package is a technical demo for a merchant-controlled wallet, not a Haven
custody, facilitator, acquiring, fiat/card, third-party merchant settlement, or
merchant-of-record product. Funds do not flow through Haven.

## What It Demonstrates

- MCP tools that return x402 payment requirements when no valid payment header
  is present.
- Base USDC x402 `exact` payments using ERC-7710 smart-account delegation or
  EIP-3009 authorization.
- Standard x402 headers: `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, and
  `PAYMENT-RESPONSE`.
- Haven compatibility: `X-PAYMENT` is accepted as an alias for
  `PAYMENT-SIGNATURE` while Haven SDK clients transition.
- Merchant self-settlement with EIP-3009 `transferWithAuthorization`; the
  submitter key only pays gas and does not need to be the receiving wallet.
- ERC-7710 settlement by simulating and submitting `redeemDelegations` against
  an operator-configured trusted DelegationManager. The submitter key is the
  redeemer; it is not a Haven key and cannot spend without a buyer-signed
  delegation that allows the merchant payment.
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

Every product advertises x402 capability metadata through `list_products`:

- `network`: `eip155:8453` on prod/mainnet, or `eip155:84532` when configured for dev/testnet
- `asset`: USDC
- `settlement_methods`: `erc7710`, `eip3009` when both are enabled
- `default_settlement_method`: `erc7710` when enabled
- `resource_url`: the configured merchant MCP URL

Purchase tools accept an optional `settlement_method` argument:

- omitted: uses `erc7710` when enabled
- `erc7710`: pays directly from a smart account through the configured DelegationManager
- `eip3009`: uses the EIP-3009 fallback path

Payment requirements include both `accepts[]` options and put the selected
method first, so clients can discover both methods before purchase and still
honor an explicit caller preference.

## Hosted URLs

Use the hosted merchant URL for partner or agent runtime testing. Use localhost
only when you are intentionally running this package on your machine.

| Environment | MCP URL |
|---|---|
| Production demo merchant | `https://enthusiastic-blessing-production-171f.up.railway.app/mcp` |
| Hosted dev demo merchant | Set `BASE_URL` to that deployment's public origin and use `${BASE_URL}/mcp` |
| Local-only merchant | `http://localhost:3456/mcp` |

Hosted deployments fail startup when `BASE_URL` is missing, so generated
requirements and tool metadata do not point prod agents at localhost.

## Run

```sh
MERCHANT_ADDRESS=0xYourBaseUsdcReceivingWallet \
BASE_RPC_URL=https://base-mainnet.example/rpc \
SETTLEMENT_PRIVATE_KEY=0xGasFundedSubmitterPrivateKey \
MERCHANT_X402_SETTLEMENT_METHODS=erc7710,eip3009 \
MERCHANT_ERC7710_DELEGATION_MANAGER=0xTrustedDelegationManager \
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

`MERCHANT_X402_SETTLEMENT_METHODS` defaults to `erc7710,eip3009`. If `erc7710`
is enabled, `MERCHANT_ERC7710_DELEGATION_MANAGER` is required and must point to
the single DelegationManager this merchant trusts on the configured chain. Set
`MERCHANT_X402_SETTLEMENT_METHODS=eip3009` for an EIP-3009-only fallback or
local-only merchant.

**`MERCHANT_CHAIN_ID`** selects the chain (default `8453`, Base mainnet). Set it
to **`84532`** for a **Base Sepolia** testnet deploy — e.g. the dev instance used
by the QA harness (#575). On Base Sepolia the merchant uses Circle's testnet USDC
(`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) and the correct per-chain EIP-712
domain name (`"USDC"` vs mainnet's `"USD Coin"`). `BASE_RPC_URL` must point at the
matching chain's RPC (Base mainnet, or `https://sepolia.base.org` for Sepolia),
and `SETTLEMENT_PRIVATE_KEY` must be gas-funded on that chain.

## ERC-7710 Smart-Account Payments

ERC-7710 is the preferred demo flow when the required DelegationManager is
configured for the selected Base environment. Startup fails clearly if
`erc7710` is enabled without `MERCHANT_ERC7710_DELEGATION_MANAGER`, so prod
does not hide products behind missing contract prerequisites.

A smart account (the **delegator**) pays by presenting a signed ERC-7710
delegation instead of an ECDSA authorization; the payload carries `delegator`,
`delegationManager`, and `permissionContext`. There is no signature recovery:
the merchant **verifies by simulating**
`delegationManager.redeemDelegations([permissionContext], [mode],
[executionCallData])` (the calldata encodes `USDC.transfer(merchant, amount)`),
then settles by submitting that same call from `SETTLEMENT_PRIVATE_KEY`.

Because the merchant self-settles, the settlement key is the **redeemer** — a
delegation with a redeemer caveat must name the settlement account. Each
delegation settles at most one product here (in-process dedupe keyed on the
`permissionContext` hash); scoping of token, amount, recipient, and expiry is
enforced on-chain by the delegation's caveats.

## Smoke Tests

Discovery:

```sh
curl -fsS https://enthusiastic-blessing-production-171f.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_products","arguments":{}}}'
```

Default ERC-7710 quote:

```sh
curl -i -sS https://enthusiastic-blessing-production-171f.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"buy_vpn","arguments":{"plan":"basic"}}}'
```

Explicit EIP-3009 fallback quote:

```sh
curl -i -sS https://enthusiastic-blessing-production-171f.up.railway.app/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"buy_vpn","arguments":{"plan":"basic","settlement_method":"eip3009"}}}'
```

The payment retry must reuse the same MCP request and include a
`PAYMENT-SIGNATURE` or `X-PAYMENT` header signed by the buyer wallet or agent
runtime. The merchant cannot spend from a Haven wallet or agent budget with an
API credential alone.

## Test With Haven

1. Create a Haven agent with a small Base USDC agent budget.
2. Connect the agent through hosted MCP or a direct SDK/MCP integration.
3. Ask the agent to list products, inspect the price, and buy one product.
4. The merchant returns an x402 challenge.
5. Haven funds and tracks the budget-constrained leg when needed.
6. The agent signs the merchant payment header with its own wallet or agent
   runtime key and retries the same request with `PAYMENT-SIGNATURE` or Haven's
   compatible `X-PAYMENT` alias.
7. The merchant settles the selected method, returns `PAYMENT-RESPONSE`, and
   includes the settlement tx in the invoice.

Keep the amount tiny and demo-only. Do not use this package for third-party
merchant acceptance, merchant dashboards, fees, fiat/card, swaps, refunds, or
production settlement without separate product, legal, and security review
under [`docs/regulatory/casp-risk-guardrails.md`](../../docs/regulatory/casp-risk-guardrails.md).
