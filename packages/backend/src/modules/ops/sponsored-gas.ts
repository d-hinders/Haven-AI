/**
 * `GET /ops/sponsored-gas` (#3837): what Haven's gas sponsorship actually
 * costs, per merchant per day, next to the value the sponsored funding legs
 * moved. Monitoring only — no threshold, no alert workflow, no new secret
 * (owner decision 2026-10-09); the view exists to show what a normal day
 * looks like before anyone decides what "abnormal" means.
 *
 * Reads ONLY the `sponsored_userop_gas_events` ledger (migration 110) and a
 * live join onto `payment_intents` for the merchant host and the value
 * moved — it never touches a rail, chain client or signer (ops invariant 1).
 * Gas is priced at VIEW time from CoinGecko (`infra/prices.js`, the same
 * feed the fiat surfaces use) and the response SAYS so (`eth_priced_at`):
 * the USD figures move with the market, the wei figures do not.
 *
 * Cost basis (stated, per the issue): the EntryPoint receipt's
 * `actualGasCost`, which includes `preVerificationGas` — through which
 * bundlers recover Base's L1 data fee — and NOT the transaction-level
 * `l1Fee`, which would double-count.
 */
import type { Executor } from '../../infra/transaction.js'
import { sponsoredGasByMerchantDay, type SponsoredGasByMerchantDayRow } from '../../infra/repositories/sponsored-userop-gas.js'
import { getTokenPrice, type TokenPrice } from '../../infra/prices.js'

export const OPS_SPONSORED_GAS_DEFAULT_DAYS = 30

/** `1e18` as a Number — gas ETH amounts lose sub-wei precision, which is fine for a view. */
const WEI_PER_ETH = 1e18

export interface OpsSponsoredGasRow {
  day: string
  merchant_host: string | null
  leg: 'direct' | 'x402_funding'
  funding_legs: number
  gas_cost_wei: string | null
  gas_eth: number | null
  gas_usd: number | null
  value_moved_usd: number
  /** `gas_usd / value_moved_usd`; null when no gas was priced or nothing moved. */
  gas_value_ratio: number | null
}

export interface OpsSponsoredGas {
  days: number
  /** The view-time ETH/USD quote, or null when the price feed returned nothing usable. */
  eth_price_usd: number | null
  /** Fixed: the ETH price in `eth_price_usd` was fetched when THIS read ran, not at record time. */
  eth_priced_at: 'view_time'
  gas_basis: string
  rows: OpsSponsoredGasRow[]
  generated_at: string
}

export interface BuildOpsSponsoredGasOptions {
  days?: number
  now?: () => number
  /** Overridable for tests; default is the shared CoinGecko reader. */
  fetchEthPrice?: () => Promise<TokenPrice>
}

function toRow(row: SponsoredGasByMerchantDayRow, ethPriceUsd: number | null): OpsSponsoredGasRow {
  const gasEth = row.gas_cost_wei == null ? null : Number(row.gas_cost_wei) / WEI_PER_ETH
  const gasUsd = gasEth != null && ethPriceUsd != null ? gasEth * ethPriceUsd : null
  const valueMovedUsd = Number(row.value_moved_usd ?? 0)
  return {
    day: row.day,
    merchant_host: row.merchant_host,
    leg: row.leg,
    funding_legs: Number(row.funding_legs),
    gas_cost_wei: row.gas_cost_wei,
    gas_eth: gasEth,
    gas_usd: gasUsd,
    value_moved_usd: valueMovedUsd,
    // A ratio against a zero/absent denominator is meaningless — null, not 0.
    gas_value_ratio: gasUsd != null && valueMovedUsd > 0 ? gasUsd / valueMovedUsd : null,
  }
}

export async function buildOpsSponsoredGas(
  db: Executor,
  opts: BuildOpsSponsoredGasOptions = {},
): Promise<OpsSponsoredGas> {
  const now = opts.now ?? Date.now
  const days = opts.days ?? OPS_SPONSORED_GAS_DEFAULT_DAYS
  const to = new Date(now())
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)

  const fetchEthPrice = opts.fetchEthPrice ?? (async () => getTokenPrice('ETH'))
  const ethPrice = await fetchEthPrice()
  // Zero is `prices.ts`'s "no usable quote" sentinel, not a market price.
  const ethPriceUsd = ethPrice.usd > 0 ? ethPrice.usd : null

  const rows = await sponsoredGasByMerchantDay(from, to, db)

  return {
    days,
    eth_price_usd: ethPriceUsd,
    eth_priced_at: 'view_time',
    gas_basis:
      'EntryPoint receipt actualGasCost per sponsored UserOp (includes preVerificationGas, through which bundlers recover the L1 data fee; the transaction-level l1Fee is NOT added). ' +
      'ETH is priced at VIEW time; the USD figures move with the market, the wei figures do not.',
    rows: rows.map((row) => toRow(row, ethPriceUsd)),
    generated_at: to.toISOString(),
  }
}
