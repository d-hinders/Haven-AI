# @haven_ai/signer

The Haven **edge signer**. It holds the delegate key locally and signs — and
that's very nearly all it does. It pairs with the hosted, keyless
`@haven_ai/mcp-server`: the hosted server identifies the agent, constructs
unsigned payloads and relays signatures; this one signs. **The delegate key
never leaves this process** — it is not part of any request or response, and
only signatures (and the standard x402 merchant payment header) ever come out.

Design: [`docs/architecture/07-edge-signer.md`](../../docs/architecture/07-edge-signer.md).
Contract: [`docs/architecture/06-hosted-mcp-connect-flow.md`](../../docs/architecture/06-hosted-mcp-connect-flow.md).

Requires **Node >= 22**; the signer refuses to start on anything older, before
it reads a key.

## Are you an AI agent whose user has no Haven account yet?

Read **`/for-agents.md`** on the Haven host your user gave you — or
[the copy in this repository](https://github.com/d-hinders/Haven-AI/blob/dev/packages/frontend/public/for-agents.md)
if you do not have that host yet.

Your user creates the account and the passkey: those are theirs, they need a
human, and you should never ask for their password. You can do everything else
— including running the connector command from the setup prompt they paste you,
and managing the account from the shell with `@haven_ai/cli`.

## Two ways to use it

**As a local MCP signer** (for Claude Desktop / Code / Cursor) — run it
alongside the hosted Haven connection. The supported install is the connector
the Haven dashboard hands out, which writes the MCP config and pins the
runtime:

```sh
npx @haven_ai/connect@<channel>
```

`<channel>` is a placeholder: production hands out `@alpha`, and it is the right
answer unless your dashboard hands you a different one — **run the command that dashboard shows
you**, which names the npm dist-tag that backend is paired with. This signer's
own messages do the same: since [#2423](https://github.com/d-hinders/Haven-AI/issues/2423)
every "rerun the connector" hint it prints names the channel THIS build was
published under, so a build installed from a non-production channel tells you
to reinstall from that same channel rather than sending you to production.

Rerunning it is also the documented fix for a signer that has fallen behind the
backend's expected-context version. To run the signer directly:

```sh
HAVEN_DELEGATE_KEY=0x... npx @haven_ai/signer@alpha
# or
npx @haven_ai/signer@alpha --credentials /path/to/haven-agent.json
```

On first launch, the signer prints the delegate address, any wallet/network
metadata found in the credential file, and the sign-only tool list. It refuses
to start until acknowledged with either `HAVEN_SIGNER_ACK=<hash>` or
`npx @haven_ai/signer@alpha --credentials /path/to/haven-agent.json --ack`.

It exposes four stdio MCP tools, all sign-only:

| Tool | Does | Emits |
|---|---|---|
| `haven_sign` | Sign one payment. Preferred form is `{ payment_id }` alone — the signer fetches the exact payload itself. Signs an EIP-712 typed-data payload on the delegation rail (a redemption, or an erc7710 settlement child), or a bare `payload_hash` on a v1 context; for the EIP-3009 x402 bridge it also records the funding context and returns a binding | `{ signature }` or `{ signature, x402_binding }` |
| `haven_sign_x402` | One-shot x402: funding signature **and** the merchant header in a single local call (`haven_sign` + `haven_x402_sign_header`). `{ payment_id }` alone is the preferred call | `{ signature, x402_binding, payment_header, accepted }` |
| `haven_x402_sign_header` | Build + sign the EIP-3009 merchant payment header, only when the fresh merchant `payment_required` matches the recorded `x402_binding` | `{ payment_header, accepted }` |
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

The signer also exposes `signX402FundingHash(hash, expected)` for v1 contexts
and `signSweepAuthorization(input)` for the gasless sweep. All five are methods
on the object `createEdgeSigner` returns, not standalone exports. There is NO
raw-hash primitive: `signPaymentHash(hash)` (raw ECDSA over the retired
AllowanceModule rail's hash) was removed in #3169 — every remaining method
verifies something before it signs, and `haven_sign` called with a bare
`payload_hash` answers `BARE_HASH_REFUSED` with a typed next step instead of a
signature.

**Direct payments (#3271).** A direct payment (`POST /payments`, surfaced as
`haven_send` / `haven_pay`) is signed as the account's EIP-712
`PackedUserOperation`, and Haven returns both that typed data and
`payload_hash` — the ERC-4337 v0.7 UserOperation hash of the same operation.
Before `haven_sign` signs one, it recomputes that hash from the typed data's
own domain, types and message and refuses (`USEROP_BINDING_MISMATCH`) unless
it equals `payload_hash` exactly, in the HybridDeleGator domain of the typed
data's own sender, against the v0.7 EntryPoint. This is a **corruption**
check: the caller supplies both values, so it proves they describe the same
operation, never that Haven prepared it — provenance is `payment_id` (below).
It runs whether the typed data arrived as a tool argument or by the
`payment_id` fetch; a fetched direct context that is not a
`PackedUserOperation` at all is refused by the same check. The x402 EIP-3009
bridge's funding leg keeps its own digest check against the Haven-signed
expected context in this signer (the SDK's `signForData` runs this binding
check there too). The check exists because this typed data is
multi-KB and can reach the signer through a language model relaying it by
hand: one corrupted character used to produce a valid-looking signature over
the wrong digest, surfacing only as an opaque `AA24 signature error` from the
bundler, after the signature was already produced.

## Startup, CLI options and the consent screen (#3173)

**Startup cost.** The signer loads `@haven_ai/sdk/edge` — the ethers-free
subset of the SDK it actually calls (error classes, typed-next-step builder,
x402 message builders, viem-based key helpers) — never the SDK barrel, and it
loads the `x402` package only on the merchant-header leg, on first use. Measured
on the same machine (median of 5 cold runs, macOS, Node 22): `--help` 1.47 s →
0.71 s; the consent refusal 1.55 s → 0.77 s; `import('@haven_ai/sdk')` 1135 ms
versus `import('@haven_ai/sdk/edge')` 385 ms, of which viem is ~330 ms and stays
(the signer signs typed data with it). A loader hook resolving every module at
startup finds zero packages named `ethers` or `x402` (the SDK barrel, as a
positive control, resolves two). Two tests keep it so: `sdk-edge-import.test.ts`
fails if any runtime file imports the barrel or `x402/schemes` statically, and
the SDK's `edge-imports.test.ts` fails if the subpath's import graph ever
reaches ethers, `x402` or the HTTP client.

**CLI.** `--credentials <path>` (alias `--credentials-path`), `--ack`,
`--help`/`-h`. Any other option is
refused with one stderr line naming `--help` and exit code 2 — before #3173 an
unknown flag was silently ignored, so `--ack-local-tools` (the connector's
flag, which the connector's doctor tells you to pass to the *connector*)
produced only the consent wall. `--help` lists every registered tool (pinned
against `toolSchemas`, so a fifth tool cannot drift out of the text) and names
`npx @haven_ai/connect --doctor`.

**Consent screen.** The first-launch block summarises each tool in one
human-sized line (the full agent-facing descriptions are what the runtime sees,
not what a person approves) and ends by naming the connector's doctor for the
connector-wired case, where the doctor shows this as a failed *Signer stdio
handshake* check (the connector's setup outcome reports it as
`local_signer_ack_required`) and the repair is the connector's
`--ack-local-tools`. The refusal an MCP host
relays ("Connection closed" plus this process's exit message) names the same
command. The consent hash covers identity, tool names and the surface version —
not the block's prose — so neither change re-prompts an acknowledged install.

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
agent:   retry merchant, setting PAYMENT-SIGNATURE ONLY (never X-PAYMENT:
         this header carries a delegation chain and duplicating it is
         refused with HTTP 431)
```

x402 — **EIP-3009 bridge**, the fallback for merchants without facilitator-side
erc7710 support (still most of them). Two local delegate signatures, and a
bounded funding leg:

```
hosted:  haven_pay_x402_quote     -> { payment_id, payload_hash, x402.expected }
local:   haven_sign + expected    -> funding signature + x402_binding
hosted:  haven_submit             -> funds account -> delegate EOA
local:   haven_x402_sign_header   -> payment header only if binding matches
agent:   retry merchant, setting BOTH PAYMENT-SIGNATURE + X-PAYMENT
         (both names are correct HERE — the bridged header is small)
```

On the bridge, pass `x402.expected` from the hosted quote unchanged into the
local `haven_sign` call, or just pass `{ payment_id }` and let the signer fetch
it. The signer records that context and returns a process-local `x402_binding`;
pass that binding into `haven_x402_sign_header` after `haven_submit` confirms.
The signer refuses to authorize the merchant header when the fresh merchant
challenge has a different amount, merchant recipient, resource URL, token asset
or network than the recorded funding intent, refuses an expired window, and
consumes the binding after one header.

The merchant payment header's validity window starts when it is signed, not when
funding confirms — so relay it promptly.

## What the signer refuses to sign

(`USEROP_BINDING_MISMATCH`, the #3271 direct-payment refusal, is described
under [Two ways to use it](#two-ways-to-use-it) and in the
[refusal table](#sign-context-refusal-codes).)

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
  — `code`, `supported_versions`, `received_version`, `fallback`, and (#3103)
  `next_tool_omitted_reason` — and names updating the signer as the fix.
- **A sweep that does not move funds out of this delegate's own key** — the
  `from` check is unconditional. The **destination** check is not, and this is
  the one asymmetry in this list: the signer compares the sweep's `to` against
  the account address **only when the local credential records one**
  (`account_address`, or the pre-#2908 `safe_address` / `safeAddress`, which
  are read permanently; from the environment, `HAVEN_ACCOUNT_ADDRESS` only —
  `HAVEN_WALLET_ADDRESS` and `HAVEN_SAFE_ADDRESS` were removed by #2914, so a
  machine still configured through either records no account address and lands
  in exactly the degraded case this paragraph describes). Run with
  `HAVEN_DELEGATE_KEY` alone — or with a credential
  whose account address is absent — and there is no local value to compare
  against, so the destination is authenticated by Haven's binding signature and
  the token/chain canonicality check, but not independently re-derived. Prefer
  a credential file that carries the account address.

## Sign-context refusal codes

`{ payment_id }` calls (`haven_sign` / `haven_sign_x402`) fetch the exact
signing payload from Haven (`GET /x402/:id/sign-context`, and for a direct
payment `GET /payments/:id/sign-context` — see the #3271 paragraph below and
[Custody](#custody)). Every refusal on that fetch is a `HavenSignContextError`
(#3001) — a `HavenSigningError` subclass, so `instanceof HavenSigningError`
still holds everywhere it did before, but structured like the version-mismatch
refusal below rather than prose alone: `code`, `next_action`, and — per
refusal class — `fallback`, `retry_with_new_quote`, `http_status`,
`backend_error_code`. Since #3103 each also carries a typed next step: the
`SIGN_CONTEXT_REFUSED` (other) row names the hosted status read
(`next_tool_server_role: hosted`, `next_tool_name: haven_get_payment_status`,
`next_arguments: { payment_id }` — resolve the role against your own server
names); every other row carries `next_tool_omitted_reason` with the exact
remedy. `message` is unchanged.

**#3271: `haven_sign` (never `haven_sign_x402`) has one escape from this
table.** When the x402 fetch answers `SIGN_CONTEXT_REFUSED` with
`http_status: 409` and `backend_error_code: 'sign_context_unavailable'` — this
`payment_id` names a direct payment, not an x402 intent — `haven_sign` fetches
`GET /payments/:id/sign-context` instead, same auth header, timeout and
refusal structuring. That second fetch's own refusals reuse the codes in the
table below with direct-payment remedies: no quote to re-run, and the
`typed_data_b64` relay from the `haven_send` / `haven_pay` result is the
fallback. A 409 `sign_context_unavailable` from the direct route (an x402 row
the x402 route could not serve) surfaces the x402 route's own refusal
instead. `haven_sign_x402` never takes this branch: a direct payment
carries no x402 context to fund a merchant retry with, so it surfaces the
409 unchanged.

| `code` | When | `next_action` | `fallback` | extra |
|---|---|---|---|---|
| `SIGN_CONTEXT_TIMEOUT` | The fetch (or its body read) did not finish within `SIGN_CONTEXT_TIMEOUT_MS` | `stop_and_tell_user` | `typed_data_b64` | — |
| `SIGN_CONTEXT_UNREACHABLE` | The fetch failed before any response (DNS, connection refused, TLS, …) | `stop_and_tell_user` | `typed_data_b64` | — |
| `SIGN_CONTEXT_MALFORMED` | The response body was missing `sign_data.typed_data` / `x402_expected` (a pre-#1263 backend), or — on the direct-payment fetch — an unsupported `direct_sign_context_version` or a `signature_scheme` other than `eip712_userop` | `stop_and_tell_user` | `typed_data_b64` | — |
| `SIGN_CONTEXT_REFUSED` (410 / `expired`) | x402: the quote's window closed. Direct: the payment's window closed — call `haven_send` / `haven_pay` again with the same `idempotency_key` | `payment_window_expired` | — | x402 only: `retry_with_new_quote: true`; both: `http_status`, `backend_error_code: 'expired'` |
| `SIGN_CONTEXT_REFUSED` (404, direct fetch) | The `payment_id` is not this agent's, or the backend predates #3271 and has no direct route | `stop_and_tell_user` | `typed_data_b64` | `http_status`, `backend_error_code` |
| `SIGN_CONTEXT_REFUSED` (other) | Unknown `payment_id` (404, x402 fetch), `already_executed` / `not_signable` (409) — or, on `haven_sign_x402` only, `sign_context_unavailable` (409) | `stop_and_tell_user` | — | `http_status`, `backend_error_code` |
| `USEROP_BINDING_MISMATCH` | A direct payment's `PackedUserOperation` typed data (from the direct fetch, or a tool argument) does not recompute to its own `payload_hash`, or a fetched direct context is not a `PackedUserOperation` — see [Two ways to use it](#two-ways-to-use-it) above | `stop_and_tell_user` | — | no `http_status` — this is a local recomputation, not a backend refusal |

`fallback: 'typed_data_b64'` appears only where signing OTHER bytes is a
remedy — a transport failure or a body this signer could not read. It is
**not** in the default quote result since #1272: obtain it by re-running the
SAME quote tool with the SAME `idempotency_key` plus
`include_signing_payload: true`, then pass `typed_data_b64` (plus
`payload_hash` / `x402_expected`) instead of `payment_id`. A backend REFUSAL
carries no fallback: an expired, executed or unsignable intent cannot be
rescued by re-signing its bytes — an expired one is re-quoted (the same
`payment_window_expired` + `retry_with_new_quote` the signer emits for
`PAYMENT_WINDOW_EXPIRED`), the rest stop. These codes are signer-local,
not part of `@haven_ai/sdk`'s `AgentPaymentFailureCode` taxonomy, since they
describe a local fetch failure, not a payment-domain outcome, and never reach
the backend's REST/OpenAPI surface — only this package's MCP tool responses.

## Custody

The delegate key is read from `HAVEN_DELEGATE_KEY` or a `--credentials` file's
`delegate_key` (with a permissive-file warning). It stays in this process, and
is never transmitted.

**The signer makes at most two kinds of network call, both reads.** Since
[#1263](https://github.com/d-hinders/Haven-AI/issues/1263) the `{ payment_id }`
form of `haven_sign` and `haven_sign_x402` performs an authenticated,
read-only `GET /x402/:payment_id/sign-context` against Haven, so that agents
never have to relay multi-KB EIP-712 payloads through a model's context
window. Since #3271, `haven_sign` (never `haven_sign_x402`) falls back to a
second read — `GET /payments/:payment_id/sign-context` — only when that first
fetch answers the backend's 409 `sign_context_unavailable`, i.e. this
`payment_id` names a direct payment rather than an x402 intent. **Only the
Bearer API key goes out on either read; the delegate key is never part of
either request or response.** Since #2985 both reads are bounded: each aborts
after `SIGN_CONTEXT_TIMEOUT_MS` (15 s) and reports a `HavenSignContextError`
naming the timeout and the `typed_data_b64` fallback, so a hung backend cannot
hang the signer — and the agent — past the funding window. Every refusal on
either fetch (timeout, unreachable host, a non-ok backend response, a
malformed body) is structured the same way, not just prose — see
[Sign-context refusal codes](#sign-context-refusal-codes) below.
Nothing else in the package reaches the
network: `haven_x402_sign_header` and `haven_sign_sweep_delegate` never fetch,
the library surface above (`createEdgeSigner` and its six signing methods, over
the network-free `src/core.ts`) never fetches, and passing the payload as
`typed_data_b64` instead of `payment_id` keeps even the two fetching tools
offline. It never relays, submits, or broadcasts.

The fetch needs `api_url` and `api_key` from an `identity.json` sitting **next
to the signer credential file** — the signer's own credential still needs no
`api_key`. So the network call is a property of how you start the signer, not
just of which tool you call: run it from `HAVEN_DELEGATE_KEY` alone and there is
no credential file, hence no directory to find an `identity.json` in, so the
`{ payment_id }` form refuses with a message naming the `typed_data_b64`
fallback rather than reaching out — and the process makes no network calls at
all. Egress is needed by `--credentials` / `HAVEN_CREDENTIALS` runs that use the
preferred `{ payment_id }` call, which is what the connector install above
sets up.

Fetched bytes are treated as untrusted input exactly like a tool argument: the
same digest re-derivation and Haven-binding verification apply, because what
makes them safe is the verification, not where they came from.

Connect Agent 2 may create the signer credential file locally during setup. In
that flow Haven receives the public signing address, proof, API-key hash/prefix,
and install status only; the plaintext API key and delegate key stay in local
protected storage/runtime config.

## Local audit

Every MCP signing operation appends a JSONL row locally, best-effort (see the
end of this section). File-backed runs write
next to the credential as `<credential>.signer-audit.jsonl`; env-only runs use
`~/.haven/signer-audit.jsonl`. Rows include timestamp, tool, payload hash and
delegate address, plus the account address and chain id when the credential
carries them. They never include the delegate key, the signature, or the x402
payment header.

Since #3172 the sidecar is owner-only and bounded. It is created `0600` — the
mode the credential beside it is expected to have — and a sidecar found
readable beyond its owner (every release before #3172 created it with the
default mode, `0644` under the usual `umask 022`, or an operator loosened it
later) is tightened to `0600` in place on the next
append, with one stderr line per occurrence. If `chmod` is refused, the line
names the same `chmod 600` remedy the credential warning gives. If the path
is a symlink (or anything but a regular file) nothing is chmod-ed — that
would hit the target — but note that audit rows are still written through
the link to its target, so the line says to remove the link (`rm <path>`),
not to chmod it. The check runs before rotation, so a legacy file that
rotates carries `0600` into `.1`. When the live file reaches
`AUDIT_ROTATE_BYTES` (8 MiB, roughly 30 000 rows) it is renamed to
`<path>.1`, replacing the previous `.1`, and a fresh file starts — two
generations at most. The rotation decision is not atomic across processes:
two signer processes on one credential that both hit the bound can leave the
predecessor generation discarded (the current entry is never lost). A failed
audit write (disk full, read-only, two appends racing at the bound) is
reported on stderr and never fails the signing call that already produced
its signature — so the consent block's
"appended for every signing operation" is a best-effort promise since #3172,
kept unchanged in text because editing it moves the consent hash. The
credential check itself is unchanged in wording and still judges a symlinked
credential by its target. The
`payload_hash` argument itself is bounded on the tool schema to a 32-byte hash
(`0x` + 64 hex), so the audit field is never caller-controlled free text; the
two object arguments that do reach the file (`payment_required`,
`authorization`) were already hashed before being written, and
`x402_expected` is never written to the sidecar.

## Hot-wallet minimization

This applies to the **EIP-3009 bridge only** — the erc7710 path above has no
funding leg and no delegate balance to strand. On the bridge, the account
briefly funds the delegate EOA before the merchant settles the EIP-3009
authorization. Keep delegate balances transient: keep budgets small and
period-bound, retry the original merchant session only after funding confirms,
and sweep stranded delegate balances (`haven_sign_sweep_delegate`) when the
merchant retry fails or does not settle before authorization expiry.
