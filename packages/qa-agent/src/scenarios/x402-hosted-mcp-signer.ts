/**
 * #1154 invariant: the **default topology** — hosted MCP + a local edge signer —
 * completes an x402 payment on the delegation rail, both legs on-chain, and
 * leaves the delegate holding nothing.
 *
 * ## Why this leg had to exist
 *
 * Every user the connect flow onboards runs hosted MCP plus a local edge signer,
 * and until #1154 nothing in CI or the promotion gate ever executed that
 * combination. A grep settled it: no file under `packages/qa-agent/src/`
 * mentioned the hosted MCP server, `@haven_ai/signer`, or `createEdgeSigner`.
 * All three x402 scenarios build a `HavenClient` with a `delegateKey` — the
 * SDK-direct path, where the SDK signs in-process and three things are bypassed
 * wholesale: the hosted server's **keyless** branch, the **Haven-signed expected
 * context**, and the signer's **verify-then-sign** logic.
 *
 * #1138 was a hard failure of exactly that uncovered path — a delegation-rail
 * agent could not pay through the hosted MCP at all — and a human driving an
 * agent by hand found it, not a test. `qa-freshness` refuses a `dev → main`
 * promotion without a recent green `qa-dev`, which reads as "the money path was
 * exercised"; for the hosted topology that was not what a green run meant.
 *
 * ## What it drives, and where the signer lives
 *
 * The REAL deployed hosted MCP over HTTP (`QA_HOSTED_MCP_URL`), and the REAL
 * `@haven_ai/signer` **in-process** via `createEdgeSigner` — the route #1154
 * recommends. In-process rather than a spawned stdio MCP because every piece the
 * bug was actually in (the keyless branch, the wire shapes, the binding, the
 * signing) is exercised either way, and stdio adds process plumbing to a CI leg
 * without adding coverage of the thing under test.
 *
 * One deliberate refinement on that recommendation: signing goes through the
 * signer's **tool handler** (`createToolHandlers(...).haven_sign_x402`), not the
 * bare `EdgeSigner` method. #1154 notes that an in-process EdgeSigner call skips
 * the MCP tool-schema boundary — the seam where the #1143 skew surfaced as a Zod
 * rejection. Routing through the handler costs nothing and puts the live quote
 * through that same Zod schema, so a schema/wire divergence fails here too. (The
 * unit-level schema pin lives in `packages/mcp-server/src/*wire-contract*`.)
 *
 * ## The assertions that stop this passing vacuously
 *
 * A merchant round-trip succeeding proves very little on its own — the same
 * green would appear if the agent had silently taken the legacy rail, or if the
 * signer had never been consulted. Four discriminators:
 *
 *   - **The quote must be v2 — and compact.** `x402.expected.typed_data_hash`
 *     present ⇒ the delegation-rail context, and `signature_scheme:
 *     'eip712_userop'` ⇒ the account validates typed data. Since #1272 the
 *     quote must NOT carry `typed_data`/`typed_data_b64` by default — the
 *     signer fetches the exact bytes from Haven by `payment_id` (#1263), and
 *     this leg asserts that production shape rather than opting out of it. A
 *     v1 quote here means the identity is not on the rail this leg claims to
 *     cover, and the whole #1138 seam went untouched. Asserted as a FAILURE,
 *     not a skip.
 *   - **The signer must actually sign it.** The handler's refusal paths are the
 *     security property (#1138); a returned `success: false` is a hard failure
 *     with the signer's own message, never swallowed.
 *   - **Both on-chain legs must have succeeded.** The funding redemption and the
 *     merchant settlement are two distinct transactions with `status === 1`.
 *     Fetching both receipts is what separates "the merchant said yes" from
 *     "money moved" — Haven never observes the merchant's settlement itself, so
 *     the hash it relays back is the only handle on that leg.
 *   - **Zero residual.** Exact-amount funding means a settled payment leaves the
 *     delegate EOA at exactly zero. Not "below the sweep floor" — that
 *     tolerance belongs to `x402-delegation-3009`, whose merchant may verify
 *     without settling. Here the merchant settles, so anything left is a bug.
 *
 * ## What it does NOT cover
 *
 * The stdio signer transport (see above), and the erc7710 direct-settlement
 * scheme (`x402-erc7710-settle`). This leg is the 3009 bridge as an agent
 * runtime drives it, which is the topology the connect flow ships.
 */

import { ethers } from 'ethers'
import { createEdgeSigner, createToolHandlers } from '@haven_ai/signer'
import { HavenApi } from '../lib/haven-api.js'
import {
  HostedMcpClient,
  HostedMcpToolError,
  type HostedPayMcpToolResult,
  type HostedSettleMcpToolResult,
} from '../lib/hosted-mcp.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'
import { BASE_SEPOLIA_RPC, SEPOLIA_USDC } from '../lib/chain.js'

const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/**
 * How long to wait for the merchant-leg receipt to be visible on the RPC.
 *
 * The settle call returns only once the merchant responded, so the funding
 * receipt is always available by then; the facilitator's settlement tx can still
 * be a block or two behind the node this harness reads.
 *
 * Mutable purely as a TEST SEAM, matching `x402-delegation-3009`'s `TIMING`.
 */
export const TIMING = { receiptWaitMs: 60_000, balanceWaitMs: 90_000, pollIntervalMs: 3_000 }

/** The signer tool's success payload (`@haven_ai/signer` `haven_sign_x402`). */
interface SignX402Data {
  signature: string
  x402_binding: string
  payment_header: string
  accepted: Record<string, unknown>
}

/**
 * Wait for a transaction receipt, tolerating an RPC that has not yet indexed a
 * just-mined tx. Returns null on timeout — the caller reports which leg.
 */
async function waitForReceipt(
  provider: ethers.JsonRpcProvider,
  hash: string,
): Promise<ethers.TransactionReceipt | null> {
  const deadline = Date.now() + TIMING.receiptWaitMs
  for (;;) {
    const receipt = await provider.getTransactionReceipt(hash).catch(() => null)
    if (receipt) return receipt
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, TIMING.pollIntervalMs))
  }
}

/**
 * The ONLY merchant plan that advertises eip3009 ALONE (#1441).
 *
 * Every other product also offers erc7710, and #1450's preference rule then
 * picks it — which has no funding leg, leaving this leg's invariant ("two
 * on-chain legs, zero delegate residual") with nothing to assert. That is why
 * this leg skipped permanently rather than failing: it was unreachable, not
 * broken.
 *
 * Both the quote and the settle must name the same plan, so it lives here
 * rather than being written twice.
 */
const FUNDING_LEG_PLAN = 'legacy'

export const x402HostedMcpSigner: Scenario = {
  name: 'x402-hosted-mcp-signer',
  invariant:
    'The default topology (hosted MCP + local edge signer) completes a delegation-rail x402 ' +
    'payment: a v2 expected context is signed locally, both on-chain legs succeed, and the ' +
    'delegate is left with zero residual.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — the hosted leg needs the dev demo-merchant')
    }
    if (!ctx.cfg.hostedMcpUrl) {
      return skip(
        'QA_HOSTED_MCP_URL not set — the hosted leg drives the DEPLOYED hosted MCP over HTTP ' +
          '(e.g. https://haven-ai-hosted-mcp-dev-25c7.up.railway.app/v1); see docs/operations/agent-qa.md',
      )
    }
    if (!ctx.cfg.x402BindingSigner) {
      return skip(
        'QA_X402_BINDING_SIGNER not set — the edge signer refuses to verify a Haven expected ' +
          'context without the trusted binding-signer address, and defaulting it from the quote ' +
          'would make the check assert nothing',
      )
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — ' +
          'the hosted leg needs a delegation-rail agent with an OPEN (unpinned) budget',
      )
    }

    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
    const fmt = (value: bigint) => ethers.formatUnits(value, 6)
    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`

    // The signer that a connect-flow user runs locally: holds the delegate key,
    // trusts exactly one Haven binding-signer address, performs no network I/O.
    const signer = createEdgeSigner(ctx.cfg.delegationDelegateKey, {
      x402BindingSigner: ctx.cfg.x402BindingSigner,
    })
    // No `audit` option — the harness must not write to the operator's
    // ~/.haven signing audit log. The signContext identity is what a connect
    // install stores in identity.json — here fed from the same QA credentials
    // the hosted client uses, so the #1263 payment_id fetch path (the
    // production-default transport since #1272) is the one under test.
    const signerTools = createToolHandlers(signer, {
      signContext: {
        loadIdentity: async () =>
          ctx.cfg.delegationAgentApiKey
            ? { apiUrl: ctx.cfg.apiUrl, apiKey: ctx.cfg.delegationAgentApiKey }
            : null,
      },
    })
    const delegateAddress = signer.delegateAddress

    const hosted = new HostedMcpClient(ctx.cfg.hostedMcpUrl, ctx.cfg.delegationAgentApiKey)
    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)

    const agentInfo = await api.getAgent()
    const treasury = agentInfo.data.safe_address
    if (!treasury) {
      return fail("could not read the agent's account address from GET /machine-payments/agent")
    }
    if (agentInfo.data.delegate_address && agentInfo.data.delegate_address.toLowerCase() !== delegateAddress.toLowerCase()) {
      // Caught here rather than as an unexplained on-chain revert later: the
      // signer holds a key that is not this agent's delegate, so nothing it
      // signs can ever redeem.
      return fail(
        `QA_DELEGATION_DELEGATE_PRIVATE_KEY derives ${delegateAddress} but the agent's ` +
          `delegate is ${agentInfo.data.delegate_address} — the credentials do not belong together`,
      )
    }
    const [treasuryBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(treasury),
      usdc.balanceOf(delegateAddress),
    ])) as [bigint, bigint]

    // ── 1. Hosted quote: the keyless server builds the funding intent ────────
    let quote: HostedPayMcpToolResult
    try {
      quote = await hosted.callTool<HostedPayMcpToolResult>('haven_pay_mcp_tool', {
        merchant_url: mcpUrl,
        tool_name: 'buy_vpn',
        arguments: { plan: FUNDING_LEG_PLAN },
        // #1351 made a spending cap MANDATORY on haven_pay_mcp_tool; this leg
        // predates that and went uncapped, so the hosted tool refused with
        // INVALID_INPUT before contacting the merchant — the leg never reached
        // the topology it exists to cover. Whole tokens (max_amount_human) is
        // the preferred spelling and matches x402-erc7710-hosted; the purchase
        // is 0.001 USDC, so 1 USDC is a real ceiling that never binds.
        max_amount_human: '1',
        // Fresh per attempt: a reused key would resume the previous run's
        // intent, and a resumed intent proves nothing about this run.
        idempotency_key: `qa-hosted-${Date.now()}`,
      })
    } catch (err) {
      if (err instanceof HostedMcpToolError) {
        return fail(`hosted haven_pay_mcp_tool refused: ${err.code} — ${err.message.slice(0, 180)}`)
      }
      throw err
    }

    // #1441: this leg's invariant is the FUNDING-LEG topology — "both on-chain
    // legs succeed, delegate left with zero residual". #1450 made the hosted
    // tool prefer erc7710 whenever the merchant advertises it, and erc7710 has
    // no funding leg at all, so against such a merchant the invariant is not
    // merely failing, it is unreachable: the quote comes back in the erc7710
    // shape (payment_id + settlement_scheme, no status/payload_hash) and the
    // checks below have nothing to read.
    //
    // Skip rather than fail, and NOT because failing is inconvenient — nothing
    // here goes uncovered:
    //   - hosted erc7710 → `x402-erc7710-hosted` (settles, asserts the delegate
    //     EOA is untouched),
    //   - hosted 3009 → `x402-catalog-guided-purchase`, which drives the SAME
    //     hosted MCP + local signer topology through
    //     `haven_prepare_catalog_purchase` and proves both on-chain legs plus a
    //     zero delegate residual.
    // What this leg alone still covers is the `haven_pay_mcp_tool` ENTRY POINT
    // on the funding path, which is why it stays rather than being deleted.
    //
    // Under QA_REQUIRE_ALL_LEGS=1 the runner turns this skip into a run
    // failure, which is the intended escalation for an operator who wants the
    // funding path exercised from this entry point (point it at a merchant that
    // does not advertise erc7710).
    // #1441: this leg buys `vpn_legacy`, the one product advertising eip3009
    // ALONE, so the funding-leg topology is now REACHABLE and an erc7710 quote
    // is a regression rather than an unreachable invariant. It used to skip
    // here — permanently, because every product offered erc7710 and #1450's
    // preference rule always picked it, which under QA_REQUIRE_ALL_LEGS=1 meant
    // the suite could never report green.
    //
    // Failing, not skipping, is the point: if scheme selection ever ignores a
    // merchant that offers no erc7710 option, that is a real defect on the
    // funding path and this leg is the one that catches it.
    const quoteScheme = (quote as { settlement_scheme?: string }).settlement_scheme
    if (quoteScheme === 'erc7710' || (!quote.payload_hash && quote.status === undefined)) {
      return fail(
        `hosted quote selected ${JSON.stringify(quoteScheme ?? 'a no-funding-leg scheme')} for ` +
          `plan '${FUNDING_LEG_PLAN}', which advertises eip3009 ONLY — scheme selection ignored the ` +
          "merchant's advertised methods, or the dev merchant no longer serves the 3009-only product",
      )
    }

    if (quote.status === 'pending_approval' || !quote.payload_hash) {
      return fail(
        `hosted quote returned status '${quote.status ?? 'unknown'}' with no payload_hash — the ` +
          'delegation-rail agent should auto-authorize a 0.001 USDC purchase within its budget',
      )
    }
    const expected = quote.x402?.expected
    if (!expected) {
      return fail('hosted quote carried no x402.expected signing context — the signer has nothing to verify')
    }

    // ── 2. The rail discriminator (#1138). A v1 context here means this leg ──
    //      never touched the seam it exists to cover.
    if (!expected.typed_data_hash) {
      return fail(
        `hosted quote returned a v1 expected context (no typed_data_hash, auth.version ` +
          `${expected.auth?.version}) — the delegation-rail typed-data path was NOT exercised. ` +
          'Is QA_DELEGATION_AGENT_API_KEY pointing at a legacy AllowanceModule agent?',
      )
    }
    if (quote.signature_scheme !== 'eip712_userop') {
      return fail(
        `hosted quote committed to typed data (typed_data_hash present) but returned ` +
          `signature_scheme=${JSON.stringify(quote.signature_scheme)} — the signer would ` +
          'refuse, correctly, because the scheme does not name the typed-data path',
      )
    }
    // #1272: the production default is COMPACT — the bulk payload must be
    // absent, because the signer fetches the exact bytes by payment_id
    // (#1263). Bulk reappearing here is a contract regression, not a bonus.
    if (quote.typed_data !== undefined || quote.typed_data_b64 !== undefined) {
      return fail(
        'hosted quote carried typed_data/typed_data_b64 without include_signing_payload — ' +
          'the #1272 compact default regressed and every quote is shipping multi-KB blobs again',
      )
    }

    // ── 3. Local signing. The key never leaves this process, and the tool ────
    //      handler puts the LIVE quote through the signer's Zod schema first.
    // The preferred #1263 form, and the ONLY form a compact quote supports:
    // payment_id + payment_required. The signer fetches payload_hash, the
    // typed data, and the expected context from Haven itself and runs the
    // same binding verification + digest re-derivation on the fetched bytes.
    const signed = await signerTools.haven_sign_x402({
      payment_id: quote.payment_id,
      payment_required: quote.payment_required,
    })
    if (!signed.success) {
      return fail(
        `local edge signer REFUSED the hosted quote: ${signed.code} — ${signed.message.slice(0, 220)}`,
      )
    }
    const signature = (signed.data as SignX402Data).signature
    const paymentHeader = (signed.data as SignX402Data).payment_header

    // ── 4. Hosted settle: relay the funding signature and deliver the header ─
    let settle: HostedSettleMcpToolResult
    try {
      settle = await hosted.callTool<HostedSettleMcpToolResult>('haven_settle_mcp_tool', {
        payment_id: quote.payment_id,
        signature,
        merchant_url: mcpUrl,
        tool_name: 'buy_vpn',
        arguments: { plan: FUNDING_LEG_PLAN },
        payment_header: paymentHeader,
        ...(quote.mcp_transport ? { mcp_transport: quote.mcp_transport } : {}),
      })
    } catch (err) {
      if (err instanceof HostedMcpToolError) {
        return fail(`hosted haven_settle_mcp_tool refused: ${err.code} — ${err.message.slice(0, 180)}`)
      }
      throw err
    }

    if (!settle.settled) {
      return fail(
        `hosted settle did not settle: funding_status=${settle.funding_status ?? 'unknown'}, ` +
          `funding_tx=${settle.funding_tx_hash ?? 'none'} — the merchant leg never ran`,
      )
    }

    // ── 5. Both on-chain legs ────────────────────────────────────────────────
    const fundingHash = settle.funding_tx_hash
    const merchantHash = settle.settlement_tx_hash
    if (!fundingHash) return fail('settle reported settled:true with no funding_tx_hash — the funding leg is unevidenced')
    if (!merchantHash) {
      return fail(
        'settle reported settled:true with no settlement_tx_hash — the merchant leg cannot be ' +
          'verified on-chain, so "the merchant said yes" is the only evidence there is',
      )
    }
    if (fundingHash.toLowerCase() === merchantHash.toLowerCase()) {
      return fail(
        `funding and settlement report the SAME tx ${fundingHash} — the two-leg bridge collapsed ` +
          'to one hop, or one hash was echoed for both',
      )
    }

    const fundingReceipt = await waitForReceipt(provider, fundingHash)
    if (!fundingReceipt) return fail(`funding tx ${fundingHash} has no receipt on Base Sepolia`)
    if (fundingReceipt.status !== 1) return fail(`funding tx ${fundingHash} REVERTED on-chain`)

    const merchantReceipt = await waitForReceipt(provider, merchantHash)
    if (!merchantReceipt) {
      return fail(
        `merchant settlement tx ${merchantHash} has no receipt within ` +
          `${TIMING.receiptWaitMs / 1000}s — the facilitator reported a hash that did not land`,
      )
    }
    if (merchantReceipt.status !== 1) return fail(`merchant settlement tx ${merchantHash} REVERTED on-chain`)

    // ── 6. The budget was metered, and nothing was stranded ──────────────────
    //
    // Polled, not sampled once. Base Sepolia's public RPC is load-balanced, so
    // a `balanceOf` can be answered by a node a block or two behind the one
    // that just served the settlement receipt — which showed up in the first
    // live run of this leg as a phantom 0.001 USDC residual that was already
    // zero on chain by the time it was checked by hand. Waiting for the two
    // conditions to hold together converts that race into latency.
    let treasuryAfter = treasuryBefore
    let delegateAfter = delegateBefore
    const deadline = Date.now() + TIMING.balanceWaitMs
    for (;;) {
      ;[treasuryAfter, delegateAfter] = (await Promise.all([
        usdc.balanceOf(treasury),
        usdc.balanceOf(delegateAddress),
      ])) as [bigint, bigint]
      if ((treasuryAfter < treasuryBefore && delegateAfter === delegateBefore) || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, TIMING.pollIntervalMs))
    }

    if (treasuryAfter >= treasuryBefore) {
      return fail(
        `treasury ${treasury} did not decrease (${fmt(treasuryBefore)} → ${fmt(treasuryAfter)} USDC) — ` +
          'the funding leg confirmed but the budget delegation was not metered',
      )
    }

    // Zero residual, measured as a DELTA against this leg's own baseline.
    //
    // Deliberately stricter than `x402-delegation-3009`'s dust floor: that leg
    // tolerates sub-floor dust because its merchant may verify without settling.
    // Here the merchant SETTLES, so exact-amount funding must net to exactly
    // zero and any change is stranding. A delta is used rather than an absolute
    // zero because an earlier leg in the same run may legitimately have left
    // sub-floor dust on this shared delegate — asserting an absolute zero would
    // make this leg red for another leg's by-design behaviour.
    if (delegateAfter !== delegateBefore) {
      return fail(
        `delegate EOA ${delegateAddress} moved ${fmt(delegateBefore)} → ${fmt(delegateAfter)} USDC ` +
          `across a SETTLED payment — exact-amount funding must net to zero, and it had not ` +
          `converged after ${TIMING.balanceWaitMs / 1000}s; this leg stranded ` +
          `${fmt(delegateAfter - delegateBefore)} USDC`,
      )
    }

    const carried =
      delegateAfter > 0n ? ` (${fmt(delegateAfter)} USDC pre-existing dust unchanged)` : ''
    return pass(
      `hosted MCP + local edge signer settled a delegation-rail x402 payment ` +
        `(v${expected.auth.version} context, typed data signed locally by ${delegateAddress}): ` +
        `funding ${fundingHash} (block ${fundingReceipt.blockNumber}), merchant ${merchantHash} ` +
        `(block ${merchantReceipt.blockNumber}); treasury ${fmt(treasuryBefore)} → ${fmt(treasuryAfter)}, ` +
        `zero delegate residual${carried}; intent ${quote.payment_id}`,
    )
  },
}
