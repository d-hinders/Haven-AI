/**
 * #1312: the GUIDED catalog purchase path — the whole point of epic #1305 —
 * completes end to end against the REAL deployed dev environment: catalog
 * discovery → `haven_prepare_catalog_purchase(catalog_id, max_amount)` →
 * local signer signs via `payment_id` ONLY → settle by `payment_id` with NO
 * merchant context re-sent → structured summary + post-purchase allowance
 * block.
 *
 * ## Why this leg had to exist
 *
 * #1306–#1310 landed the guided-path primitives (catalog preflight,
 * settle-by-payment_id rehydration, structured next_action/warnings,
 * machine-readable signer compatibility, post-purchase allowance summary) as
 * five separate PRs, each proven at the unit level against MOCKED
 * collaborators. Nothing had driven them TOGETHER, in the order a coding
 * agent actually calls them, against a live hosted MCP plus a local edge
 * signer. #1305's premise is reducing agent state-threading: a coding agent
 * starts from a `catalog_id` and never manually copies `payment_required` /
 * `merchant_url` / `tool_name` / `arguments` / `mcp_transport` between tool
 * calls. A leg that still threaded those fields by hand would report green
 * while the epic's actual goal silently failed to ship — the same #1272
 * discipline `x402-hosted-mcp-signer` was filed to enforce for the older
 * `haven_pay_mcp_tool` entry point.
 *
 * This leg IS that scenario's (#1154) topology and money-proof discipline,
 * retargeted at the NEW entry point — `haven_prepare_catalog_purchase`
 * instead of `haven_pay_mcp_tool` — with a settle call that omits EVERY
 * field #1307 promised to rehydrate, not just the ones #1154 happened to
 * omit.
 *
 * ## What it drives
 *
 * The REAL deployed hosted MCP over HTTP (`QA_HOSTED_MCP_URL`) and the REAL
 * `@haven_ai/signer` in-process via `createEdgeSigner` — same rationale as
 * `x402-hosted-mcp-signer`: in-process exercises the keyless branch, the wire
 * shapes, the binding, and the signing either way, and stdio adds process
 * plumbing without adding coverage of the thing under test. Signing goes
 * through the signer's TOOL HANDLER, so the live catalog-preflight quote
 * passes through the same Zod schema boundary a real agent runtime would
 * hit.
 *
 * The catalog entry is RESOLVED, never hardcoded: this leg calls the agent's
 * own chain-scoped `GET /catalog` and matches by `resource_url` / `tool_name`
 * / `tool_arguments` — the same triple `haven_prepare_catalog_purchase`
 * itself keys a live quote on, and the same triple #1299's unique index is
 * built from. A hardcoded catalog UUID would silently start pointing at a
 * DIFFERENT row (or nothing at all) the next time the seed migration is
 * re-run, and the leg would never notice it had drifted off the product it
 * claims to buy.
 *
 * Product choice: NordShield VPN Basic (`buy_vpn` / `{ plan: 'basic' }`) — a
 * SETTLING product, already proven end-to-end by `x402-hosted-mcp-signer`.
 * Never CloudNest 50 GB (`buy_cloud_storage` / `{ tier: '50gb' }`): that is
 * the demo merchant's `MERCHANT_SKIP_SETTLE_PRODUCT` fixture on dev
 * (verify-without-settle, by design, for `x402-delegation-3009-sweep`) —
 * funds would strand on the delegate by construction, and this leg's
 * zero-residual settle assertions would be asserting a lie.
 *
 * ## The discriminators that stop this passing vacuously
 *
 *   - **The catalog entry is resolved via the API, not hardcoded.** Asserts
 *     `catalog_id` on the preflight response equals the id `GET /catalog`
 *     returned for the matching row. No matching row on dev ⇒ SKIP naming
 *     the #1299 seed migration — an unmet precondition, not a code defect.
 *   - **The preflight is COMPACT.** Same #1272 contract as
 *     `x402-hosted-mcp-signer`: no `typed_data` / `typed_data_b64` by
 *     default. A v1 (legacy-rail) expected context is also a FAILURE, for
 *     the same #1138 reason that scenario asserts it.
 *   - **The #1308 guidance is machine-readable and correct.** `next_action`
 *     names signing, `next_tool` is the signer's own tool name, and
 *     `next_arguments.payment_id` is exactly this response's `payment_id` —
 *     the thing an agent would forward without reading any prose.
 *   - **The allowance block is rail-labeled** (#1306) and the catalog price
 *     is explicitly marked indicative alongside the LIVE authoritative
 *     amount — a preflight that silently dropped either field would put a
 *     coding agent back to guessing which number is real.
 *   - **The signer call carries ONLY `payment_id` + `payment_required`.**
 *     This is the epic's thesis (#1305): if the scenario had to re-thread
 *     `merchant_url` / `tool_name` / `arguments` / `mcp_transport` to make
 *     signing work, the guided path FAILED — regardless of whether a payment
 *     eventually went through.
 *   - **The settle call carries ONLY `payment_id` + `signature` +
 *     `payment_header`.** Stricter than `x402-hosted-mcp-signer`, which
 *     still passes `merchant_url` / `tool_name` / `arguments` explicitly
 *     (it predates #1307 and exists to prove the OLDER explicit-context path
 *     still works as a skew fallback). This leg proves the opposite: that
 *     #1307's rehydration-by-payment_id actually serves those fields, which
 *     is the only way settlement can succeed with none of the four present.
 *   - **The post-purchase allowance block (#1310) is present on settle**,
 *     not just documented as a field that theoretically exists. A response
 *     missing the `allowance` key entirely, or reporting `settled: false`,
 *     fails. `allowance: null` WITH the ALLOWANCE_CHECK_UNAVAILABLE warning
 *     is the #1310/#1320 degrade contract for a transient post-settlement
 *     read failure — pass-with-note, never a promotion-blocking red after
 *     money provably moved (#1323 review); null WITHOUT the warning is the
 *     degrade contract itself regressing, and still fails.
 *   - **Both on-chain legs, zero residual.** Same money proof as
 *     `x402-hosted-mcp-signer`: distinct funding/settlement tx hashes, both
 *     `status === 1`, delegate residual UNCHANGED (a delta, so an earlier
 *     leg's dust cannot make this one red for someone else's reason), and
 *     the settled amount within `max_amount`.
 *
 * ## Fail vs. skip
 *
 * Unmet precondition — missing `QA_*` config, no matching catalog row on dev
 * (the #1299 seed migration not yet applied), or the hosted MCP not yet
 * carrying `haven_prepare_catalog_purchase` (a fresh dev deploy that has not
 * picked up #1306 yet) — SKIPS with a message naming the fix; a tool-not-
 * found response from the hosted server is read as exactly that deploy-skew
 * case, not a contract violation. Everything the guided contract promises
 * once those preconditions hold is asserted as a FAILURE, never quietly
 * downgraded to a skip.
 *
 * ## What it does NOT cover
 *
 * Per-failure-mode unit coverage (network mismatch, cap exceeded, delegation
 * over-budget refusal, legacy pending-approval, unsupported signer
 * capability, funded-merchant-timeout routing) is already proven at the
 * mcp-server/SDK unit level by #1306–#1310's own test suites against mocked
 * collaborators — see `packages/mcp-server/src/tools.test.ts`. This leg's
 * job is the thing those suites cannot prove: that the guided AGENT PATH —
 * catalog discovery through structured summary — actually works end to end,
 * live, without hand-threading.
 */

import { ethers } from 'ethers'
import { createEdgeSigner, createToolHandlers } from '@haven_ai/signer'
import { HavenApi, type CatalogEntry } from '../lib/haven-api.js'
import {
  HostedMcpClient,
  HostedMcpToolError,
  HostedMcpTransportError,
  type HostedPrepareCatalogPurchaseResult,
  type HostedSettleMcpToolResult,
} from '../lib/hosted-mcp.js'
import { type Scenario, type ScenarioContext, pass, fail, skip } from './types.js'

const BASE_SEPOLIA_RPC = 'https://sepolia.base.org'
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'] as const

/**
 * A SETTLING catalog product — see the module doc-comment for why
 * `storage_50gb` / `buy_cloud_storage {tier:"50gb"}` must never be used here.
 */
const PRODUCT_TOOL = 'buy_vpn'
const PRODUCT_ARGS = { plan: 'basic' } as const

/**
 * The user-intent cap passed to `haven_prepare_catalog_purchase`. NordShield
 * VPN Basic quotes at 1000 atomic USDC (#1299 seed) — comfortably below this,
 * so the happy path is proven without walking the cap's own edge (that is
 * `haven_prepare_catalog_purchase`'s own unit-tested job in
 * `packages/mcp-server/src/tools.test.ts`, not this leg's).
 */
const MAX_AMOUNT = '2000'

/** How long to wait for on-chain receipts / balance convergence. Test seam, matching the sibling legs. */
export const TIMING = { receiptWaitMs: 60_000, balanceWaitMs: 90_000, pollIntervalMs: 3_000 }

/** The signer tool's success payload (`@haven_ai/signer` `haven_sign_x402`). */
interface SignX402Data {
  signature: string
  x402_binding: string
  payment_header: string
  accepted: Record<string, unknown>
}

/** Wait for a transaction receipt, tolerating an RPC that has not yet indexed a just-mined tx. */
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
 * The shape an MCP server returns for a `tools/call` naming a tool it has not
 * registered (`@modelcontextprotocol/sdk`'s `McpServer`: `Tool ${name} not
 * found`, `ErrorCode.InvalidParams`, surfaced here as a JSON-RPC `error`).
 * This is the deploy-skew signal — the hosted MCP has not picked up #1306 yet
 * — not a contract violation.
 */
function isToolNotFound(err: HostedMcpTransportError, tool: string): boolean {
  // Text match against the pinned MCP SDK's wording, PLUS the JSON-RPC error
  // code (-32602 InvalidParams — what McpServer throws for an unknown tool)
  // when the transport surfaced one: the code is stabler than prose, and a
  // reworded SDK message must degrade to skip, not a promotion-blocking FAIL
  // (#1323 review).
  if (new RegExp(`Tool ${tool} not found`, 'i').test(err.message)) return true
  const code = (err as { code?: number }).code
  return code === -32602 && /tool/i.test(err.message)
}

/** Resolve the catalog entry by the SAME triple `haven_prepare_catalog_purchase` quotes from. */
function findCatalogEntry(
  entries: CatalogEntry[],
  resourceUrl: string,
  toolName: string,
  toolArguments: Record<string, unknown>,
): CatalogEntry | undefined {
  return entries.find(
    (entry) =>
      entry.resource_url === resourceUrl &&
      entry.tool_name === toolName &&
      JSON.stringify(entry.tool_arguments ?? {}) === JSON.stringify(toolArguments),
  )
}

export const x402CatalogGuidedPurchase: Scenario = {
  name: 'x402-catalog-guided-purchase',
  invariant:
    'The guided catalog purchase path (#1305) completes end to end: catalog discovery → ' +
    'haven_prepare_catalog_purchase → local signer signs via payment_id only → settle by ' +
    'payment_id with no merchant context re-sent → structured summary + post-purchase allowance.',
  async run(ctx: ScenarioContext) {
    if (!ctx.cfg.demoMerchantUrl) {
      return skip('QA_DEMO_MERCHANT_URL not set — the guided catalog leg needs the dev demo-merchant')
    }
    if (!ctx.cfg.hostedMcpUrl) {
      return skip(
        'QA_HOSTED_MCP_URL not set — the guided catalog leg drives the DEPLOYED hosted MCP over ' +
          'HTTP (e.g. https://haven-ai-hosted-mcp-dev-25c7.up.railway.app/v1); see docs/operations/agent-qa.md',
      )
    }
    if (!ctx.cfg.x402BindingSigner) {
      return skip(
        'QA_X402_BINDING_SIGNER not set — the edge signer refuses to verify a Haven expected ' +
          'context without the trusted binding-signer address',
      )
    }
    if (!ctx.cfg.delegationAgentApiKey || !ctx.cfg.delegationDelegateKey) {
      return skip(
        'QA_DELEGATION_AGENT_API_KEY / QA_DELEGATION_DELEGATE_PRIVATE_KEY not set — the guided ' +
          'catalog leg needs a delegation-rail agent with an OPEN (unpinned) budget',
      )
    }

    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)
    const usdc = new ethers.Contract(SEPOLIA_USDC, USDC_ABI, provider)
    const fmt = (value: bigint) => ethers.formatUnits(value, 6)
    const mcpUrl = `${ctx.cfg.demoMerchantUrl}/mcp`

    const api = new HavenApi(ctx.cfg, ctx.cfg.delegationAgentApiKey)

    // ── 0. Resolve the catalog entry via the agent's own chain-scoped ────────
    //      GET /catalog — never a hardcoded id (discriminator #1).
    const catalogRes = await api.getCatalog()
    if (!catalogRes.ok) {
      return fail(`GET /catalog returned HTTP ${catalogRes.status} — could not resolve the catalog entry`)
    }
    const entry = findCatalogEntry(catalogRes.data.entries ?? [], mcpUrl, PRODUCT_TOOL, PRODUCT_ARGS)
    if (!entry) {
      return skip(
        `No catalog entry for ${PRODUCT_TOOL} ${JSON.stringify(PRODUCT_ARGS)} at ${mcpUrl} is visible to this ` +
          "agent — the #1299 demo-merchant catalog seed migration (058_demo_merchant_catalog) may not be " +
          'applied on dev yet, or this agent is scoped to a different chain.',
      )
    }

    // The signer that a connect-flow user runs locally: holds the delegate
    // key, trusts exactly one Haven binding-signer address, performs no
    // network I/O beyond the authenticated payment_id fetch.
    const signer = createEdgeSigner(ctx.cfg.delegationDelegateKey, {
      x402BindingSigner: ctx.cfg.x402BindingSigner,
    })
    // No `audit` option — must not write to the operator's ~/.haven signing
    // audit log. signContext identity mirrors a real connect install's
    // identity.json, fed from the same QA credentials the hosted client uses.
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

    const agentInfo = await api.getAgent()
    const treasury = agentInfo.data.safe_address
    if (!treasury) {
      return fail("could not read the agent's account address from GET /machine-payments/agent")
    }
    if (
      agentInfo.data.delegate_address &&
      agentInfo.data.delegate_address.toLowerCase() !== delegateAddress.toLowerCase()
    ) {
      return fail(
        `QA_DELEGATION_DELEGATE_PRIVATE_KEY derives ${delegateAddress} but the agent's delegate is ` +
          `${agentInfo.data.delegate_address} — the credentials do not belong together`,
      )
    }
    const [treasuryBefore, delegateBefore] = (await Promise.all([
      usdc.balanceOf(treasury),
      usdc.balanceOf(delegateAddress),
    ])) as [bigint, bigint]

    // ── 1. Guided preflight: catalog_id + max_amount, nothing else ───────────
    let prep: HostedPrepareCatalogPurchaseResult
    try {
      prep = await hosted.callTool<HostedPrepareCatalogPurchaseResult>('haven_prepare_catalog_purchase', {
        catalog_id: entry.id,
        max_amount: MAX_AMOUNT,
        // Fresh per attempt: a reused key would resume the previous run's
        // intent, and a resumed intent proves nothing about this run.
        idempotency_key: `qa-catalog-${Date.now()}`,
      })
    } catch (err) {
      if (err instanceof HostedMcpTransportError && isToolNotFound(err, 'haven_prepare_catalog_purchase')) {
        return skip(
          'the hosted MCP does not expose haven_prepare_catalog_purchase yet — the #1306 guided preflight ' +
            'has not deployed to this environment. Unmet precondition, not a regression: this leg starts ' +
            'exercising it on the next dev deploy.',
        )
      }
      if (err instanceof HostedMcpToolError) {
        return fail(`hosted haven_prepare_catalog_purchase refused: ${err.code} — ${err.message.slice(0, 220)}`)
      }
      throw err
    }

    if (prep.status === 'pending_approval' || !prep.payload_hash) {
      return fail(
        `guided preflight returned status '${prep.status ?? 'unknown'}' with no payload_hash — the ` +
          'delegation-rail agent should auto-authorize this purchase within its budget (no approval queue exists on that rail)',
      )
    }

    // ── 2. Resolved catalog entry, not a hardcoded id ─────────────────────────
    if (prep.catalog_id !== entry.id) {
      return fail(
        `preflight echoed catalog_id ${JSON.stringify(prep.catalog_id)}, not the resolved entry ${entry.id} — ` +
          'the guided response is not describing the catalog row this leg looked up',
      )
    }

    // ── 3. The rail discriminator (#1138), same as x402-hosted-mcp-signer ────
    const expected = prep.x402?.expected
    if (!expected) {
      return fail('guided preflight carried no x402.expected signing context — the signer has nothing to verify')
    }
    if (!expected.typed_data_hash) {
      return fail(
        `guided preflight returned a v1 expected context (no typed_data_hash, auth.version ` +
          `${expected.auth?.version}) — the delegation-rail typed-data path was NOT exercised. Is ` +
          'QA_DELEGATION_AGENT_API_KEY pointing at a legacy AllowanceModule agent?',
      )
    }
    if (prep.signature_scheme !== 'eip712_userop') {
      return fail(
        `guided preflight committed to typed data (typed_data_hash present) but returned ` +
          `signature_scheme=${JSON.stringify(prep.signature_scheme)} — the signer would refuse, correctly, ` +
          'because the scheme does not name the typed-data path',
      )
    }
    // #1272: the production default is COMPACT — mutation target for this leg.
    if (prep.typed_data !== undefined || prep.typed_data_b64 !== undefined) {
      return fail(
        'guided preflight carried typed_data/typed_data_b64 without include_signing_payload — the #1272 ' +
          'compact default regressed and every catalog quote is shipping multi-KB blobs again',
      )
    }

    // ── 4. The #1308 guidance is machine-readable, not prose the agent must ──
    //      parse to find its next step.
    if (prep.next_action !== 'sign_and_submit_payment') {
      return fail(
        `guided preflight next_action was ${JSON.stringify(prep.next_action)}, expected sign_and_submit_payment`,
      )
    }
    if (prep.next_tool !== 'mcp__haven-signer__haven_sign_x402') {
      return fail(
        `guided preflight next_tool was ${JSON.stringify(prep.next_tool)}, expected the signer's own haven_sign_x402 tool`,
      )
    }
    if (prep.next_arguments?.payment_id !== prep.payment_id) {
      return fail(
        `guided preflight next_arguments.payment_id (${JSON.stringify(prep.next_arguments?.payment_id)}) does ` +
          `not match this response's own payment_id (${prep.payment_id})`,
      )
    }

    // ── 5. Rail-labeled allowance block + indicative catalog price (#1306) ───
    if (!prep.allowance || typeof prep.allowance.rail !== 'string') {
      return fail('guided preflight carried no rail-labeled allowance block')
    }
    if (prep.catalog_price_is_indicative !== true) {
      return fail(
        'guided preflight did not mark catalog_price_atomic as indicative — an agent could mistake it for the live price',
      )
    }
    if (prep.catalog_price_atomic === undefined || prep.amount_atomic === undefined) {
      return fail('guided preflight is missing catalog_price_atomic or the live amount_atomic to compare it against')
    }
    if (BigInt(prep.amount_atomic) > BigInt(MAX_AMOUNT)) {
      return fail(
        `live quoted amount ${prep.amount_atomic} exceeds max_amount ${MAX_AMOUNT} — the cap should have refused this at preflight`,
      )
    }

    // ── 6. Local signing — payment_id + payment_required ONLY (#1305's thesis) ─
    const signed = await signerTools.haven_sign_x402({
      payment_id: prep.payment_id,
      payment_required: prep.payment_required,
    })
    if (!signed.success) {
      return fail(
        `local edge signer REFUSED the guided quote: ${signed.code} — ${signed.message.slice(0, 220)}`,
      )
    }
    const signature = (signed.data as SignX402Data).signature
    const paymentHeader = (signed.data as SignX402Data).payment_header

    // ── 7. Settle by payment_id ONLY — #1307 rehydration must serve the rest ──
    //      No merchant_url/tool_name/arguments/mcp_transport: if settlement
    //      needs them re-threaded, the guided path failed.
    let settle: HostedSettleMcpToolResult
    try {
      settle = await hosted.callTool<HostedSettleMcpToolResult>('haven_settle_mcp_tool', {
        payment_id: prep.payment_id,
        signature,
        payment_header: paymentHeader,
      })
    } catch (err) {
      if (err instanceof HostedMcpToolError) {
        return fail(`hosted haven_settle_mcp_tool refused: ${err.code} — ${err.message.slice(0, 220)}`)
      }
      throw err
    }

    if (!settle.settled) {
      return fail(
        `hosted settle did not settle: funding_status=${settle.funding_status ?? 'unknown'}, funding_tx=` +
          `${settle.funding_tx_hash ?? 'none'} — #1307 rehydration may not have found the stored MCP call context`,
      )
    }

    // ── 8. The post-purchase allowance block (#1310) ─────────────────────────
    if (!('allowance' in settle) || settle.allowance === undefined) {
      return fail('settled response carried no allowance key at all — the #1310 post-purchase summary regressed')
    }
    if (settle.allowance === null) {
      // #1323 review: null-with-warning is the #1310/#1320 CONTRACT for a
      // transient post-settlement read failure — the money already moved
      // correctly, and a promotion-gating leg must not red on an RPC blip
      // AFTER a proven settlement. A null with NO warning, though, is the
      // handler violating its own degrade contract — that one still fails.
      const hasDegradeWarning = (settle.warnings ?? []).some(
        (w) => w.code === 'ALLOWANCE_CHECK_UNAVAILABLE',
      )
      if (!hasDegradeWarning) {
        return fail(
          'settled response reported allowance: null WITHOUT the ALLOWANCE_CHECK_UNAVAILABLE ' +
            `warning — the #1310 degrade contract regressed; warnings: ${JSON.stringify(settle.warnings ?? [])}`,
        )
      }
    }
    const allowanceNote =
      settle.allowance === null
        ? 'allowance read degraded (null + ALLOWANCE_CHECK_UNAVAILABLE, legitimate per #1310/#1320)'
        : `remaining allowance rail=${settle.allowance.rail}`

    // ── 9. Both on-chain legs, not just the merchant saying yes ──────────────
    const fundingHash = settle.funding_tx_hash
    const merchantHash = settle.settlement_tx_hash
    if (!fundingHash) return fail('settle reported settled:true with no funding_tx_hash — the funding leg is unevidenced')
    if (!merchantHash) {
      return fail(
        'settle reported settled:true with no settlement_tx_hash — the merchant leg cannot be verified on-chain',
      )
    }
    if (fundingHash.toLowerCase() === merchantHash.toLowerCase()) {
      return fail(
        `funding and settlement report the SAME tx ${fundingHash} — the two-leg bridge collapsed to one hop`,
      )
    }

    const fundingReceipt = await waitForReceipt(provider, fundingHash)
    if (!fundingReceipt) return fail(`funding tx ${fundingHash} has no receipt on Base Sepolia`)
    if (fundingReceipt.status !== 1) return fail(`funding tx ${fundingHash} REVERTED on-chain`)

    const merchantReceipt = await waitForReceipt(provider, merchantHash)
    if (!merchantReceipt) {
      return fail(
        `merchant settlement tx ${merchantHash} has no receipt within ${TIMING.receiptWaitMs / 1000}s — ` +
          'the facilitator reported a hash that did not land',
      )
    }
    if (merchantReceipt.status !== 1) return fail(`merchant settlement tx ${merchantHash} REVERTED on-chain`)

    // ── 10. The budget was metered, and nothing was stranded ─────────────────
    //
    // Polled, not sampled once — see x402-hosted-mcp-signer's identical
    // rationale (public RPC load-balancing can lag the settlement receipt).
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

    // Zero residual, measured as a DELTA against this leg's own baseline —
    // see x402-hosted-mcp-signer's identical rationale (a settled merchant
    // must net to zero; an earlier leg's sub-floor dust is not this leg's bug).
    if (delegateAfter !== delegateBefore) {
      return fail(
        `delegate EOA ${delegateAddress} moved ${fmt(delegateBefore)} → ${fmt(delegateAfter)} USDC across a ` +
          `SETTLED payment — exact-amount funding must net to zero; this leg stranded ` +
          `${fmt(delegateAfter - delegateBefore)} USDC`,
      )
    }

    const carried = delegateAfter > 0n ? ` (${fmt(delegateAfter)} USDC pre-existing dust unchanged)` : ''
    return pass(
      `guided catalog purchase (${entry.name}, catalog_id ${entry.id}) settled via payment_id-only ` +
        `continuation: funding ${fundingHash} (block ${fundingReceipt.blockNumber}), merchant ${merchantHash} ` +
        `(block ${merchantReceipt.blockNumber}); treasury ${fmt(treasuryBefore)} → ${fmt(treasuryAfter)}, zero ` +
        `delegate residual${carried}; ${allowanceNote}; intent ${prep.payment_id}`,
    )
  },
}
