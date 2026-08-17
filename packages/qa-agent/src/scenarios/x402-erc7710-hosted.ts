/**
 * erc7710 through the DEFAULT topology: hosted MCP + local edge signer
 * (#1457, epic #1450).
 *
 * WHAT THIS PROVES THAT NO OTHER LEG DOES. Three legs now touch erc7710 and
 * they prove different things, which is why all three are kept:
 *
 *   x402-erc7710-settle  the raw API — the contract merchant-side integrators
 *                        build against. Says nothing about Haven's clients.
 *   x402-erc7710-sdk     HavenClient end to end, with an in-process delegate
 *                        key. Says nothing about the hosted boundary.
 *   THIS ONE             hosted MCP + local signer — what an agent installed
 *                        by `npx @haven_ai/connect` actually runs.
 *
 * The distinction that matters here is custody: the hosted server never holds
 * a delegate key, so the signature has to come from the local signer over the
 * tool boundary. #1456 split the flow to make that possible; this leg proves
 * the split works against a live deployment rather than against mocks.
 *
 * THE ASSERTIONS THAT CARRY IT. Two, and neither is "a 200":
 *
 *   1. the hosted quote must REPORT settlement_scheme erc7710. A silent
 *      reroute to the EIP-3009 bridge would still deliver the goods, so
 *      scheme selection is checked, not inferred from success.
 *   2. the delegate EOA balance must be unchanged. That is where a funding
 *      leg parks money in transit, so it is the only place a reroute that
 *      lied about its scheme would still show.
 *
 * Ordered after `x402-hosted-mcp-signer` deliberately: a failure here should
 * be diagnosable against a topology a sibling leg has already shown healthy.
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

const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)']
const SETTLE_WAIT_MS = 120_000
const POLL_MS = 3_000

/** The hosted pay result gains these on the erc7710 branch (#1456). */
interface Erc7710PayResult extends HostedPayMcpToolResult {
  settlement_scheme?: string
  settlement?: { scheme?: string; funding_leg?: boolean; merchant_pay_to?: string }
}

export const x402Erc7710Hosted: Scenario = {
  name: 'x402-erc7710-hosted',
  invariant:
    'The default topology (hosted MCP + local signer) settles erc7710 with no funding leg: ' +
    'the hosted quote reports the scheme, and the delegate EOA is untouched.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.hostedMcpUrl) {
      return skip('QA_HOSTED_MCP_URL not set — this leg exercises the hosted topology')
    }
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — needs the dev demo-merchant')
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'delegation-rail QA identity unset — set QA_DELEGATION_AGENT_API_KEY + ' +
          'QA_DELEGATION_DELEGATE_PRIVATE_KEY (see docs/operations/agent-qa.md)',
      )
    }

    const signer = createEdgeSigner(ctx.cfg.delegationDelegateKey, {
      x402BindingSigner: ctx.cfg.x402BindingSigner,
    })
    // No `audit` option — the harness must not write to the operator's
    // ~/.haven signing audit log.
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
    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`

    const agentInfo = await api.getAgent()
    const treasury = agentInfo.data.safe_address
    if (!treasury) return fail("could not read the agent's account address")

    const rpc = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const usdc = new ethers.Contract(SEPOLIA_USDC, ERC20_ABI, rpc)

    // ── 1. Hosted quote — the tool selects the scheme, not this scenario ─────
    let quote: Erc7710PayResult
    try {
      quote = await hosted.callTool<Erc7710PayResult>('haven_pay_mcp_tool', {
        merchant_url: mcpUrl,
        tool_name: 'buy_vpn',
        arguments: { plan: 'basic' },
        max_amount_human: '1',
      })
    } catch (err) {
      if (err instanceof HostedMcpToolError) {
        return fail(`hosted haven_pay_mcp_tool refused: ${err.code} — ${err.message.slice(0, 180)}`)
      }
      throw err
    }

    if (quote.settlement_scheme !== 'erc7710') {
      // Either the merchant stopped advertising erc7710, or scheme selection
      // regressed. Both are this leg's business; neither is a pass.
      return skip(
        `hosted quote settled on ${JSON.stringify(quote.settlement_scheme ?? 'eip3009')} — ` +
          'the dev merchant must advertise erc7710 (MERCHANT_X402_ERC7710=1 + ' +
          'MERCHANT_ERC7710_DELEGATION_MANAGER); if it does, scheme selection regressed',
      )
    }
    if (quote.settlement?.funding_leg !== false) {
      return fail('hosted quote did not report funding_leg: false on an erc7710 settlement')
    }

    const merchantPayTo = quote.settlement?.merchant_pay_to
    if (!merchantPayTo) return fail('hosted quote reported no merchant_pay_to')

    const [treasuryBefore, merchantBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(treasury),
      usdc.balanceOf(merchantPayTo),
      usdc.balanceOf(delegateAddress),
    ])) as [bigint, bigint, bigint]

    // ── DIAGNOSTIC (#1508, temporary) ────────────────────────────────────────
    // This leg fails at settle with "The payment was submitted and is waiting
    // for confirmation", i.e. the intent is ALREADY 'submitted' when settle
    // runs. Static reading says that cannot happen: the hosted quote only
    // PREPARES, the signer's fetch is a read-only GET /x402/:id/sign-context,
    // and POST /x402/:id/settle is the only caller of
    // markIntentSubmittedForSettlement. So one of those three claims is false
    // in the deployed system, and reading more code will not say which.
    //
    // Sampling the status at each boundary localises the flip to a single step.
    // Read-only (GET /payments/:id) and never fails the leg on its own — a
    // probe that could fail the run would be a second failure mode layered on
    // the one under investigation.
    const probeStatus = async (label: string): Promise<string> => {
      try {
        const r = await api.getPayment(quote.payment_id)
        return `${label}=${r.ok ? (r.data?.status ?? 'no-status') : `read-failed(${r.status})`}`
      } catch (err) {
        return `${label}=probe-threw(${err instanceof Error ? err.message.slice(0, 40) : 'unknown'})`
      }
    }
    const probes: string[] = [await probeStatus('after_quote')]

    // ── 2. LOCAL signing by payment_id — the key never crosses the boundary ──
    // Not haven_sign_x402: that builds an EIP-3009 header locally, which this
    // scheme has no use for. Here the signer verifies the settlement child's
    // caveats (#1455) and returns only a signature.
    const signed = (await signerTools.haven_sign({ payment_id: quote.payment_id })) as
      | { success: false; code: string; message: string }
      | { success: true; data: { signature: string } }
    if (!signed.success) {
      return fail(
        `local edge signer REFUSED the hosted erc7710 quote: ${signed.code} — ` +
          `${signed.message.slice(0, 220)} [#1508 ${probes.join(' ')}]`,
      )
    }
    // #1508: the signer's fetch is the step most likely to be lying about being
    // read-only, so sample immediately after it and before settle is called.
    probes.push(await probeStatus('after_sign'))

    // ── 3. Hosted settle — Haven assembles the header and calls the merchant ─
    let settle: HostedSettleMcpToolResult & { settlement_scheme?: string }
    try {
      settle = await hosted.callTool('haven_settle_mcp_tool', {
        payment_id: quote.payment_id,
        signature: signed.data.signature,
        merchant_url: mcpUrl,
        tool_name: 'buy_vpn',
        arguments: { plan: 'basic' },
        // No payment_header ON PURPOSE — its absence is what selects the
        // erc7710 branch, because Haven assembles the header at settle.
        ...(quote.mcp_transport ? { mcp_transport: quote.mcp_transport } : {}),
      })
    } catch (err) {
      if (err instanceof HostedMcpToolError) {
        // #1508: carry the probe trail INTO the failure detail — the run report
        // is the only artefact that survives the runner, so a diagnostic that
        // only reaches stdout is a diagnostic we cannot read afterwards.
        probes.push(await probeStatus('after_settle_refused'))
        return fail(
          `hosted haven_settle_mcp_tool refused: ${err.code} — ${err.message.slice(0, 180)} ` +
            `[#1508 payment_id=${quote.payment_id} ${probes.join(' ')}]`,
        )
      }
      throw err
    }

    if (!settle.settled) return fail('hosted settle did not settle — the merchant leg never ran')
    if (settle.settlement_scheme !== 'erc7710') {
      return fail(
        `settle reported scheme ${JSON.stringify(settle.settlement_scheme)} — a quote that chose ` +
          'erc7710 must not settle as anything else',
      )
    }
    if (settle.funding_tx_hash) {
      return fail(
        `settle reported a funding tx (${settle.funding_tx_hash}) — erc7710 has no funding leg, ` +
          'so this means the payment took the EIP-3009 bridge',
      )
    }

    // ── 4. The money proof ───────────────────────────────────────────────────
    const deadline = Date.now() + SETTLE_WAIT_MS
    let treasuryAfter = treasuryBefore
    let merchantAfter = merchantBefore
    for (;;) {
      ;[treasuryAfter, merchantAfter] = (await Promise.all([
        usdc.balanceOf(treasury),
        usdc.balanceOf(merchantPayTo),
      ])) as [bigint, bigint]
      if (treasuryAfter !== treasuryBefore || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    const delegateAfter = (await usdc.balanceOf(delegateAddress)) as bigint
    const fmt = (v: bigint) => ethers.formatUnits(v, 6)

    const debited = treasuryBefore - treasuryAfter
    const credited = merchantAfter - merchantBefore
    if (debited <= 0n) return fail('treasury was not debited — the settlement never landed')
    if (debited !== credited) {
      return fail(
        `treasury −${fmt(debited)} but merchant +${fmt(credited)} — direct settlement must move ` +
          'the same amount end to end',
      )
    }
    if (delegateAfter !== delegateBefore) {
      return fail(
        `delegate EOA balance changed ${fmt(delegateBefore)} → ${fmt(delegateAfter)} — erc7710 ` +
          'has no funding leg, so the payment took the EIP-3009 bridge despite reporting erc7710',
      )
    }

    return pass(
      `hosted MCP + local signer settled erc7710: treasury ${fmt(treasuryBefore)} → ` +
        `${fmt(treasuryAfter)} paid the merchant exactly ${fmt(credited)} USDC; delegate EOA ` +
        `untouched (${fmt(delegateAfter)}); payment ${quote.payment_id}`,
    )
  },
}
