/**
 * Pure helpers for the #723 rail comparison: latency statistics, the
 * rail-agnostic payment-evidence shape, and the Markdown comparison table.
 * Extracted so the report format is unit-testable without a network.
 */

export interface RailMeasurement {
  /** 'erc4337-session' | 'allowance-relayer' */
  rail: string
  /** Wall-clock ms per confirmed payment (sequential phase). */
  sequentialLatenciesMs: number[]
  /** Gas used per confirmed payment, when observable. */
  gasUsed: bigint[]
  /** Concurrency probe: how many of the simultaneous payments landed. */
  concurrentAttempted: number
  concurrentLanded: number
  /** First-line failure reasons from the concurrency probe. */
  concurrentFailures: string[]
}

export function medianMs(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

export function avgGas(values: readonly bigint[]): bigint | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0n) / BigInt(values.length)
}

/**
 * Mirrors the key columns of the backend's machine-payment-evidence row
 * (`lib/machine-payment-evidence.ts`) so the ledger stays rail-agnostic: the
 * same evidence shape must be recordable whichever rail executed the payment.
 */
export interface PilotPaymentEvidence {
  rail: string
  tx_hash: string
  chain_id: number
  payer_address: string
  settlement_address: string
  token_address: string
  amount_raw: string
  proof_status: 'onchain_confirmed'
}

export function buildPilotEvidence(args: {
  rail: string
  txHash: string
  chainId: number
  payer: string
  settlement: string
  tokenAddress: string
  amountRaw: bigint
}): PilotPaymentEvidence {
  return {
    rail: args.rail,
    tx_hash: args.txHash,
    chain_id: args.chainId,
    payer_address: args.payer,
    settlement_address: args.settlement,
    token_address: args.tokenAddress,
    amount_raw: args.amountRaw.toString(),
    proof_status: 'onchain_confirmed',
  }
}

/** The #723 deliverable: one table, both rails, same metrics. */
export function buildComparisonTable(measurements: readonly RailMeasurement[]): string {
  const lines = [
    '| metric | ' + measurements.map((m) => m.rail).join(' | ') + ' |',
    '|---|' + measurements.map(() => '---').join('|') + '|',
  ]
  const row = (label: string, cell: (m: RailMeasurement) => string) =>
    lines.push(`| ${label} | ` + measurements.map(cell).join(' | ') + ' |')

  row('sequential payments measured', (m) => String(m.sequentialLatenciesMs.length))
  row('median latency (ms)', (m) => {
    const v = medianMs(m.sequentialLatenciesMs)
    return v === null ? 'n/a' : String(v)
  })
  row('avg gas / payment', (m) => {
    const v = avgGas(m.gasUsed)
    return v === null ? 'n/a' : v.toString()
  })
  row('concurrent probe', (m) =>
    m.concurrentAttempted === 0 ? 'n/a' : `${m.concurrentLanded}/${m.concurrentAttempted} landed`,
  )
  row('concurrency failures', (m) =>
    m.concurrentFailures.length === 0 ? '—' : m.concurrentFailures.join('; ').slice(0, 120),
  )
  return lines.join('\n')
}
