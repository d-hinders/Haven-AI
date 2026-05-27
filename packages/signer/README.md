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

It exposes two stdio MCP tools:

| Tool | Does | Emits |
|---|---|---|
| `haven_sign` | Sign the `payload_hash` from `haven_pay` / `haven_x402_authorize` | `{ signature }` |
| `haven_x402_sign_header` | Build + sign the EIP-3009 `X-PAYMENT` header for the merchant leg | `{ payment_header }` |

**As a library** (for SDK / autonomous agents):

```ts
import { createEdgeSigner } from '@haven_ai/signer'

const signer = createEdgeSigner(process.env.HAVEN_DELEGATE_KEY!)
const signature = signer.signPaymentHash(payloadHash)
const { paymentHeader } = await signer.buildX402PaymentHeader(paymentRequired)
```

## Orchestration

```
hosted:  haven_pay              -> { payment_id, payload_hash }
local:   haven_sign             -> { signature }
hosted:  haven_submit           -> { status, tx_hash }
```

x402 (two delegate signatures, both local):

```
hosted:  haven_x402_authorize   -> { payment_id, payload_hash, x402 }
local:   haven_sign             -> funding signature
hosted:  haven_submit           -> funds Safe -> delegate EOA
local:   haven_x402_sign_header -> X-PAYMENT header
agent:   retry merchant with X-PAYMENT
```

## Custody

The delegate key is read from `HAVEN_DELEGATE_KEY` or a `--credentials` file's
`delegate_key` (with a permissive-file warning). It stays in this process. The
signer makes no network calls — it can't leak the key to Haven or anyone else.
It needs no `api_key`: identity lives with the hosted connection, not here.
