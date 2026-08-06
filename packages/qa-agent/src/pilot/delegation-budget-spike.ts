/**
 * Spike #820 (epic #821, gate G1) — Hybrid DeleGator as the budget rail:
 * the #818 shared test matrix, cases 1–7, in one run on Base Sepolia.
 *
 * What this proves (or kills):
 *   1. GRANT    — one owner signature over a delegation with a period-budget
 *                 scope + recipient pin + expiry (payload size recorded)
 *   2. SPEND    — delegate redeems a direct treasury→recipient USDC transfer
 *                 (no funding leg; the delegate never holds USDC)
 *   3. OVERSPEND— exceeding the period budget reverts ON-CHAIN
 *   4. ROLLOVER — after the period boundary the budget refills NATIVELY:
 *                 second spend succeeds with ZERO new signatures (headline)
 *   5. RECIPIENT— pinned delegation blocks an unlisted recipient; the OPEN
 *                 (recipient-less) variant transfers freely (#810 two-mode)
 *   6. REVOKE   — disableDelegation (owner UserOp) kills further redemption
 *   7. METRICS  — gas + latency per redemption, for the RFC #791 scorecard
 *
 * Non-custody note: the owner key signs delegations OFFLINE (no tx at grant
 * time); the delegate EOA holds only gas ETH, never USDC; sponsorship of the
 * redemption itself is the #826 work — here the delegate pays its own gas,
 * which is fine for mechanics (the delegate still cannot exceed the caveats).
 *
 * Testnet-only. Reuses the #452 delegator (same key → same Hybrid address,
 * still funded). Env (~/.haven/pilot.env):
 *   PILOT_7710_DELEGATOR_PRIVATE_KEY  (throwaway owner of the Hybrid)
 *   PILOT_OWNER_PRIVATE_KEY           (gas fountain for the delegate EOA)
 *   PILOT_BUNDLER_URL                 (SECRET — sponsored deploy/revoke ops)
 *   PILOT_ALLOWED_RECIPIENT           (recipient A)
 *   PILOT_RPC_URL?                    (default sepolia.base.org)
 *   SPIKE_PERIOD_SEC?                 (default 300 — short, observable)
 *
 * Run: npm run pilot:delegation-spike -w packages/qa-agent
 */

import {
  http,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  pad,
  type Hex,
  type Address,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { entryPoint07Address } from 'viem/account-abstraction'
import { createSmartAccountClient } from 'permissionless'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import {
  Implementation,
  toMetaMaskSmartAccount,
  createDelegation,
  createOpenDelegation,
  signDelegation,
  createExecution,
  ExecutionMode,
  contracts,
  type Delegation,
} from '@metamask/smart-accounts-kit'

const CHAIN = baseSepolia
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required.`)
    process.exit(2)
  }
  return value
}

const results: Array<{ case_: string; pass: boolean; evidence: string }> = []
function record(case_: string, pass: boolean, evidence: string): void {
  results.push({ case_, pass, evidence })
  console.log(`  ${pass ? '✅' : '❌'} ${case_}: ${evidence}`)
}

async function main(): Promise<void> {
  const delegatorKey = requireEnv('PILOT_7710_DELEGATOR_PRIVATE_KEY') as Hex
  const gasKey = requireEnv('PILOT_OWNER_PRIVATE_KEY') as Hex
  const bundlerUrl = requireEnv('PILOT_BUNDLER_URL')
  const recipientA = requireEnv('PILOT_ALLOWED_RECIPIENT') as Address
  const rpcUrl = process.env.PILOT_RPC_URL ?? 'https://sepolia.base.org'
  const periodSec = Number(process.env.SPIKE_PERIOD_SEC ?? 300)
  const budget = 50_000n // 0.05 USDC per period
  const spend = 30_000n // 0.03 per redemption → two spends exceed one period

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl) })
  const owner = privateKeyToAccount(delegatorKey)
  const gasWallet = createWalletClient({
    account: privateKeyToAccount(gasKey),
    chain: CHAIN,
    transport: http(rpcUrl),
  })

  // The "agent key" of this spike — reusable via env so gas ETH survives runs.
  const delegateKey = (process.env.SPIKE_DELEGATE_KEY as Hex) ?? generatePrivateKey()
  const delegate = privateKeyToAccount(delegateKey)
  const delegateWallet = createWalletClient({ account: delegate, chain: CHAIN, transport: http(rpcUrl) })

  // ── The delegator: the #452 Hybrid smart account (same key → same address) ─
  const smartAccount = await toMetaMaskSmartAccount({
    // Two viem instances exist in the type graph (the kit pins its own);
    // runtime-identical — same seam-cast pattern as the module-sdk calls.
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: '0x',
    signer: { account: owner },
  })
  const delegator = smartAccount.address
  const env = smartAccount.environment
  console.log(`delegator (Hybrid):   ${delegator}`)
  console.log(`delegate (agent EOA): ${delegate.address}`)
  console.log(`recipient A:          ${recipientA}`)
  console.log(`delegation manager:   ${env.DelegationManager}`)
  console.log(`period: ${periodSec}s · budget: ${formatUnits(budget, 6)} USDC/period`)

  const pimlico = createPimlicoClient({
    transport: http(bundlerUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  })
  const accountClient = createSmartAccountClient({
    account: smartAccount,
    chain: CHAIN,
    bundlerTransport: http(bundlerUrl),
    paymaster: pimlico,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
    },
  })

  const code = await publicClient.getCode({ address: delegator })
  if (!code || code === '0x') {
    console.log('deploying delegator (sponsored UserOp)…')
    const hash = await accountClient.sendUserOperation({ calls: [{ to: delegator, value: 0n, data: '0x' }] })
    await pimlico.waitForUserOperationReceipt({ hash })
  }
  const usdcBalance = (await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [delegator],
  })) as bigint
  console.log(`delegator USDC: ${formatUnits(usdcBalance, 6)}`)
  if (usdcBalance < 100_000n) {
    console.error(`fund ${delegator} with ≥0.1 Base Sepolia USDC and re-run`)
    process.exit(2)
  }

  // Gas for the delegate (mechanics only — sponsorship is #826's work).
  // Base Sepolia redemptions cost ~0.0000003 ETH each; 0.00005 covers many.
  const existingGas = await publicClient.getBalance({ address: delegate.address })
  if (existingGas < 10_000_000_000_000n) {
    console.log('funding delegate gas…')
    const fundTx = await gasWallet.sendTransaction({ to: delegate.address, value: 50_000_000_000_000n })
    await publicClient.waitForTransactionReceipt({ hash: fundTx })
  } else {
    console.log(`delegate already has gas (${existingGas} wei) — skipping funding`)
  }
  // The public RPC lags reads-after-writes (documented pilot gotcha): wait
  // until gas ESTIMATION can actually see the balance, or case 2 false-fails
  // with "gas required exceeds allowance (0)".
  for (let i = 0; i < 24; i++) {
    const bal = await publicClient.getBalance({ address: delegate.address })
    if (bal > 0n) break
    await new Promise((r) => setTimeout(r, 5000))
  }

  // ── CASE 1 · GRANT: one signature per delegation, offline ─────────────────
  const nowSec = Math.floor(Date.now() / 1000)
  // 60s in the past: local clock can be AHEAD of chain time — observed live
  // as ERC20PeriodTransferEnforcer:transfer-not-started (run 6).
  const startDate = nowSec - 60
  const scope = {
    type: 'erc20PeriodTransfer' as const,
    tokenAddress: USDC,
    periodAmount: budget,
    periodDuration: periodSec,
    startDate,
  }
  // Restricted: recipient pinned via calldata (transfer(to,…) → `to` at byte 4).
  const restricted = createDelegation({
    environment: env,
    from: delegator,
    to: delegate.address,
    scope,
    caveats: [
      { type: 'allowedCalldata', startIndex: 4, value: pad(recipientA.toLowerCase() as Hex, { size: 32 }) },
      { type: 'timestamp', afterThreshold: 0, beforeThreshold: nowSec + 6 * 3600 },
    ],
  })
  const open = createOpenDelegation({
    environment: env,
    from: delegator,
    scope,
    caveats: [{ type: 'timestamp', afterThreshold: 0, beforeThreshold: nowSec + 6 * 3600 }],
  })

  const signedRestricted: Delegation = {
    ...restricted,
    signature: await signDelegation({
      privateKey: delegatorKey,
      delegation: restricted,
      delegationManager: env.DelegationManager,
      chainId: CHAIN.id,
    }),
  }
  const signedOpen: Delegation = {
    ...open,
    signature: await signDelegation({
      privateKey: delegatorKey,
      delegation: open,
      delegationManager: env.DelegationManager,
      chainId: CHAIN.id,
    }),
  }
  const payloadBytes = JSON.stringify(signedRestricted).length
  record('1 GRANT', true,
    `1 offline signature per delegation, no tx; restricted payload ≈${payloadBytes} bytes; caveats: [erc20PeriodTransfer, allowedCalldata(recipient), timestamp]`)

  // ── Redemption helper: the delegate calls redeemDelegations directly ──────
  async function redeem(
    delegation: Delegation,
    to: Address,
    amount: bigint,
  ): Promise<{ ok: boolean; gasUsed?: bigint; ms: number; tx?: Hex; err?: string }> {
    const execution = createExecution({
      target: USDC,
      value: 0n,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] }),
    })
    const data = contracts.DelegationManager.encode.redeemDelegations({
      delegations: [[delegation]],
      modes: [ExecutionMode.SingleDefault],
      executions: [[execution]],
    })
    const started = Date.now()
    try {
      const tx = await delegateWallet.sendTransaction({ to: env.DelegationManager, data })
      const receipt = await publicClient.waitForTransactionReceipt({ hash: tx })
      if (receipt.status !== 'success') return { ok: false, ms: Date.now() - started, err: 'reverted', tx }
      return { ok: true, gasUsed: receipt.gasUsed, ms: Date.now() - started, tx }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const infra = /allowance \(0\)|insufficient funds|nonce|timeout|ECONN/i.test(msg)
      return { ok: false, ms: Date.now() - started, err: (infra ? 'INFRA: ' : '') + msg.slice(0, 140) }
    }
  }
  /** A negative case only counts if the failure is an ON-CHAIN revert, not infra. */
  const genuineRevert = (r: { ok: boolean; err?: string }) => !r.ok && !(r.err ?? '').startsWith('INFRA:')

  // ── CASE 2 · SPEND within budget — direct, no funding leg ─────────────────
  const spend1 = await redeem(signedRestricted, recipientA, spend)
  record('2 SPEND', spend1.ok,
    spend1.ok ? `direct ${formatUnits(spend, 6)} USDC delegator→A, gas ${spend1.gasUsed}, ${spend1.ms}ms — tx ${spend1.tx}` : `FAILED: ${spend1.err}`)

  // ── CASE 3 · OVERSPEND within the period — must revert on-chain ───────────
  const spend2 = await redeem(signedRestricted, recipientA, spend) // 0.03+0.03 > 0.05
  record('3 OVERSPEND', genuineRevert(spend2), genuineRevert(spend2) ? `second ${formatUnits(spend, 6)} in the same period reverted (${(spend2.err ?? 'revert').slice(0, 80)})` : `UNEXPECTED SUCCESS tx ${spend2.tx}`)

  // ── CASE 5 · RECIPIENT modes ───────────────────────────────────────────────
  const strangers = privateKeyToAccount(generatePrivateKey()).address
  const blocked = await redeem(signedRestricted, strangers, 10_000n)
  const openSpend = await redeem(signedOpen, strangers, 10_000n)
  record('5 RECIPIENT', genuineRevert(blocked) && openSpend.ok,
    `pinned→stranger ${blocked.ok ? 'PASSED (bad!)' : 'blocked ✓'} · open→stranger ${openSpend.ok ? `paid ✓ tx ${openSpend.tx}` : `FAILED: ${openSpend.err}`}`)

  // ── CASE 4 · ROLLOVER — zero signatures (the headline) ────────────────────
  const nextBoundary = (Math.floor(nowSec / periodSec) + 1) * periodSec
  const waitMs = Math.max(0, (nextBoundary - Math.floor(Date.now() / 1000)) * 1000 + 5000)
  // NOTE: startDate-anchored periods — boundary = startDate + n*periodDuration.
  const boundaryFromStart = startDate + periodSec
  const waitMs2 = Math.max(0, (boundaryFromStart - Math.floor(Date.now() / 1000)) * 1000 + 5000)
  const wait = Math.max(waitMs, waitMs2)
  console.log(`  waiting ${Math.ceil(wait / 1000)}s for the period boundary…`)
  await new Promise((r) => setTimeout(r, wait))
  const spend3 = await redeem(signedRestricted, recipientA, spend)
  record('4 ROLLOVER', spend3.ok,
    spend3.ok ? `fresh period budget spent with ZERO new signatures — native refill, gas ${spend3.gasUsed} — tx ${spend3.tx}` : `FAILED: ${spend3.err}`)

  // ── CASE 6 · REVOKE — disableDelegation via owner UserOp ──────────────────
  const disableData = contracts.DelegationManager.encode.disableDelegation({ delegation: signedRestricted })
  const revokeHash = await accountClient.sendUserOperation({
    calls: [{ to: env.DelegationManager, value: 0n, data: disableData }],
  })
  const revokeReceipt = await pimlico.waitForUserOperationReceipt({ hash: revokeHash })
  const afterRevoke = await redeem(signedRestricted, recipientA, 10_000n)
  record('6 REVOKE', genuineRevert(afterRevoke),
    `disableDelegation tx ${revokeReceipt.receipt.transactionHash} → further redemption ${afterRevoke.ok ? 'STILL WORKS (bad!)' : 'fails ✓'}`)

  // ── CASE 8 · SPONSORED redemption — delegate as smart account, ZERO ETH ───
  // The #826 shape: the delegate is itself a (counterfactual) Hybrid whose
  // owner is the agent key; redemption rides a sponsored UserOp. The agent
  // EOA holds NO ETH and NO USDC — Haven holds no key at all.
  const agentKey = generatePrivateKey()
  const agentOwner = privateKeyToAccount(agentKey)
  const delegateSA = await toMetaMaskSmartAccount({
    client: publicClient as never,
    implementation: Implementation.Hybrid,
    deployParams: [agentOwner.address, [], [], []],
    deploySalt: '0x',
    signer: { account: agentOwner },
  })
  const sponsoredDelegation = createDelegation({
    environment: env,
    from: delegator,
    to: delegateSA.address,
    scope: { ...scope, startDate: Math.floor(Date.now() / 1000) },
    caveats: [{ type: 'timestamp', afterThreshold: 0, beforeThreshold: nowSec + 6 * 3600 }],
  })
  const signedSponsored: Delegation = {
    ...sponsoredDelegation,
    signature: await signDelegation({
      privateKey: delegatorKey,
      delegation: sponsoredDelegation,
      delegationManager: env.DelegationManager,
      chainId: CHAIN.id,
    }),
  }
  const sponsoredExec = createExecution({
    target: USDC,
    value: 0n,
    callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [recipientA, 10_000n] }),
  })
  const sponsoredData = contracts.DelegationManager.encode.redeemDelegations({
    delegations: [[signedSponsored]],
    modes: [ExecutionMode.SingleDefault],
    executions: [[sponsoredExec]],
  })
  try {
    const delegateClient = createSmartAccountClient({
      account: delegateSA,
      chain: CHAIN,
      bundlerTransport: http(bundlerUrl),
      paymaster: pimlico,
      userOperation: {
        estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
      },
    })
    const t8 = Date.now()
    const sponsoredHash = await delegateClient.sendUserOperation({
      calls: [{ to: env.DelegationManager, value: 0n, data: sponsoredData }],
    })
    const sponsoredReceipt = await pimlico.waitForUserOperationReceipt({ hash: sponsoredHash })
    record('8 SPONSORED', sponsoredReceipt.success === true,
      `delegate smart account (agent EOA holds ZERO ETH) redeemed via sponsored UserOp — gas ${sponsoredReceipt.actualGasUsed}, ${Date.now() - t8}ms — tx ${sponsoredReceipt.receipt.transactionHash}`)
  } catch (err) {
    record('8 SPONSORED', false, `FAILED: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`)
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n════ #818 MATRIX (arm B) ════')
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.case_} — ${r.evidence}`)
  const gases = [spend1, spend3].filter((s) => s.gasUsed).map((s) => s.gasUsed!)
  if (gases.length) {
    console.log(`\n7 METRICS: redemption gas ${gases.join(', ')} · latency ${[spend1, spend3].map((s) => s.ms + 'ms').join(', ')}`)
    console.log('   (session-rail UserOp baseline for comparison lives in compare-rails/#723 data)')
  }
  const allPass = results.every((r) => r.pass)
  console.log(allPass ? '\n✅ ARM B MATRIX GREEN' : '\n❌ MATRIX HAS FAILURES')
  process.exit(allPass ? 0 : 1)
}

main().catch((e) => {
  console.error('delegation-budget-spike failed:', e instanceof Error ? e.message : e)
  process.exit(1)
})
