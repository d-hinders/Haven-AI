# @haven_ai/mcp

Release headers are written by the release bump (`npm run release:bump`), never by
hand — true since the changelog-heading gap, and stated here only because it was asserted for a long
time while being false. The bump rewrites the `## Unreleased` heading below into
`## <version> — <date>`; add entries under `## Unreleased` and leave the heading
alone.

## Unreleased

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
