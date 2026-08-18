/**
 * erc7710 direct settlement — the delegation rail's PRIMARY x402 path (#1064).
 *
 * The shape the architecture was chosen for: authorize builds a narrowed CHILD
 * delegation (exact amount, payee pin, short expiry) re-delegated from the
 * agent's open budget delegation; the delegate key signs it; settle wraps it
 * into the merchant `X-PAYMENT` header; the MERCHANT redeems the
 * [child, budget] chain on-chain and is paid treasury→merchant DIRECTLY.
 *
 * What this proves that nothing else does:
 *   - `POST /x402/authorize` (payTo = merchant) + `POST /x402/:id/settle`
 *     round-trip, including the settle signature verification rewritten in
 *     #1061 — previously invisible to CI.
 *   - **The budget is metered by the settlement itself**: the transfer only
 *     clears through the budget delegation's period enforcer, so the treasury
 *     debit IS the metering (an over-budget child reverts at redemption; the
 *     API-side refusal is x402-over-budget-rejected's job). Asserted as
 *     treasury −amount and merchant +amount, exactly.
 *   - **No funding leg**: the delegate EOA's USDC is UNCHANGED across the
 *     whole flow — the property that makes epic #713's stranded-funds class
 *     structurally absent on this path.
 *
 * The SDK deliberately plays no part: HavenClient has no erc7710 support,
 * so this leg drives the raw API — which is also the merchant-facing
 * contract the scheme ships as. (SDK-side erc7710 remains an open gap;
 * #1058 covered the redeemer-pin wiring, not the client.)
 *
 * Idempotent-safe under QA_MAX_ATTEMPTS: every attempt mints a fresh intent
 * via a unique resource nonce; amounts are at the existing legs' scale.
 */

import { ethers } from 'ethers'
import { HavenApi } from '../lib/haven-api.js'
import { merchant402Reason } from '../lib/merchant-402.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'
import { BASE_SEPOLIA_RPC, SEPOLIA_USDC } from '../lib/chain.js'

const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/** How long to wait for the MERCHANT's on-chain redemption to move balances. */
const SETTLE_WAIT_MS = 90_000
const POLL_MS = 3_000

interface AcceptsEntry {
  scheme?: string
  amount?: string
  payTo?: string
  asset?: string
  network?: string
  maxTimeoutSeconds?: number
  extra?: { assetTransferMethod?: string; facilitatorAddresses?: string[] }
}
interface PaymentRequired {
  accepts?: AcceptsEntry[]
  resource?: { url?: string }
}

function decodeChallenge(headerValue: string | null, bodyText: string): PaymentRequired | null {
  if (headerValue) {
    try {
      return JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8')) as PaymentRequired
    } catch {
      try {
        return JSON.parse(headerValue) as PaymentRequired
      } catch {
        /* fall through to the body */
      }
    }
  }
  // MCP transport can carry the challenge in-band; find the first JSON object
  // with an `accepts` array in the SSE data lines.
  for (const line of bodyText.split('\n')) {
    const idx = line.indexOf('{')
    if (idx === -1) continue
    try {
      const parsed = JSON.parse(line.slice(idx)) as Record<string, unknown>
      const candidate = JSON.stringify(parsed).includes('"accepts"')
        ? (findAccepts(parsed) as PaymentRequired | null)
        : null
      if (candidate) return candidate
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return null
}

function findAccepts(node: unknown): unknown {
  if (!node || typeof node !== 'object') return null
  const record = node as Record<string, unknown>
  if (Array.isArray(record.accepts)) return record
  for (const value of Object.values(record)) {
    const hit = findAccepts(value)
    if (hit) return hit
  }
  return null
}

interface McpToolResult {
  isError?: boolean
  content?: Array<{ text?: string }>
}

function mcpBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'buy_vpn', arguments: { plan: 'basic' } },
  })
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

export const x402Erc7710Settle: Scenario = {
  name: 'x402-erc7710-settle',
  invariant:
    'An erc7710 direct settlement pays the merchant straight from the treasury through the ' +
    'budget delegation — budget metered by the settlement itself, delegate EOA untouched.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — erc7710 settlement needs the dev demo-merchant')
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'erc7710 settlement needs the delegation-rail QA identity (#1063)',
      )
    }

    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)
    const delegate = new ethers.Wallet(ctx.cfg.delegationDelegateKey)
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`

    // ── 1. Trigger the 402 and read the challenge ────────────────────────────
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
      // Under the blocking completeness gate (#1066) this skip FAILS the run —
      // deliberately: once the leg exists, the merchant advertising 3009-only
      // means the dev env regressed (MERCHANT_X402_ERC7710 unset).
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

    // ── 2. Baselines: treasury, merchant, delegate EOA ───────────────────────
    const agentInfo = await api.getAgent()
    const treasury = agentInfo.data.safe_address
    if (!treasury) return fail("could not read the agent's account address from GET /machine-payments/agent")
    const [treasuryBefore, merchantBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(treasury),
      usdc.balanceOf(merchant),
      usdc.balanceOf(delegate.address),
    ])) as [bigint, bigint, bigint]

    // ── 3. Authorize: payTo = the MERCHANT selects erc7710 direct settlement ─
    const resourceUrl = challenge.resource?.url ?? mcpUrl
    const auth = await api.authorizeX402({
      url: resourceUrl,
      payTo: merchant,
      amount: amountAtomic.toString(),
      asset: erc7710Entry.asset ?? SEPOLIA_USDC,
      network: erc7710Entry.network ?? 'base-sepolia',
      // The v2 header echoes the accepted entry field-for-field — the quoted
      // timeout must round-trip or the merchant rejects the echo.
      maxTimeoutSeconds: erc7710Entry.maxTimeoutSeconds,
      // #1058: forward the merchant's advertised facilitators verbatim — the
      // child delegation becomes redeemable ONLY by them, and the merchant's
      // v2 matcher requires them back in the echo. An advertised EMPTY array
      // pins nothing; treat it as absent rather than tripping the 400.
      facilitatorAddresses: erc7710Entry.extra?.facilitatorAddresses?.length
        ? erc7710Entry.extra.facilitatorAddresses
        : undefined,
    })
    if (!auth.ok || !auth.data.payment_id) {
      return fail(`authorize failed (${auth.status}): ${JSON.stringify(auth.data).slice(0, 200)}`)
    }
    const signData = auth.data.sign_data
    if (signData?.signature_scheme !== 'eip712_delegation' || !signData.typed_data) {
      return fail(
        `authorize did not return the erc7710 child payload — signature_scheme was ` +
          `${JSON.stringify(signData?.signature_scheme)} (did the payTo shape select the 3009 bridge?)`,
      )
    }

    // ── 4. Delegate signs the child VERBATIM; settle returns the header ──────
    const types = Object.fromEntries(
      Object.entries(signData.typed_data.types).filter(([key]) => key !== 'EIP712Domain'),
    )
    const signature = await delegate.signTypedData(
      signData.typed_data.domain,
      types as never,
      signData.typed_data.message,
    )
    const settle = await api.settleX402(auth.data.payment_id, signature)
    if (!settle.ok || !settle.data.payment_header) {
      return fail(`settle failed (${settle.status}): ${JSON.stringify(settle.data).slice(0, 200)}`)
    }

    // ── 5. Merchant retry with X-PAYMENT — the merchant redeems on-chain ─────
    const paid = await fetch(mcpUrl, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'X-PAYMENT': settle.data.payment_header },
      body: mcpBody(2),
    })
    if (paid.status === 402) {
      return fail(`merchant still returned 402 with the erc7710 header${await merchant402Reason(paid)}`)
    }
    const paidText = await paid.text()
    let served = false
    for (const line of paidText.split('\n')) {
      const idx = line.indexOf('{')
      if (idx === -1) continue
      try {
        const parsed = JSON.parse(line.slice(idx)) as { result?: McpToolResult }
        if (parsed.result && !parsed.result.isError) served = true
        if (parsed.result?.isError) {
          const reason = parsed.result.content?.[0]?.text ?? ''
          return fail(`merchant rejected the erc7710 payment: ${reason.slice(0, 160)}`)
        }
      } catch {
        /* keep scanning */
      }
    }
    if (!served) return fail(`merchant response unparseable: ${paidText.slice(0, 160)}`)

    // ── 6. The money proof: direct settlement, no funding leg ────────────────
    const deadline = Date.now() + SETTLE_WAIT_MS
    let treasuryAfter = treasuryBefore
    let merchantAfter = merchantBefore
    for (;;) {
      ;[treasuryAfter, merchantAfter] = (await Promise.all([
        usdc.balanceOf(treasury),
        usdc.balanceOf(merchant),
      ])) as [bigint, bigint]
      if (treasuryAfter !== treasuryBefore || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    const fmt = (value: bigint) => ethers.formatUnits(value, 6)
    if (treasuryBefore - treasuryAfter !== amountAtomic) {
      return fail(
        `treasury moved ${fmt(treasuryBefore - treasuryAfter)} USDC, expected exactly ` +
          `${fmt(amountAtomic)} — the budget delegation was not the settlement source`,
      )
    }
    if (merchantAfter - merchantBefore !== amountAtomic) {
      return fail(
        `merchant received ${fmt(merchantAfter - merchantBefore)} USDC, expected exactly ` +
          `${fmt(amountAtomic)} — settlement did not pay the merchant directly`,
      )
    }
    const delegateAfter = (await usdc.balanceOf(delegate.address)) as bigint
    if (delegateAfter !== delegateBefore) {
      return fail(
        `delegate EOA balance changed ${fmt(delegateBefore)} → ${fmt(delegateAfter)} — ` +
          'a funding leg ran; this was not direct settlement',
      )
    }

    // ── 7. The intent recorded the merchant, not a funding target ────────────
    const payment = await api.getPayment(auth.data.payment_id)
    const recordedTo = (payment.data as { to?: string; recipient?: string }).to
      ?? (payment.data as { recipient?: string }).recipient
    if (recordedTo && recordedTo.toLowerCase() !== merchant.toLowerCase()) {
      return fail(`intent records recipient ${recordedTo}, expected the merchant ${merchant}`)
    }
    const status = payment.data.status
    if (status !== 'submitted' && status !== 'confirmed') {
      return fail(`intent status is '${status}', expected submitted/confirmed after settlement`)
    }

    return pass(
      `erc7710 direct settlement: treasury ${fmt(treasuryBefore)} → ${fmt(treasuryAfter)} paid the ` +
        `merchant exactly ${fmt(amountAtomic)} USDC through the budget delegation; delegate EOA ` +
        `untouched (${fmt(delegateAfter)}); intent ${auth.data.payment_id} ${status}`,
    )
  },
}
