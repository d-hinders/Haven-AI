# @haven_ai/mcp

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

### Removed

- **BREAKING (#3306, via `@haven_ai/sdk`) — `haven_list_receipts` rows lose four keys.** `rail`, `proofStatus`, `resourceUrl` and `merchantAddress`, the deprecated twins kept for one full release since `0.5.0-alpha.0` (#3134), are no longer emitted; read `source`, `paymentProofStatus`, `x402ResourceUrl` and `x402MerchantAddress`. This is a tool-output re-shape, breaking for any agent or script still reading an old key, so the release carrying it takes a **MINOR** bump under the 0.x rule (`docs/operations/mcp-runtime-compatibility.md`). A `.d.ts` diff of this package shows nothing — the break is in tool output, which no declaration file carries. No tool, argument, schema or description changed on this package; the hosted runtime drops the keys with its deploy.

## 0.5.0-alpha.1 — 2026-09-25

- **Client identity and update hint (#3303, epic #3302).** Haven API requests name `@haven_ai/mcp/<version>` in `X-Haven-Client`. When the backend sends a `client_update` hint for this runtime, the tool result carries it as `client_update`, on success and failure alike, with the exact update command. A 426 `client_outdated` refusal also keeps the backend's `next_tool_omitted_reason` at the top level of the failure. No tool, schema or consent input changes, so nobody is re-prompted.

## 0.5.0-alpha.0 — 2026-09-25

- **Consent label copy fix (#3279).** The first-launch consent screen prints `Haven wallet: <address>` instead of `Haven wallet (Safe): <address>`, and the `accountAddress` field JSDoc loses the retired rail's name. Copy only: **the consent hash is unchanged** — `computeConsentHash` covers identity, the tool set and the allowance summary, never the rendered text, so nobody is re-prompted; the label pin test is retargeted to the new wording, not removed. The spend-gate wording on the same screen ("the real spend gate — enforced by the agent's signed delegation") was already correct and stays.
- **Behaviour change, via `@haven_ai/sdk` (#3283):** `haven_send` and the x402 payment tools (`haven_pay_x402`, `haven_pay_x402_quote`, `haven_pay_mcp_tool`) now refuse, before anything is signed or submitted, a served UserOp that is not this delegate key's own direct-payment shape. So is an erc7710 settlement child that does not match the merchant's 402, is a root grant, is delegated by another account, or has no 402 expectation to check it against. Every such refusal is the SDK's `HavenTypedDataRefusedError`, code `TYPED_DATA_NOT_ALLOWED`. Separately, `haven_send` inherits #3271's direct-payment binding check: a served UserOp whose typed data does not hash to its own `payload_hash` is refused with `HavenUserOpBindingError`, code `USEROP_BINDING_MISMATCH`. No tool, argument, schema or description changed on this package.
- `haven_list_receipts` rows gain `source`, `paymentProofStatus`, `x402ResourceUrl` and `x402MerchantAddress` (#3134, via `@haven_ai/sdk`'s `mapPaymentReceipt`) beside the deprecated `rail`, `proofStatus`, `resourceUrl`, `merchantAddress`, which stay for one full release (removal condition in the SDK CHANGELOG entry). No tool, argument, schema or description changed on this package; the change is carried by the SDK dependency.

## 0.4.0-alpha.0 — 2026-09-19

- #3128: `haven_list_receipts` accepts `cursor` and returns `{ receipts, total, hasMore, nextCursor }` instead of a bare array (via the SDK's `listReceiptsPage`).

- **Failure envelope: `next_action` added, `nextAction` deprecated (#3103,
  epic #3105 decision 10).** Every `{ success: false }` result now carries
  `next_action` with the same value as `nextAction`; `nextAction` is kept for
  this release and removed in the release after the one carrying #3103 (the
  #2908 pattern). The merchant-not-ready and unknown-error refusals also carry
  `next_tool_omitted_reason`.

## 0.3.0-alpha.0 — 2026-09-17

### Removed

- **BREAKING (#2914, naming epic #2906 phase 5).** `HAVEN_WALLET_ADDRESS` and
  `HAVEN_SAFE_ADDRESS` are no longer read from the environment;
  `HAVEN_ACCOUNT_ADDRESS` is the only name. Set it before upgrading.
- `HavenCredentialFile.safeAddress` is removed from the in-memory shape.

### Unchanged, and deliberately

- The credential-FILE fallback `account_address ?? safe_address ?? safeAddress`
  is **permanent** — a file on disk never rewrites itself — and stays tested
  against an old-shape file. The environment is not permanent, and that
  difference is the whole of this entry.

## 0.2.1-alpha.0 — 2026-09-16

### Added

- Quotes predict the scheme `prepare` will select — `expected_settlement_scheme`,
  `expected_funding_leg`, `expected_settleable` (#2991). A prediction only: the backend
  still selects from the payTo shape at prepare time.
- `haven_report_settlement_evidence` (#2973).

### Changed

- **`merchant_not_ready` parity in the local runtime** (#2983, #2979). A merchant's
  `503 { error: 'merchant_not_ready' }` now maps to `MERCHANT_NOT_READY`; previously it
  fell through to the discovery path and surfaced a different code. An unchanged caller
  gets a different code for the same merchant response.
- The erc7710 paid-retry refusal states that nothing moved.
- `PRICE_EXCEEDS_MAX` and `INVALID_MAX_AMOUNT` refusals carry `next_action` (#2975).

## 0.2.0-alpha.0 — 2026-09-14

### Naming epic #2906, phase 1 (#2908) — reads both names, prefers the new

| Reader | Chain (earlier wins) | Window |
|---|---|---|
| credential file, single and split (`loadCredentials`) | `account_address ?? safe_address ?? safeAddress` (per file; split files must agree, mismatch is labelled `account_address`) | the two old keys are read **permanently** |
| environment | `HAVEN_ACCOUNT_ADDRESS ?? HAVEN_WALLET_ADDRESS ?? HAVEN_SAFE_ADDRESS` | `HAVEN_WALLET_ADDRESS` / `HAVEN_SAFE_ADDRESS` removed at #2914 |

`HavenCredentialFile` gains an explicit `accountAddress` key (this shape is
separate from the signer's); `safeAddress` is kept with the same value and
`@deprecated` — **removed in the release after the one carrying #2908
(#2914)**. Exported: `readAccountAddressField()`, `readAccountAddressEnv()`.
The consent seed prefers the SDK's `accountAddress` and falls back to
`safeAddress`; the consent hash input value is unchanged either way.
