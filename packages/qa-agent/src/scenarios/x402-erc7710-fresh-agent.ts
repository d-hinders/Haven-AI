/**
 * erc7710 whose FIRST-EVER payment is the settlement — the counterfactual
 * delegate account (#1674, regression net for #1667).
 *
 * Every environment where erc7710 was green used an agent whose delegate
 * hybrid account was already deployed by a prior EIP-3009 funding leg (that
 * leg deploys it as a side effect of its first UserOp initCode). The
 * DelegationManager verifies the settlement child's signature via EIP-1271
 * when its delegator has code and ecrecover when it does not — so against a
 * counterfactual account the delegate EOA's signature recovers to the EOA ≠
 * delegator, and redemption reverts InvalidEOASignature. Invisible in every
 * long-lived test identity; found in prod. #1667 made authorize deploy the
 * account; THIS leg is what keeps that true.
 *
 * So: provision a fresh throwaway identity (new random delegate key — its
 * hybrid account address derives from that key, so it cannot have code),
 * assert the account is literally counterfactual on-chain, then make the
 * agent's first-ever payment via erc7710 direct settlement and assert
 *   1. authorize deployed the account (code exists BEFORE settle — pinning
 *      WHERE the deploy happens, per #1667's fail-closed placement),
 *   2. the merchant redemption settles treasury→merchant exactly,
 *   3. the delegate EOA is untouched (no funding leg ran).
 *
 * The long-lived-agent leg (x402-erc7710-settle) stays: it proves the steady
 * state; this proves the cold start.
 */

import { ethers } from 'ethers'
import { HavenApi } from '../lib/haven-api.js'
import { merchant402Reason } from '../lib/merchant-402.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'
import { BASE_SEPOLIA_RPC, SEPOLIA_USDC } from '../lib/chain.js'
import { MCP_HEADERS, decodeChallenge, mcpBody, readMcpOutcome } from '../lib/merchant-mcp.js'
import { provisionThrowawayIdentity, payViaDelegation, signTyped } from '../lib/throwaway-identity.js'

const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const
const CHAIN_ID = 84532

/** Covers one demo-merchant purchase (0.0015) with margin; funded per run. */
const FUND_HUMAN = '0.006'
const BUDGET_ATOMIC = '10000' // 0.01 USDC/day — the throwaway grant

const SETTLE_WAIT_MS = 90_000
const POLL_MS = 3_000

export const x402Erc7710FreshAgent: Scenario = {
  name: 'x402-erc7710-fresh-agent',
  invariant:
    "A brand-new agent's FIRST-EVER payment can be erc7710 direct settlement: authorize deploys " +
    'the counterfactual delegate account, and the merchant redemption settles treasury→merchant.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — erc7710 settlement needs the dev demo-merchant')
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the fresh-agent leg needs the standing identity as its funding source (#1063)',
      )
    }

    const apiUrl = ctx.cfg.apiUrl
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`

    // ── 1. Fresh identity: random delegate key → counterfactual account ─────
    const identity = await provisionThrowawayIdentity(apiUrl, {
      chainId: CHAIN_ID, budgetAtomic: BUDGET_ATOMIC, label: 'fresh7710',
    })
    if ('error' in identity) return fail(identity.error)

    // The whole point of the leg: prove the delegate hybrid account has NO
    // code before the first payment. The address comes from the grant build
    // (it is the budget delegation's delegate), so this reads the chain at a
    // moment when no payment of any kind has existed for this agent.
    if (!identity.delegateAccountAddress) {
      return fail(
        'grant build returned no delegate_account_address — cannot assert the counterfactual ' +
          'precondition this leg exists for',
      )
    }
    const codeBefore = await provider.getCode(identity.delegateAccountAddress)
    if (codeBefore !== '0x') {
      return fail(
        `delegate account ${identity.delegateAccountAddress} already has code before any payment — ` +
          'the fixture is not fresh, so this run proves nothing about the counterfactual path',
      )
    }

    // ── 2. Fund the throwaway treasury from the standing identity ────────────
    const funding = await payViaDelegation(
      apiUrl, ctx.cfg.delegationAgentApiKey, ctx.cfg.delegationDelegateKey,
      identity.safeAddress, FUND_HUMAN,
    )
    if (!funding.ok) return fail(`funding the throwaway treasury failed: ${funding.error}`)

    // ── 3. The 402 challenge ─────────────────────────────────────────────────
    const challengeRes = await fetch(mcpUrl, { method: 'POST', headers: MCP_HEADERS, body: mcpBody(1) })
    const challengeText = await challengeRes.text()
    const challenge = decodeChallenge(challengeRes.headers.get('PAYMENT-REQUIRED'), challengeText)
    if (!challenge?.accepts?.length) {
      return fail(`no x402 challenge from the merchant (HTTP ${challengeRes.status})`)
    }
    const erc7710Entry = challenge.accepts.find(
      (entry) => entry.extra?.assetTransferMethod === 'erc7710',
    )
    if (!erc7710Entry) {
      return skip(
        'demo-merchant does not advertise erc7710 — set MERCHANT_X402_ERC7710=1 + ' +
          'MERCHANT_ERC7710_DELEGATION_MANAGER on the dev merchant (see dev-environment.md)',
      )
    }
    const amountAtomic = BigInt(erc7710Entry.amount ?? '0')
    const merchant = erc7710Entry.payTo
    if (!merchant || amountAtomic <= 0n) {
      return fail(`unusable erc7710 accepts entry: ${JSON.stringify(erc7710Entry).slice(0, 160)}`)
    }

    const [treasuryBefore, merchantBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(identity.safeAddress),
      usdc.balanceOf(merchant),
      usdc.balanceOf(identity.delegate.address),
    ])) as [bigint, bigint, bigint]

    // ── 4. FIRST-EVER payment: authorize must deploy the account (#1667) ─────
    const api = new HavenApi(ctx.cfg, identity.agentApiKey)
    const auth = await api.authorizeX402({
      url: challenge.resource?.url ?? mcpUrl,
      payTo: merchant,
      amount: amountAtomic.toString(),
      asset: erc7710Entry.asset ?? SEPOLIA_USDC,
      network: erc7710Entry.network ?? 'base-sepolia',
      maxTimeoutSeconds: erc7710Entry.maxTimeoutSeconds,
      facilitatorAddresses: erc7710Entry.extra?.facilitatorAddresses?.length
        ? erc7710Entry.extra.facilitatorAddresses
        : undefined,
      // #2373: same challenge passthrough as x402-erc7710-settle — the stored
      // copy feeds the settle-side resource/extensions echo (#2361).
      paymentRequired: challenge as unknown as Record<string, unknown>,
    })
    if (!auth.ok || !auth.data.payment_id) {
      return fail(`fresh-agent authorize failed (${auth.status}): ${JSON.stringify(auth.data).slice(0, 200)}`)
    }
    const signData = auth.data.sign_data
    if (signData?.signature_scheme !== 'eip712_delegation' || !signData.typed_data) {
      return fail(
        `authorize did not return the erc7710 child payload — signature_scheme was ` +
          `${JSON.stringify(signData?.signature_scheme)}`,
      )
    }

    // Between authorize and settle: the account must have code NOW. This pins
    // WHERE the deploy happens — authorize, fail-closed before the intent row
    // (#1667) — not as a side effect of redemption, which would revert first.
    const codeAfterAuthorize = await provider.getCode(identity.delegateAccountAddress)
    if (codeAfterAuthorize === '0x') {
      return fail(
        `authorize succeeded but ${identity.delegateAccountAddress} still has no code — ` +
          'the #1667 deploy did not run, and redemption would revert InvalidEOASignature',
      )
    }

    // ── 5. Sign the child, settle, merchant retry ────────────────────────────
    const signature = await signTyped(identity.delegate, signData.typed_data)
    const settle = await api.settleX402(auth.data.payment_id, signature)
    if (!settle.ok || !settle.data.payment_header) {
      return fail(`settle failed (${settle.status}): ${JSON.stringify(settle.data).slice(0, 200)}`)
    }

    const paid = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        // erc7710 is always x402 v2, and its header carries a whole
        // delegation chain — sending the v1 alias too pushed the request past
        // the merchant's header-size limit (HTTP 431, #2341). v2 name only
        // here; the EIP-3009 scenarios still send both.
        'PAYMENT-SIGNATURE': settle.data.payment_header,
      },
      body: mcpBody(2),
    })
    if (paid.status === 402) {
      return fail(`merchant still returned 402 with the erc7710 header${await merchant402Reason(paid)}`)
    }
    const outcome = readMcpOutcome(await paid.text())
    if (outcome.rejection !== undefined) {
      return fail(`merchant rejected the fresh agent's erc7710 payment: ${outcome.rejection.slice(0, 160)}`)
    }
    if (!outcome.served) return fail('merchant response unparseable')

    // ── 6. Money proof: direct settlement, no funding leg ────────────────────
    const deadline = Date.now() + SETTLE_WAIT_MS
    let treasuryAfter = treasuryBefore
    let merchantAfter = merchantBefore
    for (;;) {
      ;[treasuryAfter, merchantAfter] = (await Promise.all([
        usdc.balanceOf(identity.safeAddress),
        usdc.balanceOf(merchant),
      ])) as [bigint, bigint]
      if (treasuryAfter !== treasuryBefore || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    const fmt = (value: bigint) => ethers.formatUnits(value, 6)
    if (treasuryBefore - treasuryAfter !== amountAtomic) {
      return fail(
        `treasury moved ${fmt(treasuryBefore - treasuryAfter)} USDC, expected exactly ${fmt(amountAtomic)}`,
      )
    }
    if (merchantAfter - merchantBefore !== amountAtomic) {
      return fail(
        `merchant received ${fmt(merchantAfter - merchantBefore)} USDC, expected exactly ${fmt(amountAtomic)}`,
      )
    }
    const delegateAfter = (await usdc.balanceOf(identity.delegate.address)) as bigint
    if (delegateAfter !== delegateBefore) {
      return fail(
        `delegate EOA balance changed ${fmt(delegateBefore)} → ${fmt(delegateAfter)} — a funding leg ran`,
      )
    }

    return pass(
      `fresh agent's first-ever payment settled via erc7710: account ${identity.delegateAccountAddress} ` +
        `counterfactual → deployed by authorize; merchant paid exactly ${fmt(amountAtomic)} USDC ` +
        `treasury-direct; delegate EOA untouched`,
    )
  },
}
