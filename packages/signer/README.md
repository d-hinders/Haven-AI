# @haven_ai/signer

The Haven **edge signer**. It holds the delegate key locally and signs — and
that's all it does. It pairs with the hosted, keyless `@haven_ai/mcp-server`:
the hosted server constructs and relays, this signs. The key never leaves this
process, and only signatures (and the standard x402 header) ever come out.

Design: [`docs/architecture/07-edge-signer.md`](../../docs/architecture/07-edge-signer.md).
Contract: [`docs/architecture/06-hosted-mcp-connect-flow.md`](../../docs/architecture/06-hosted-mcp-connect-flow.md).

## Two ways to use it

**As a local MCP signer** (for Claude Desktop / Code / Cursor) — run it
alongside the hosted Haven connection:

```sh
HAVEN_DELEGATE_KEY=0x... npx @haven_ai/signer
# or
npx @haven_ai/signer --credentials /path/to/haven-agent.json
```

On first launch, the signer prints the delegate address, any wallet/network
metadata found in the credential file, and the sign-only tool list. It refuses
to start until acknowledged with either `HAVEN_SIGNER_ACK=<hash>` or
`npx @haven_ai/signer --credentials /path/to/haven-agent.json --ack`.

It exposes two stdio MCP tools:

| Tool | Does | Emits |
|---|---|---|
| `haven_sign` | Sign the `payload_hash` from `haven_pay` / `haven_x402_authorize`; for x402, record `x402.expected` and return a binding | `{ signature }` or `{ signature, x402_binding }` |
| `haven_x402_sign_header` | Build + sign the EIP-3009 `X-PAYMENT` header only when `payment_required` matches the recorded `x402_binding` | `{ payment_header }` |

**As a library** (for SDK / autonomous agents):

```ts
import { createEdgeSigner } from '@haven_ai/signer'

const signer = createEdgeSigner(process.env.HAVEN_DELEGATE_KEY!)
const signature = signer.signPaymentHash(payloadHash)
const funding = signer.signX402FundingHash(payloadHash, {
  resourceUrl,
  merchantTo,
  amount,
  asset,
  network,
  auth,
})
const { paymentHeader } = await signer.buildX402PaymentHeader(paymentRequired, funding.x402Binding)
```

## Orchestration

```
hosted:  haven_pay              -> { payment_id, payload_hash }
local:   haven_sign             -> { signature }
hosted:  haven_submit           -> { status, tx_hash }
```

x402 (two delegate signatures, both local):

```
hosted:  haven_x402_authorize   -> { payment_id, payload_hash, x402.expected }
local:   haven_sign + expected  -> funding signature + x402_binding
hosted:  haven_submit           -> funds Safe -> delegate EOA
local:   haven_x402_sign_header -> X-PAYMENT header only if binding matches
agent:   retry merchant with X-PAYMENT
```

For x402, pass `x402.expected` from the hosted `haven_x402_authorize` response
unchanged into the local `haven_sign` call. The signer records that context and
returns a process-local `x402_binding`; pass that binding into
`haven_x402_sign_header` after `haven_submit` confirms. The signer refuses to
authorize the merchant header when the fresh merchant challenge has a different
amount, merchant recipient, resource URL, token asset, or network than the
recorded funding intent, and consumes the binding after one successful header.
The expected context must also carry Haven's `auth` signature; configure
`HAVEN_X402_BINDING_SIGNER` (or `x402_binding_signer` in the credential file) so
the signer can reject locally invented or tampered x402 contexts before signing
the funding hash.

## Custody

The delegate key is read from `HAVEN_DELEGATE_KEY` or a `--credentials` file's
`delegate_key` (with a permissive-file warning). It stays in this process. The
signer makes no network calls — it can't leak the key to Haven or anyone else.
It needs no `api_key`: identity lives with the hosted connection, not here.

## Local audit

Every MCP signing operation appends a JSONL row locally. File-backed runs write
next to the credential as `<credential>.signer-audit.jsonl`; env-only runs use
`~/.haven/signer-audit.jsonl`. Rows include timestamp, tool, payload hash, and
delegate address. They never include the delegate key, signature, or x402
payment header.

## Hot-wallet minimization

Standard x402 briefly funds the delegate EOA before the merchant settles the
EIP-3009 authorization. Keep delegate balances transient: use small/reset-bound
x402 allowances, retry the original merchant session only after funding
confirms, and reconcile or sweep stranded delegate balances when the merchant
retry fails or does not settle before authorization expiry.
