# @haven_ai/signer

The Haven **edge signer**. It holds the delegate key locally and signs — and
that's very nearly all it does. It pairs with the hosted, keyless
`@haven_ai/mcp-server`: the hosted server identifies the agent, constructs
unsigned payloads and relays signatures; this one signs. **The delegate key
never leaves this process** — it is not part of any request or response, and
only signatures (and the standard x402 `X-PAYMENT` header) ever come out.

Design: [`docs/architecture/07-edge-signer.md`](../../docs/architecture/07-edge-signer.md).
Contract: [`docs/architecture/06-hosted-mcp-connect-flow.md`](../../docs/architecture/06-hosted-mcp-connect-flow.md).

Requires **Node >= 22**; the signer refuses to start on anything older, before
it reads a key.

## Two ways to use it

**As a local MCP signer** (for Claude Desktop / Code / Cursor) — run it
alongside the hosted Haven connection. The supported install is the connector
the Haven dashboard hands out, which writes the MCP config and pins the
runtime:

```sh
npx @haven_ai/connect@alpha
```

Rerunning it is also the documented fix for a signer that has fallen behind the
backend's expected-context version. To run the signer directly:

```sh
HAVEN_DELEGATE_KEY=0x... npx @haven_ai/signer
# or
npx @haven_ai/signer --credentials /path/to/haven-agent.json
```

On first launch, the signer prints the delegate address, any wallet/network
metadata found in the credential file, and the sign-only tool list. It refuses
to start until acknowledged with either `HAVEN_SIGNER_ACK=<hash>` or
`npx @haven_ai/signer --credentials /path/to/haven-agent.json --ack`.

It exposes four stdio MCP tools, all sign-only:

| Tool | Does | Emits |
|---|---|---|
| `haven_sign` | Sign one payment. Preferred form is `{ payment_id }` alone — the signer fetches the exact payload itself. Signs an EIP-712 typed-data payload on the delegation rail (a redemption, or an erc7710 settlement child), or a bare `payload_hash` on a v1 context; for the EIP-3009 x402 bridge it also records the funding context and returns a binding | `{ signature }` or `{ signature, x402_binding }` |
| `haven_sign_x402` | One-shot x402: funding signature **and** the merchant header in a single local call (`haven_sign` + `haven_x402_sign_header`). `{ payment_id }` alone is the preferred call | `{ signature, x402_binding, payment_header, accepted }` |
| `haven_x402_sign_header` | Build + sign the EIP-3009 `X-PAYMENT` header, only when the fresh merchant `payment_required` matches the recorded `x402_binding` | `{ payment_header, accepted }` |
| `haven_sign_sweep_delegate` | Sign a Haven-prepared gasless EIP-3009 sweep that recovers stranded funds from the delegate wallet back to your own account. Never broadcasts | `{ signature }` |

The `initialize` handshake advertises which binding versions this signer
understands, under `capabilities.experimental['haven/signer-compatibility']`
and in the MCP `instructions` string. Both are **derived** from
`SUPPORTED_X402_EXPECTED_VERSIONS` / `SUPPORTED_SWEEP_BINDING_VERSIONS` in
`src/core.ts` — the same constants the signing path enforces — so this README
deliberately does not restate the numbers. Read them from the handshake, or
from those constants.

**As a library** (for SDK / autonomous agents):

```ts
import { createEdgeSigner } from '@haven_ai/signer'

const signer = createEdgeSigner(process.env.HAVEN_DELEGATE_KEY!)

// Delegation-rail direct payment: sign the EIP-712 typed data the account
// validates — not the bare ERC-4337 hash.
const signature = await signer.signDelegationTypedData(typedData)

// x402, EIP-3009 bridge: sign the funding leg, then the merchant header.
const funding = await signer.signX402FundingTypedData(fundingTypedData, expected)
const { paymentHeader } = await signer.buildX402PaymentHeader(
  paymentRequired,
  funding.x402Binding,
)
```

The signer also exposes `signPaymentHash(hash)` (raw ECDSA over a legacy
AllowanceModule funding/transfer hash) and `signX402FundingHash(hash, expected)`
for v1 contexts, and `signSweepAuthorization(input)` for the gasless sweep. All
five are methods on the object `createEdgeSigner` returns, not standalone
exports.

## Orchestration

Direct payment:

```
hosted:  haven_pay                -> { payment_id, payload to sign }
local:   haven_sign               -> { signature }
hosted:  haven_submit             -> { status, tx_hash }
```

On the delegation rail the payload is the EIP-712 typed data the account
validates, not the bare ERC-4337 hash. Note the trust-model asymmetry: this
direct leg has no Haven-signed expected context to verify against, so the
authority boundary is the account's on-chain caveat enforcers rather than a
client-side gate — unlike the x402 legs below.

x402 — **erc7710 direct settlement**, the preferred scheme when the account is
on the delegation rail and the merchant advertises
`extra.assetTransferMethod: "erc7710"`. There is **no funding leg**, so there is
no delegate hot balance and no `haven_x402_sign_header` step:

```
hosted:  haven_pay_x402_quote      -> settlement child + settlement_scheme: erc7710
local:   haven_sign { payment_id } -> child signature (caveats verified locally)
hosted:  haven_submit { settlement_scheme: "erc7710" } -> payment_header
agent:   retry merchant with X-PAYMENT
```

x402 — **EIP-3009 bridge**, the fallback for merchants without facilitator-side
erc7710 support (still most of them). Two local delegate signatures, and a
bounded funding leg:

```
hosted:  haven_pay_x402_quote     -> { payment_id, payload_hash, x402.expected }
local:   haven_sign + expected    -> funding signature + x402_binding
hosted:  haven_submit             -> funds account -> delegate EOA
local:   haven_x402_sign_header   -> X-PAYMENT header only if binding matches
agent:   retry merchant with X-PAYMENT
```

On the bridge, pass `x402.expected` from the hosted quote unchanged into the
local `haven_sign` call, or just pass `{ payment_id }` and let the signer fetch
it. The signer records that context and returns a process-local `x402_binding`;
pass that binding into `haven_x402_sign_header` after `haven_submit` confirms.
The signer refuses to authorize the merchant header when the fresh merchant
challenge has a different amount, merchant recipient, resource URL, token asset
or network than the recorded funding intent, refuses an expired window, and
consumes the binding after one header.

The `X-PAYMENT` header's validity window starts when it is signed, not when
funding confirms — so relay it promptly.

## What the signer refuses to sign

These are local, independent checks. They do not trust Haven's assertion about
what a payload means; they re-derive it.

- **Unauthenticated context.** The expected context must carry Haven's `auth`
  signature over it. Configure `HAVEN_X402_BINDING_SIGNER` (or
  `x402_binding_signer` in the credential file) so the signer can reject
  locally invented or tampered contexts before signing anything.
- **Wrong signing mode.** The *context* selects the path, never the caller's
  arguments: a context that commits to a typed-data digest requires the typed
  data, one that does not requires the bare hash. A mismatch is refused rather
  than signed into an on-chain failure.
- **Another agent's quote.** A context naming a `payer_delegate` that is not
  this signer's own delegate is refused.
- **An unbound delegation payload.** Typed data with `primaryType: "Delegation"`
  is never raw-signed without a context binding it.
- **An erc7710 settlement child whose caveats do not match what Haven declared.**
  The signer re-derives the child's meaning from its own pinned
  `DelegationManager` and caveat-enforcer addresses (cross-checked against
  `@metamask/smart-accounts-kit` by a test, never fetched from Haven, which
  would make the check circular): the payee pin, the exact token and amount,
  the chain, and a settlement window bounded at 600 seconds. Extra caveats are
  allowed — top-level caveats are AND-ed during redemption, so an unrecognised
  one can only add a constraint.
- **A binding version it does not understand.** The refusal is machine-readable
  — `code`, `supported_versions`, `received_version`, `fallback` — and names
  updating the signer as the fix.
- **A sweep that does not move funds out of this delegate's own key** — the
  `from` check is unconditional. The **destination** check is not, and this is
  the one asymmetry in this list: the signer compares the sweep's `to` against
  the account address **only when the local credential records one**
  (`safe_address`). Run with `HAVEN_DELEGATE_KEY` alone — or with a credential
  whose `safe_address` is absent — and there is no local value to compare
  against, so the destination is authenticated by Haven's binding signature and
  the token/chain canonicality check, but not independently re-derived. Prefer
  a credential file that carries the account address.

## Custody

The delegate key is read from `HAVEN_DELEGATE_KEY` or a `--credentials` file's
`delegate_key` (with a permissive-file warning). It stays in this process, and
is never transmitted.

**The signer makes exactly one kind of network call.** Since
[#1263](https://github.com/d-hinders/Haven-AI/issues/1263) it performs an
authenticated, read-only `GET /x402/:payment_id/sign-context` against Haven, so
that agents never have to relay multi-KB EIP-712 payloads through a model's
context window. It reads `api_url` and `api_key` from an `identity.json` sitting
next to the signer credential file — the signer's own credential still needs no
`api_key`. The signer **core** (`src/core.ts`) remains network-free, and fetched
bytes are treated as untrusted input exactly like a tool argument: the same
digest re-derivation and Haven-binding verification apply, because what makes
them safe is the verification, not where they came from. It never relays,
submits, or broadcasts.

Connect Agent 2 may create the signer credential file locally during setup. In
that flow Haven receives the public signing address, proof, API-key hash/prefix,
and install status only; the plaintext API key and delegate key stay in local
protected storage/runtime config.

## Local audit

Every MCP signing operation appends a JSONL row locally. File-backed runs write
next to the credential as `<credential>.signer-audit.jsonl`; env-only runs use
`~/.haven/signer-audit.jsonl`. Rows include timestamp, tool, payload hash and
delegate address, plus the account address and chain id when the credential
carries them. They never include the delegate key, the signature, or the x402
payment header.

## Hot-wallet minimization

This applies to the **EIP-3009 bridge only** — the erc7710 path above has no
funding leg and no delegate balance to strand. On the bridge, the account
briefly funds the delegate EOA before the merchant settles the EIP-3009
authorization. Keep delegate balances transient: keep budgets small and
period-bound, retry the original merchant session only after funding confirms,
and sweep stranded delegate balances (`haven_sign_sweep_delegate`) when the
merchant retry fails or does not settle before authorization expiry.
