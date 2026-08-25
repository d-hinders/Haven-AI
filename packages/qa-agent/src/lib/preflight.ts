/**
 * Money-flow QA preflight (#1530).
 *
 * The harness asserted a great deal about what happens DURING a run and
 * nothing about whether the run could succeed at all. On 2026-08-17 the demo
 * merchant's settlement wallet held 255 gwei; every x402 leg needing a
 * merchant-side settlement failed, nothing in the output said so, and the
 * cause took a day to find behind four defects it was masking.
 *
 * The shape of that bug generalises: the system verified that a CREDENTIAL was
 * configured (`SETTLEMENT_PRIVATE_KEY` must be set, or the merchant refuses to
 * boot) and never that the RESOURCE it spends was available. This module
 * checks the resources.
 *
 * Two design rules, both learned the hard way in the same session:
 *
 *   1. **Derive, never restate.** Every address here comes from config the
 *      harness already loads, from a key it already holds, or from the service
 *      that owns it. A hand-maintained list is the #1526 defect — one rule in
 *      three places, two of them drifted, leaving a published package silently
 *      unguarded.
 *   2. **Report on every run, not only on failure.** A balance that is fine
 *      today and empty next week is visible only as a trend, and the number is
 *      most useful in the log of the run that was diagnosing something else.
 */

import { ethers } from 'ethers'
import { BASE_SEPOLIA_RPC, SEPOLIA_USDC, ERC20_BALANCE_ABI, USDC_DECIMALS } from './chain.js'
import type { QaConfig } from '../config.js'

/** One resource the run consumes, and whether it can still be consumed. */
export interface ResourceCheck {
  /** Human label, e.g. `merchant settlement wallet`. */
  name: string
  /** The account, when there is one. Absent for a check that could not resolve it. */
  address?: string
  /** Formatted for humans, in the unit that resource is denominated in. */
  balance: string
  /**
   * Headroom in units of WORK where the resource has a known unit cost —
   * "0 settlements" reads as a cause, "255 gwei" reads as a number.
   */
  headroom?: string
  /**
   * `true` usable, `false` below floor (fails the run), `null` unknown.
   *
   * `null` is deliberately NOT a failure: an unreachable RPC or a merchant
   * that predates the readiness endpoint says nothing about the resource, and
   * a preflight that blocks the run on its own blind spots would be worse
   * than the silence it replaces.
   */
  ok: boolean | null
  /** Why, when `ok` is not `true`. */
  detail?: string
}

export interface PreflightResult {
  checks: ResourceCheck[]
  /** True when at least one resource is definitively below its floor. */
  blocked: boolean
}

/** The merchant's `/healthz` settlement block (#1530). */
interface MerchantHealth {
  settlement?: {
    address?: string
    native_balance_wei?: string
    settlements_remaining?: number
    ok?: boolean | null
    error?: string
  }
}

/**
 * Ask the merchant whether the wallet that PAYS for settlement still can.
 *
 * This must come from the merchant: the address derives from
 * `SETTLEMENT_PRIVATE_KEY` in the merchant's own environment and is visible to
 * nothing else. The harness could not have detected the 2026-08-17 outage by
 * looking at anything it owns.
 */
export async function checkMerchantSettlement(
  demoMerchantUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResourceCheck> {
  const name = 'merchant settlement wallet (gas)'
  try {
    const res = await fetchImpl(`${demoMerchantUrl}/healthz`)
    if (!res.ok) {
      return { name, balance: '—', ok: null, detail: `/healthz returned HTTP ${res.status}` }
    }
    const body = (await res.json()) as MerchantHealth
    const s = body.settlement
    if (!s) {
      return {
        name,
        balance: '—',
        ok: null,
        detail: 'merchant /healthz reports no settlement block — deployed before #1530',
      }
    }
    if (s.error || s.ok === null || s.ok === undefined) {
      return { name, address: s.address, balance: '—', ok: null, detail: s.error ?? 'merchant could not read its balance' }
    }
    const eth = s.native_balance_wei ? ethers.formatEther(s.native_balance_wei) : '?'
    const remaining = s.settlements_remaining ?? 0
    return {
      name,
      address: s.address,
      balance: `${eth} ETH`,
      headroom: `${remaining} settlement(s)`,
      ok: s.ok,
      detail: s.ok
        ? undefined
        : `only ${remaining} settlement(s) of gas left — top this wallet up, or every ` +
          'x402 leg needing a merchant-side settlement will fail with a merchant error ' +
          'that does not name gas (the 2026-08-17 outage)',
    }
  } catch (error) {
    return {
      name,
      balance: '—',
      ok: null,
      detail: `could not reach ${demoMerchantUrl}/healthz: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * A delegate EOA's leftover USDC.
 *
 * Non-zero at the START of a run means a previous run stranded funds — the
 * #713 reconciliation class. Reported rather than enforced: several legs
 * deliberately leave sub-floor dust, so this is a number worth seeing, not a
 * gate worth failing.
 */
export async function checkDelegateResidual(
  label: string,
  privateKey: string,
  provider: ethers.Provider,
): Promise<ResourceCheck> {
  const name = `${label} delegate residual (USDC)`
  try {
    const address = new ethers.Wallet(privateKey).address
    const usdc = new ethers.Contract(SEPOLIA_USDC, [...ERC20_BALANCE_ABI], provider)
    const raw: bigint = await usdc.balanceOf(address)
    return {
      name,
      address,
      balance: `${ethers.formatUnits(raw, USDC_DECIMALS)} USDC`,
      ok: true, // informational: dust is expected, and stranding is a finding not a blocker
      detail: raw > 0n ? 'non-zero at start — a previous run may have stranded funds (#713)' : undefined,
    }
  } catch (error) {
    return { name, balance: '—', ok: null, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** Render the checks as a block a human can act on without opening anything else. */
export function formatPreflight(result: PreflightResult): string {
  const lines = ['preflight — resources this run consumes:']
  for (const c of result.checks) {
    const mark = c.ok === true ? '✓' : c.ok === false ? '✗' : '?'
    const where = c.address ? ` ${c.address}` : ''
    const headroom = c.headroom ? ` (${c.headroom})` : ''
    lines.push(`  ${mark} ${c.name}${where}: ${c.balance}${headroom}`)
    if (c.detail) lines.push(`      ${c.detail}`)
  }
  return lines.join('\n')
}

/**
 * Run every applicable check. A resource whose config is absent is skipped
 * rather than reported unknown — the leg that needs it skips too, so an
 * unknown here would be noise about a leg that is not running.
 */
export async function runPreflight(
  cfg: QaConfig,
  deps: { fetchImpl?: typeof fetch; provider?: ethers.Provider } = {},
): Promise<PreflightResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const provider = deps.provider ?? new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
  const checks: ResourceCheck[] = []

  if (cfg.demoMerchantUrl) {
    checks.push(await checkMerchantSettlement(cfg.demoMerchantUrl, fetchImpl))
  }
  if (cfg.delegationDelegateKey) {
    checks.push(await checkDelegateResidual('delegation', cfg.delegationDelegateKey, provider))
  }

  return { checks, blocked: checks.some((c) => c.ok === false) }
}
