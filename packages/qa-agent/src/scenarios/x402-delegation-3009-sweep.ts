/**
 * #946 invariant, second half: when a merchant **verifies but does not settle**
 * a delegation-rail 3009 payment, the funds left on the delegate EOA are
 * **recoverable**.
 *
 * ## Why this is the half that matters more
 *
 * The settle scenario proves the bridge works. This one proves the bridge's
 * accepted downside is survivable. The whole reason #946 is described as a
 * temporary interop bridge rather than a destination is that it reintroduces a
 * transient hot balance — and the failure mode that turns "transient" into
 * "stuck" is exactly this: the merchant verifies, never settles, and the budget
 * is already spent because it was metered at the FUNDING hop rather than at
 * settlement. This is now the ONLY leg covering that shape: the legacy-rail
 * `x402-sweep-recovery` was removed once the delegation rail became the base
 * for every new account.
 *
 * ## Why it is a separate scenario rather than a branch of the other one
 *
 * The two need different merchant products and assert opposite outcomes.
 * Folding them together would produce a test that passes when either half
 * works, which is the failure this repo keeps naming: a green run that means
 * less than it appears to.
 *
 * ## Preconditions, and why they cause SKIPs rather than failures
 *
 * The merchant must be configured with `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb`,
 * and the dev backend wants `SWEEP_MIN_USDC=0` so a QA-sized stranding is above
 * the floor and exercises a real sweep. Neither is this scenario's to assert:
 * a merchant that settles normally is an unmet precondition, not a sweep
 * regression, and reporting it as a failure would train operators to ignore
 * this line.
 */

import { HavenClient, buildSweepTypedData } from '@haven_ai/sdk'
import { ethers } from 'ethers'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'
import { BASE_SEPOLIA_RPC, SEPOLIA_USDC } from '../lib/chain.js'

const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/** Mutable purely as a TEST SEAM — see the note in `x402-delegation-3009.ts`. */
export const SWEEP_TIMING = { strandWaitMs: 20_000, pollIntervalMs: 2_000 }

async function readUsdc(provider: ethers.Provider, address: string): Promise<bigint> {
  const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
  return (await usdc.balanceOf(address)) as bigint
}

/** Poll until the funding leg's USDC is visible on the delegate, or time out. */
async function waitForStranded(provider: ethers.Provider, delegate: string): Promise<bigint> {
  const deadline = Date.now() + SWEEP_TIMING.strandWaitMs
  let balance = await readUsdc(provider, delegate)
  while (balance === 0n && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SWEEP_TIMING.pollIntervalMs))
    balance = await readUsdc(provider, delegate)
  }
  return balance
}

export const x402Delegation3009Sweep: Scenario = {
  name: 'x402-delegation-3009-sweep',
  invariant:
    'A delegation-rail 3009 payment the merchant verifies but never settles leaves funds on the ' +
    'delegate EOA that the gasless sweep returns to the treasury.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — the 3009 sweep path needs the demo-merchant')
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the 3009 sweep path needs a delegation-rail agent with an OPEN (unpinned) budget',
      )
    }

    const delegateAddress = new ethers.Wallet(ctx.cfg.delegationDelegateKey).address
    const client = new HavenClient({
      apiKey: ctx.cfg.delegationAgentApiKey,
      delegateKey: ctx.cfg.delegationDelegateKey,
      baseUrl: ctx.cfg.apiUrl,
      chainRpcs: { 84532: BASE_SEPOLIA_RPC },
    })
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const fmt = (v: bigint) => ethers.formatUnits(v, 6)

    // storage_50gb is the merchant's verify-without-settle product: Haven funds
    // the delegate EOA, the merchant verifies and returns success without
    // settling on-chain, and the funding is left stranded.
    const res = await client.fetch(`${ctx.cfg.demoMerchantUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'buy_cloud_storage', arguments: { tier: '50gb' } },
      }),
    })
    if (!res.ok) return fail(`verify-without-settle call failed: HTTP ${res.status}`)

    const stranded = await waitForStranded(provider, delegateAddress)
    if (stranded === 0n) {
      return skip(
        `no stranded balance on the delegate after ${SWEEP_TIMING.strandWaitMs / 1000}s — the merchant ` +
          `likely settled instead of verify-without-settle (check ` +
          `MERCHANT_SKIP_SETTLE_PRODUCT=storage_50gb on the demo-merchant)`,
      )
    }

    // The gasless sweep: the delegate signs an EIP-3009 authorization off-chain
    // and Haven's relayer pays the gas. This is the production path — a direct
    // ERC-20 transfer would need the delegate to hold ETH, which a Haven
    // delegate never does.
    let prep
    try {
      prep = await client.prepareSweep()
    } catch (e) {
      return fail(
        `prepareSweep failed (delegate held ${fmt(stranded)} USDC): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
    }

    if (prep.below_min) {
      return skip(
        `stranded ${fmt(stranded)} USDC is below the sweep floor (${prep.min_usdc} USDC) — left as ` +
          `dust by design (owner decision 2026-07-18). Set SWEEP_MIN_USDC=0 on the dev backend to ` +
          `exercise a real sweep.`,
      )
    }
    if (prep.nothing_stranded || !prep.authorization) {
      return fail(
        `backend reported nothing stranded, but the delegate held ${fmt(stranded)} USDC on ` +
          `${BASE_SEPOLIA_RPC} — a backend↔harness RPC discrepancy, not a clean recovery`,
      )
    }

    const typed = buildSweepTypedData(prep.authorization)
    const signature = await new ethers.Wallet(ctx.cfg.delegationDelegateKey).signTypedData(
      typed.domain,
      typed.types as unknown as Record<string, ethers.TypedDataField[]>,
      typed.message,
    )

    let submitted: Awaited<ReturnType<HavenClient['submitSweep']>>
    try {
      submitted = await client.submitSweep(prep.authorization, signature)
    } catch (e) {
      const after = await readUsdc(provider, delegateAddress)
      if (after === 0n) {
        // Funded, then drained to zero before the sweep could run. The only
        // other drainer is the merchant settling after all — an unmet
        // precondition, not a sweep regression.
        return skip(
          `delegate funded ${fmt(stranded)} USDC then drained to 0 before the sweep — the merchant ` +
            `settled instead of verify-without-settle`,
        )
      }
      return fail(
        `gasless sweep submit failed (delegate held ${fmt(stranded)} USDC before, ${fmt(after)} after): ` +
          `${e instanceof Error ? e.message : String(e)}`,
      )
    }

    // The acceptance criterion is about what is LEFT, not about the submit
    // succeeding: a sweep that reports success while the funds stay put would
    // otherwise pass. Read the delegate again and require it below the floor.
    const after = await readUsdc(provider, delegateAddress)
    const floor = ethers.parseUnits(String(prep.min_usdc ?? '1'), 6)
    // `after > 0n` is load-bearing, not belt-and-braces. The dev backend runs
    // `SWEEP_MIN_USDC=0` so a QA-sized stranding is sweepable at all — and with
    // a floor of zero, a bare `after >= floor` is true for a perfectly swept
    // delegate, failing the happy path on exactly the configuration the runbook
    // tells operators to use.
    if (after > 0n && after >= floor) {
      return fail(
        `sweep reported success (tx ${submitted.tx_hash}) but the delegate still holds ${fmt(after)} ` +
          `USDC — at or above the ${fmt(floor)} USDC floor, so this is stranding, not dust`,
      )
    }

    return pass(
      `verify-without-settle stranded ${fmt(stranded)} USDC on the delegation-rail delegate; gasless ` +
        `sweep returned ${submitted.amount} USDC to the treasury (tx ${submitted.tx_hash}), ` +
        `${fmt(after)} left`,
    )
  },
}
