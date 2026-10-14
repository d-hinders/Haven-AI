/**
 * #3839: the catalog-based funding-leg hint a discovery entry carries.
 *
 * The catalog stores the x402 `assetTransferMethods` a merchant advertised on
 * its last probe (`merchant_catalog.asset_transfer_methods`, a comma-separated
 * set such as `"eip3009"` or `"eip3009,erc7710"`). A merchant that advertises
 * `erc7710` settles straight from the account on the delegation rail; one that
 * does not is paid through the EIP-3009 funding leg, which costs Haven several
 * times the micro-fee (#3777). This turns the stored set into the hint:
 *
 * - `false` — `erc7710` is in the recorded set: no funding leg expected;
 * - `true`  — a set is recorded and `erc7710` is not in it;
 * - `'unknown'` — nothing recorded (an unprobed or ingestion row, an MPP row,
 *   or a backend predating the field). Never `null`: on the quote tools a
 *   `null` `expected_funding_leg` means the agent read failed, a different fact.
 *
 * It is a HINT. The set covers the network of the merchant's first `accepts`
 * entry when probed, which may not be the agent's chain, and a stale row keeps
 * its old set. The live quote's `expected_funding_leg` is authoritative.
 *
 * Case-sensitive, as the settlement selector (`isErc7710Option`, `x402.ts`)
 * and the backend's merchant-locked aggregate (`'erc7710' = ANY(...)`) are;
 * whitespace around commas is trimmed, as the dashboard reading does. The
 * backend stores each option's method verbatim, so a case-folding reading here
 * would call a row erc7710-capable that the quote and prepare do not.
 *
 * The dashboard's `needsUnpinnedBudget` (frontend `lib/marketplace.ts`) reads
 * the same column; a frontend test asserts it agrees with this function.
 */
export type CatalogFundingLegHint = boolean | 'unknown'

export function catalogFundingLegExpected(assetTransferMethods: string | null | undefined): CatalogFundingLegHint {
  if (typeof assetTransferMethods !== 'string') return 'unknown'
  const methods = assetTransferMethods
    .split(',')
    .map((method) => method.trim())
    .filter((method) => method.length > 0)
  if (methods.length === 0) return 'unknown'
  return !methods.includes('erc7710')
}
