---
owner: "@d-hinders"
status: research
covers: []  # narrative — a dated field record of a production run, no direct code mirror
last-verified: "2026-10-07"
---

# Field test: production x402 purchases (CloudNest and Bitrefill), 2026-10-06 → 07

A live test on **Haven production, Base mainnet (chain 8453), real USDC**. An
agent in Claude Code (desktop app) was connected through the connector with
the default topology (hosted MCP plus the local `@haven_ai/signer@0.8.0-alpha.0`).
It then bought through three paths:

1. a Haven-catalog MCP merchant (the CloudNest demo store);
2. a third-party plain-HTTP x402 merchant (Bitrefill), **without an account**,
   from search through delivered gift-card code;
3. the same Bitrefill product **through Bitrefill's own account MCP**, with
   Haven paying the single invoice.

All three worked end to end, and every payment settled and was verified on
chain. The findings became issues, listed in [§6](#6-findings-and-where-they-went).

This is a point-in-time record. Tool counts, step lists and behaviour describe
the code deployed on 2026-10-07; later changes (for example #3727) shorten
some flows. Secrets are omitted on purpose: gift-card codes, PINs, API keys,
setup tokens, local credential paths and recipient details. Addresses and
transaction hashes are public on-chain data and are kept as evidence.

## 1. Setup

| Field | Value |
|---|---|
| Treasury (`accountAddress`, Hybrid DeleGator) | `0xA83bAf3eC8a6B5Cc30A9e1E83402067258Be13C2` |
| Delegate EOA (local signer key) | `0x2aa432FB92e43Cb9ddA2433F62825e8bCC92deC1` |
| Delegate account (ERC-7710 delegator) | `0xb6fE4Ca53219049b828034eBEDdAE3c90414948b` |
| Budget | 5 USDC per 1440 min (daily), open recipient |
| Budget delegation hash | `0x1e9ca04b7aefd8778f1f185a06a62c637adb4b89cc658c7d38e86efe5a487045` |
| Execution rail | `delegation` |

**Connect.**
- The first `--json` run refused with `wiring_collision`: the machine was
  already wired to another agent on the default server names. The refusal gave
  a `suggested_name` and left the setup token unused, which is correct
  behaviour.
- A re-run with `--name` was blocked by Claude Code's auto-mode safety
  classifier as "Unauthorized Persistence", so the user ran it in a terminal.
  That matches Haven's own design: the `wiring_collision` refusal tells an AI
  agent to hand the choice to its user rather than add the flag itself. Do
  not treat the block as something to work around.
- Runtime detection failed in the desktop app's terminal pane, and the picker
  pre-selected Codex (#3732).
- Setup then completed: keys were minted locally, the MCP entries were written
  and handshake-checked, and the `haven-pay` skill was installed.
- The Claude Code session had to restart to load the new servers.
- The connector also warned about seven older local agent directories with
  live keys. Setup does not revoke them.

## 2. Path A: Haven catalog MCP merchant (CloudNest)

| Step | Tool | Result |
|---|---|---|
| Discover | `haven_discover_tools {search:"storage"}` | 3 CloudNest tiers; 200 GB = catalog `df5b357d-be31-4d08-8dc4-a27ae0b292c5`, `is_test_merchant: true` |
| Quote | `haven_quote_catalog_purchase` | 0.0015 USDC, `expected_settlement_scheme: erc7710`, no funding leg |
| Prepare | `haven_prepare_catalog_purchase {max_amount_human:"0.0015"}` | payment `e268f4e0-cb12-4315-8db5-6ee52f10cc55` |
| Sign | `haven_sign {payment_id}` (signer) | signature |
| Settle | `haven_settle_mcp_tool {payment_id, signature}` | `settled: true`, `delivered: true` |

- Settlement tx `0xd414a660a237dcc59dade1bb5fa8afd6d4094e4a0631650b654872ac5ebc353e`.
- Merchant `0x0C0643655222c1f82a656Fb268154137b5fa6e95`, facilitator
  `0x55C9d84427756D6f82480427Bb778F6dc0cC755E`.
- The merchant invoice names the **delegate account** (`0xb6fE…948b`) as
  payer, which `haven_get_payment_status.parties` confirms. On erc7710 the
  payer is the delegate account; on eip3009 (path B) it is the delegate EOA.
- The signed receipt verified with `haven_verify_receipt`
  (`verifiedOver: delegation_digest`), but only after the agent unwrapped
  `.receipt` and fetched the bundle with its API key outside MCP. Fixed by #3730
  (closes #3723): merged to `dev` on 2026-10-07, not yet in production on
  that date.

Five tool calls. On 2026-10-07 this was the cleanest flow.

## 3. Path B: Bitrefill without an account (plain-HTTP x402)

Bitrefill is not in Haven's catalog. Its x402 API is documented in
[`bitrefill/agents`](https://github.com/bitrefill/agents)
(`skills/bitrefill/references/touchpoints/x402.md`).

| Method | Route | Price without a session token (USDC) |
|---|---|---|
| GET | `/x402/gift-cards/search?q=&country=` (also `/esims/search`, `/topups/search`) | 0.002 |
| GET | `/x402/products/detail?slug=` | 0.001 |
| POST | `/x402/invoice/create` `{"items":[{"product_id","package_value","refill_input?"}]}` | 0.002 |
| POST | `/x402/invoice/pay` `{"invoice_id"}` | invoice amount |
| GET | `/x402/invoice/status?invoice_id=` | 0.001 |
| POST | `/x402/connect` (sign-in, session token of about 2 h) | free |

- The base URL is `https://api.bitrefill.com`, and the Base `payTo` is
  `0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A`.
- A sign-in session token waives every fee except `invoice/pay`.
- Haven quoted every route as `eip3009` with a funding leg: Bitrefill does not
  advertise erc7710.

**Per-request sequence (7 steps on 2026-10-07):**
1. `haven_quote_x402`
2. `haven_pay_x402_quote`
3. `haven_sign_x402` (signer)
4. `haven_submit` (funding)
5. the agent's own HTTP retry, with both `PAYMENT-SIGNATURE` and `X-PAYMENT`
6. `haven_report_x402_outcome`
7. `haven_report_settlement_evidence` (with `PAYMENT-RESPONSE.transaction`)

Trimming `payment_required` to the Base `accepts` entry before step 2 worked.

| # | Call | Haven payment | Funding tx | Settlement tx | USDC |
|---|---|---|---|---|---|
| 1 | search `q=bik bok&country=SE` | `dc217bdf-0b64-45ad-bfad-6e45ef010d30` | `0x5c7745a7888783fca19331c436dc5bdc5202996c8d6bc97ef3821b3d49494713` | `0x2209034166b9847c349a0e6cb39beff3e1b3dbff284428229764298b3c8d18d8` | 0.002 |
| 2 | detail `slug=bikbok-sverige-sweden` | `b6f72965-539d-4e92-bdfa-89c3f724ded2` | `0xbeed3465151bb6f97d51ac115d45c4f06d52041822efde33e93447b53df80df6` | `0x48a5103bc9cd1be23a973b4cf4309ecf9098185b7ea2d8efd89e40dac7889e01` | 0.001 |
| 3 | invoice/create 1 SEK (expired unpaid) | `eb96f823-e4ad-462d-b61d-c78fe5eaa8d4` | `0x7a13a67495afab4cdac6f79b5f3504654b18b1cc97bab84c0e750354f9d256d4` | `0x9be7e38818ee8e0afd2282f86ff9df4acb7630294a32b204922cbe469cd653cb` | 0.002 |
| — | invoice/pay (refused at prepare: treasury underfunded, #3731) | — | — | — | 0 |
| 4 | invoice/create 1 SEK | `3ae306e9-f48b-43df-b6db-e4c08c1c8ad7` | `0x80ae851644afb90f80cc82d132317af70e0b287b2642e1887c00e4ab4c1dbe25` | `0xded89ac3e3cb9818c900a186e3f373b514c35f0a5769bd9ee7a2f8fc172b0887` | 0.002 |
| 5 | invoice/pay | `8933630d-8b40-4125-bd05-7764505c00a6` | `0xeb86cbb368a52ac0cba7561c45db8bbeb5e4153ed7410874eac6eb8a724b7335` | `0x2d88dddda847302bd4b56cd99ecaeb1eefce96368dcbef6d4e342a26f74fee3b` | 0.100 |
| 6 | invoice/status | `22b25d6e-57f1-4aff-9b00-5c22d49abc40` | `0xc137056d22e151d6186dcf04731c49f72e21094790157dcbd6a651dcac0baf2c` | `0xe4c35a973e0b65f9d771e015d78991dff84f45bf979aca9de145d44d4e85f8a9` | 0.001 |
| | **Total** | | | | **0.108** |

**Product facts.**
- `bikbok-sverige-sweden` is priced in SEK with `recipient_type: none`.
- Custom `package_value` runs 0.01–2000 SEK in steps of 0.01.
- 1 SEK priced at 0.10 USDC, the minimum after rounding.
- Invoices on this path expire after 15 minutes.

**Delivery.**
- The card was delivered about 1.5 minutes after payment.
- The first paid `invoice/status` returned `all_delivered` with the code in
  `redemption_info`, without sign-in. Probably the paid status call, from the
  same payer EOA, counted as proof of payment, but Bitrefill has not
  confirmed this.
- On this path the code arrives **only** in that JSON response: there is no
  email option (`invoice/create` takes no recipient).

**Payer identity.** On the eip3009 path Bitrefill sees the delegate EOA
(`0x2aa4…deC1`) as payer on every call.

## 4. Path C: Bitrefill with an account (Bitrefill's MCP)

Bitrefill's MCP (`https://api.bitrefill.com/mcp`) was added to Claude Code
with OAuth (`claude mcp add --transport http …`, then authenticated in an
interactive terminal, then a session restart). It exposes 12 tools, including
`search-products`, `get-product-details`, `buy-products`, `get-invoice-by-id`,
`list-invoices` and `get-balances`.

| Step | Tool | Cost | Result |
|---|---|---|---|
| Search | `search-products {query:"bik bok", country:"SE"}` | free | `bikbok-sverige-sweden` |
| Details | `get-product-details {currency:"USDC"}` | free | 400 SEK = 39.80 USDC; custom 0.01–2000 SEK |
| Invoice | `buy-products {cart_items:[{product_id, package_value:"1", gift:{…}}], payment_method:"usdc_base", return_payment_link:true}` | free | invoice `68951791-d568-41fc-b6c4-9cdf0220cbaa`, 0.10 USDC, 60-minute expiry. Returns `x402_payment_url` (`https://api.bitrefill.com/x402/invoice/pay`, the same endpoint as path B), a direct deposit address, and a web payment link |
| Pay | Haven plain-HTTP x402 flow on `x402_payment_url` with body `{"invoice_id"}` | 0.10 USDC | payment `552d5f1a-6712-4b51-94ca-517764cb25e6`, funding `0x5e6840f64915914ce570ade5c82897b9560033decfb9e7474352a9a2ea975931`, settlement `0x1ed9c3acd404995afc1f98679f651e8fdafdec542eaef7e5eed71d430d633b4b`, settled |
| Delivery | `get-invoice-by-id` | free | `complete` / `all_delivered` about 1 s after payment confirmed |

- Bitrefill recorded the x402 settlement transaction as the invoice's incoming
  `usdc_base` payment.
- The gift email reached the recipient, the order confirmation reached the
  account email, and the order appears in the account history.
- **One paid step**: browsing, invoicing and status checks are free with an
  account. The single payment still runs the full plain-HTTP x402 flow.
- **The agent had to work out the hand-off itself.** A merchant's own MCP
  returned an x402 payment URL plus a request body, and the agent had to see
  that it should pay that URL through Haven's x402 tools rather than the raw
  deposit address. Haven's guidance does not cover that hand-off (#3735).
- **Field-shape quirk (Bitrefill side).** In the MCP's `redemption_info` the
  value code is in `pin`, and the PIN is in `other` / `extraFields["PIN Code"]`.
  The x402 API uses `code` + `pin`. Parsers should handle both shapes.

## 5. Bitrefill sign-in challenge (unsigned probe)

An unsigned `POST https://api.bitrefill.com/x402/connect` on 2026-10-07
returned HTTP 402 with an x402 v2 `PAYMENT-REQUIRED` header, `accepts: []`, and
`extensions["sign-in-with-x"]`:

- **`info`** fields: `domain`, `uri`, `version` `"1"`, `nonce`, absolute
  `issuedAt` / `expirationTime` (5 minutes apart), `resources`, `statement`.
- **`supportedChains`** is an array of `{chainId, type}` objects: Base 8453,
  Arbitrum 42161, Polygon 137 with `eip191`, and Solana with `ed25519`.
- **Response header.** The resource description asks for base64 JSON of the
  **decomposed** fields (`domain, address, uri, version, chainId, type, nonce,
  issuedAt, signature`) in the `SIGN-IN-WITH-X` header, not
  `{message, signature}`.
- **Signature types.** It states that EIP-1271 and EIP-6492 smart-wallet
  signatures are accepted.

This is the reference fixture for #3728.

## 6. Findings and where they went

| Finding | Issue |
|---|---|
| `haven_get_agent` reports `ready` while the treasury cannot cover a payment; the underfunded prepare was misdiagnosed as a caveat revert | #3731 |
| `haven_verify_receipt` rejected the receipt endpoint's own response; no MCP tool returned the signed bundle | #3723 (fix merged to `dev` in #3730; not in production as of 2026-10-07) |
| A plain-HTTP x402 payment takes 7 steps, with manual base64 decoding and header-name choice | #3727 (in-perimeter; the hosted "Haven calls the merchant" alternative stays closed, #3249) |
| No sign-in-with-x signing, so Bitrefill browsing costs a payment per call, and codes may need sign-in | #3728 |
| The connector's runtime picker pre-selects the first client; a Codex config outranks Claude Code by construction | #3732 |
| No guidance for paying an x402 URL that another MCP hands back | #3735 |
| `next_tool` names the default server names under `--name` | not filed (documented behaviour; `next_tool_server_role` helps) |
| Claude Code's auto-mode classifier blocks re-running the connector | not filed: consistent with the `wiring_collision` design, where the user runs the command |

## 7. Open questions

1. Why the first paid `invoice/status` returned the code without sign-in, and
   whether Bitrefill guarantees it. Not confirmed with Bitrefill.
2. Whether a repeat paid `invoice/status` returns the code again (lost-code
   recovery). Not tested.
3. The payer address differs by scheme: the delegate account on erc7710, the
   delegate EOA on eip3009. This is not yet documented for merchants.
