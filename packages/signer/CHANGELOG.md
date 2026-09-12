# @haven_ai/signer

Release headers are written by the release bump (`npm run release:bump`), never by hand.

## Unreleased

### Naming epic #2906, phase 1 (#2908) — reads both names, prefers the new

| Reader | Chain (earlier wins) | Window |
|---|---|---|
| credential file (`loadSignerCredentials`) | `account_address ?? safe_address ?? safeAddress` | the two old keys are read **permanently** (a file on disk never rewrites itself) |
| environment | `HAVEN_ACCOUNT_ADDRESS ?? HAVEN_WALLET_ADDRESS ?? HAVEN_SAFE_ADDRESS` | `HAVEN_WALLET_ADDRESS` / `HAVEN_SAFE_ADDRESS` removed at #2914 |

`SignerCredentials` gains `accountAddress`; `safeAddress` is kept with the
same value and `@deprecated` — **removed in the release after the one
carrying #2908 (#2914)**. Exported: `readAccountAddressField()`,
`readAccountAddressEnv()`.

**No expected-context version change:** `SUPPORTED_X402_EXPECTED_VERSIONS`
stays `[1, 2, 3]` (asserted by `naming-window-no-version-change.test.ts`);
`sign_data.components.*` is response metadata, never part of the signed
payload. `capabilities.ts` and `core.ts` are unchanged except comments.
