---
owner: "@d-hinders"
status: research
covers:
  - packages/sdk/src/signer.ts
  - packages/qa-agent/src/pilot/session-rail.ts
last-verified: "2026-07-02"
---

# Session-key UserOp construction — backend-wrapped vs viem-in-SDK (#737)

Stage 2 acceptance gate 4 ([epic #733](https://github.com/d-hinders/Haven-AI/issues/733)).
The pilot built session-key UserOps with `permissionless` + `@rhinestone/module-sdk`
+ `viem`, contained in the private `qa-agent` package. Production needs a
construction path that does **not** drag the full ERC-4337 stack into the
published `@haven_ai/sdk`. This note decides where UserOp construction lives.

## Decision

**Backend-wrapped construction, client-side session-key signing.** The backend
constructs the UserOp and computes the `userOpHash`; the client-side signer
signs that hash with the **session key**; the backend wraps the signature
(`encodeSmartSessionSignature`) and submits it to the bundler. The published
SDK gains **no** `permissionless` / `module-sdk` dependency and **no** UserOp
construction code.

This is not a new architecture — it is the model the SDK **already uses**.

## Why — the split already exists

Today's AllowanceModule payment path is already "construct server-side, sign
client-side":

- The **backend** builds the transfer and computes the hash to sign (the SDK
  never constructs a transaction).
- `packages/sdk/src/signer.ts` signs that hash with the delegate key —
  `ethers.SigningKey.sign()`, raw ECDSA over the hash, matching the
  AllowanceModule's `checkSignature` (no EIP-191 prefix).
- The backend submits.

The delegate key stays client-side; Haven never holds it. Session keys slot
into the identical shape — only three things change, all small:

| Piece | AllowanceModule today | Session-key rail |
|---|---|---|
| What the backend constructs | transfer + hash | UserOp + `userOpHash` |
| What the client signs | raw ECDSA over the hash | **EIP-191** over the hash (the #731 fix — OwnableValidator recovers the personal-sign digest) |
| How the backend submits | relayer `execTransaction` | wrap via `encodeSmartSessionSignature`, submit to bundler |

The client-side surface stays a **one-function signer**: give it a hash and a
key, get a signature. It gains a session-key variant that applies the EIP-191
prefix (`signMessage({ message: { raw: hash } })`) instead of raw ECDSA — a few
lines in `signer.ts`, no new dependency (`viem` is already an SDK dependency,
though `ethers` alone suffices for the signature).

## Alternative considered — viem/permissionless in the published SDK

Put `toSafeSmartAccount` + UserOp construction + `module-sdk` session encoding
in `@haven_ai/sdk` so the client builds the whole UserOp. **Rejected:**

- **Bloat + runtime risk.** `permissionless` + `@rhinestone/module-sdk` pull a
  large 4337/viem surface into a package that ships to every agent runtime.
  The published packages carry a runtime-compatibility contract
  ([`docs/operations/mcp-runtime-compatibility.md`](../operations/mcp-runtime-compatibility.md));
  a heavy transitive tree is exactly what that contract exists to avoid.
- **Duplicated logic, divided trust.** UserOp construction (gas, nonces,
  paymaster, encoding) would then live in two places — backend and client — and
  the backend already owns it for the relayer rail. Construction is where bugs
  hide; keep it in one audited place.
- **No non-custody gain.** Non-custody comes from the **session key never
  leaving the client signer** and **policies being owner-signed on-chain** —
  both hold with backend construction. Building the UserOp client-side buys no
  additional trust; the backend cannot widen an on-chain session policy no
  matter who assembles the calldata.
- **Bundler URL is a secret.** It embeds the API key. Client-side submission
  would either leak it or require a backend proxy anyway — so submission stays
  backend-side regardless, and construction naturally follows it.

## Consequences / handoff to the foundation build (#739)

- **#739 builds it backend-side:** port `session-rail.ts` UserOp construction
  and the `encodeSmartSessionSignature` wrap into the backend; expose a
  session-key signing variant in `packages/sdk/src/signer.ts` (EIP-191, keyed
  distinctly from the raw-ECDSA AllowanceModule path so the two can't be
  confused).
- **Published SDK dependency set is unchanged** — no `permissionless`, no
  `@rhinestone/module-sdk`. Keep them confined to `qa-agent` (pilot) and, for
  construction, the backend (not published to npm).
- **Signer must not silently pick the wrong prefix.** Raw ECDSA (AllowanceModule)
  vs EIP-191 (OwnableValidator/session) is the #731 footgun — the signer API
  should make the choice explicit per rail, not infer it.
- **CASP framing (#736):** "the client signs, the backend assembles and
  submits, Haven holds no key" is the same non-custody line as today — no new
  custody claim. The copy review still owns the "paymaster/session" vocabulary.

## References

- Epic: [#733](https://github.com/d-hinders/Haven-AI/issues/733) · foundation build: [#739](https://github.com/d-hinders/Haven-AI/issues/739)
- EIP-191 signing root-cause: [#731](https://github.com/d-hinders/Haven-AI/issues/731) · pilot report `session-key-pilot-report.md` §2
- Current signer: `packages/sdk/src/signer.ts` · pilot construction: `packages/qa-agent/src/pilot/session-rail.ts`
- Runtime compatibility contract: [`docs/operations/mcp-runtime-compatibility.md`](../operations/mcp-runtime-compatibility.md)
