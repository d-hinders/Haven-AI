/**
 * #2808 — the helper-to-capability ownership map and its enforcement.
 *
 * TWO ROLES, one file:
 *
 * 1. EVIDENCE. The issue's derived rule: "every helper called from more than
 *    one capability slice's handler bodies lives in shared support", re-derived
 *    after #2809, #2810, #2811 and #2812. The slices are the tool partitions
 *    the epic #2806 chain carves `createToolHandlers` into:
 *
 *      #2809 state/direct/recovery : get_agent, get_allowances, sweep_delegate,
 *                                    send, pay, submit, get_payment_status,
 *                                    get_resume_state, list_receipts,
 *                                    verify_receipt
 *      #2810 catalog/quote/prepare : discover_tools, submit_catalog_entry,
 *                                    quote_mcp_tool, quote_catalog_purchase,
 *                                    prepare_catalog_purchase, pay_mcp_tool
 *      #2811 plain-HTTP x402       : quote_x402, pay_x402_quote,
 *                                    resume_x402_payment, report_x402_outcome
 *      #2812 paid-MCP completion   : complete_mcp_tool, settle_mcp_tool
 *
 *    Measured at origin/dev 618cce60 against those handler bodies, the
 *    cross-slice helpers are exactly the five groups the issue names plus the
 *    three the epic review note added (buildMcpToolQuoteResponse,
 *    isPendingApproval, quoteWarnings) — all below, each with its slices.
 *    Re-derived 2026-09-10 at this branch's head (f6fe66f8) under the
 *    partition the sibling issue bodies state (#2810 claims
 *    haven_submit_catalog_entry; #2811 claims haven_report_x402_outcome;
 *    #2809 keeps payment status/resume-state), after the first measurement
 *    misfiled those two handlers under #2809: the slice tags below did NOT
 *    change, because both handler bodies call only helpers already shared by
 *    all four slices (runTool, buildAgentGuidance) plus the #2807 parsing
 *    seam (parseStrict) — re-grepped tools.ts, recorded here per the issue's
 *    re-derivation rule.
 *
 * 2. ENFORCEMENT. The mapping is executable, with ground truth derived from
 *    the imported support-module namespaces at runtime rather than any hand-
 *    maintained list: every runtime export of every support module must be
 *    assigned to exactly one entry below (a NEW support export fails this
 *    suite until it is mapped — support cannot grow unowned, even when its
 *    author forgets the enumeration list), every assigned name must actually
 *    exist, `tools.ts` stays handler-and-facade only (no helper definitions
 *    regrow in the monolith), `parse`/`parseStrict` stay in #2807's parsing
 *    seam and NEVER move into support, and support modules import no
 *    capability code.
 *
 * MUTATION PROTOCOL (per the issue's acceptance criteria, non-negotiable):
 * the two load-bearing guards carry proofs that the suite can fail —
 *   (a) selecting the WRONG QUOTED OPTION must fail the cap (the #2051
 *       steering exploit) — tests marked MUTATION (a);
 *   (b) RELAYING BEFORE merchant-context validation must fail (the #2282
 *       funded-but-unsettled stranding) — tests marked MUTATION (b).
 * Reverting the guard code in support (cap-price.ts / mcp-context.ts) turns
 * the named test red while every positive control stays green; restore after.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest'
import fs from 'node:fs'
import {
  AgentPaymentFailureCode,
  AgentPaymentNextAction,
  HavenApiError,
} from '@haven_ai/sdk'
import * as capPrice from './cap-price.js'
import * as catalogEntry from './catalog-entry.js'
import * as errors from './errors.js'
import * as guidance from './guidance.js'
import * as mcpContext from './mcp-context.js'
import * as quoteResponse from './quote-response.js'
import * as signerCompat from './signer-compat.js'
import { parse, parseStrict } from '../parsing.js'
import { createToolHandlers } from '../../tools.js'
import {
  AGENT_ALLOWANCES_RESPONSE,
  AGENT_RESPONSE,
  DELEGATE_KEY,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  clearCalls as _clearCalls,
  handlers,
  installSharedFixtureLifecycle,
  keylessClient,
  mintPaymentHeaders,
  ok,
  recordedCalls,
  stubFetch,
  VALID_PAYMENT_HEADER_REF,
} from '../../test-support/hosted-mcp.js'

installSharedFixtureLifecycle()

// ── the ownership map ─────────────────────────────────────────────────────────

/** Capability slices of the #2806 chain, by tool partition. */
const CAPABILITY_SLICES = {
  s2809: 'state/direct/recovery handlers (#2809)',
  s2810: 'catalog/quote/prepare handlers (#2810)',
  s2811: 'plain-HTTP x402 handlers (#2811)',
  s2812: 'paid-MCP completion handlers (#2812)',
} as const

type Slice = keyof typeof CAPABILITY_SLICES

/**
 * The derived mapping: helper → owning support module → the slices whose
 * handler bodies call it. A helper listed with 2+ slices MUST live in
 * support. A helper with one slice belongs to that capability, not here —
 * the map may retain such an export only as a declared exception in
 * SINGLE_SLICE_RETAINED below (with a reason), and the suite enforces that
 * rule in both directions.
 */
const HELPER_OWNERSHIP: Record<string, { module: string; slices: Slice[] }> = {
  // tools/support/errors.ts — error normalization + HostedToolError ("error
  // normalization and HostedToolError" group; the class named explicitly per
  // the epic review note so it falls through no crack).
  HostedToolError: { module: 'errors', slices: ['s2809', 's2810', 's2811', 's2812'] },
  runTool: { module: 'errors', slices: ['s2809', 's2810', 's2811', 's2812'] },
  normalizeError: { module: 'errors', slices: ['s2809', 's2810', 's2811', 's2812'] },
  isX402PaymentWindowExpired: { module: 'errors', slices: ['s2809', 's2810', 's2811', 's2812'] },
  paymentWindowExpiredError: { module: 'errors', slices: ['s2809', 's2810', 's2811', 's2812'] },
  paymentWindowExpiredErrorFor: { module: 'errors', slices: ['s2809', 's2810', 's2811', 's2812'] },
  // tools/support/guidance.ts — agent guidance and purchase summaries.
  buildAgentGuidance: { module: 'guidance', slices: ['s2809', 's2810', 's2811', 's2812'] },
  buildPurchaseSummary: { module: 'guidance', slices: ['s2810', 's2812'] },
  // tools/support/cap-price.ts — cap/price selection.
  readMaxAmountCap: { module: 'cap-price', slices: ['s2810', 's2811'] },
  priceSelectedOption: { module: 'cap-price', slices: ['s2810', 's2811'] },
  assertWithinMaxAmount: { module: 'cap-price', slices: ['s2810', 's2811'] },
  resolveCapAtomic: { module: 'cap-price', slices: ['s2810', 's2811'] },
  humanToAtomic: { module: 'cap-price', slices: ['s2810', 's2811'] },
  atomicToDisplay: { module: 'cap-price', slices: ['s2810', 's2811'] },
  requireSettleableSelection: { module: 'cap-price', slices: ['s2810', 's2811'] },
  quoteWarnings: { module: 'cap-price', slices: ['s2810', 's2811'] },
  CAP_WARNING_TEXT: { module: 'cap-price', slices: ['s2810', 's2811'] },
  QUOTE_EXPIRES_SOON_MS: { module: 'cap-price', slices: ['s2810', 's2811'] },
  MaxAmountCap: { module: 'cap-price', slices: ['s2810', 's2811'] },
  // tools/support/signer-compat.ts — expiry/signing context, signer half.
  SIGNER_CAPABILITY_KEY: { module: 'signer-compat', slices: ['s2810', 's2811'] },
  signerCompatibilityNotice: { module: 'signer-compat', slices: ['s2810', 's2811'] },
  // tools/support/mcp-context.ts — transport serialization/context validation,
  // merchant delivery, signing context, relay wrappers.
  delegationSignFields: { module: 'mcp-context', slices: ['s2809', 's2810', 's2811'] },
  buildX402SigningContext: { module: 'mcp-context', slices: ['s2810', 's2811'] },
  serializeMcpTransport: { module: 'mcp-context', slices: ['s2810', 's2812'] },
  parseMcpTransport: { module: 'mcp-context', slices: ['s2810', 's2812'] },
  isMerchantEndpointMiss: { module: 'mcp-context', slices: ['s2810'] },
  withDiscoveryGuidance: { module: 'mcp-context', slices: ['s2810'] },
  quoteMcpToolCall: { module: 'mcp-context', slices: ['s2810'] },
  resolveMerchantCallContext: { module: 'mcp-context', slices: ['s2812'] },
  ResolvedMerchantCallContext: { module: 'mcp-context', slices: ['s2812'] },
  deliverMerchantPayment: { module: 'mcp-context', slices: ['s2812'] },
  preflightMcpPaymentHeader: { module: 'mcp-context', slices: ['s2812'] },
  submitSignatureWithExpiryMapping: { module: 'mcp-context', slices: ['s2809', 's2812'] },
  submitErc7710WithExpiryMapping: { module: 'mcp-context', slices: ['s2809'] },
  coerceJsonField: { module: 'mcp-context', slices: ['s2811'] },
  // tools/support/quote-response.ts — quote responses + status predicates.
  buildMcpToolQuoteResponse: { module: 'quote-response', slices: ['s2810', 's2811'] },
  isPendingApproval: { module: 'quote-response', slices: ['s2809', 's2810', 's2811', 's2812'] },
  wrongTool: { module: 'quote-response', slices: ['s2811'] },
  resolveResumeState: { module: 'quote-response', slices: ['s2811'] },
  // tools/support/catalog-entry.ts — catalog refusal contract, shared by the
  // #2810 quote/preflight paths whose error shape the #2811 resume tests pin.
  getUsableCatalogMcpEntry: { module: 'catalog-entry', slices: ['s2810'] },
}

/**
 * Declared single-slice exceptions to the rule above.
 *
 * The rule says a helper called from exactly one capability slice belongs to
 * that capability, not here. Each export below is measured at exactly one
 * slice, yet is retained in shared support — until the #2809–#2812 carve-out
 * chain lands and moves it into its owning capability module (the capability
 * modules do not exist yet; these are the exports the carve-outs will move).
 * The retained set is executable: the enforcement test requires every
 * single-slice entry in HELPER_OWNERSHIP to appear here with a non-empty
 * reason, and rejects any name here that is not a 1-slice map entry, so a
 * future slice cannot add a single-slice support export without declaring
 * it. Entries marked "deliberate" genuinely share code/pattern with another
 * support helper and are expected to remain shared even after the carve-out.
 */
const SINGLE_SLICE_RETAINED: Record<string, string /* reason */> = {
  // s2810 (#2810 catalog/quote/prepare capability, to come):
  isMerchantEndpointMiss:
    'Only the #2810 handlers call it; retained in support until #2810 moves it into its capability module.',
  withDiscoveryGuidance:
    'Only the #2810 handlers call it; retained in support until #2810 moves it into its capability module.',
  quoteMcpToolCall:
    'Only the #2810 handlers call it; retained in support until #2810 moves it into its capability module.',
  getUsableCatalogMcpEntry:
    'Only the #2810 handlers call it; retained in support until #2810 moves it into its capability module.',
  // s2812 (#2812 paid-MCP completion capability, to come):
  resolveMerchantCallContext:
    'Only the #2812 handlers call it; retained in support until #2812 moves it into its capability module.',
  ResolvedMerchantCallContext:
    'Type-only shape of resolveMerchantCallContext; retained alongside it until #2812 moves the pair.',
  deliverMerchantPayment:
    'Only the #2812 handlers call it; retained in support until #2812 moves it into its capability module.',
  preflightMcpPaymentHeader:
    'Only the #2812 handlers call it; retained in support until #2812 moves it into its capability module.',
  // s2809 (#2809 state/direct/recovery capability, to come):
  submitErc7710WithExpiryMapping:
    'Only the #2809 handlers call it, but it is DELIBERATE: it shares the expiry-mapping pattern with ' +
    'submitSignatureWithExpiryMapping (s2809+s2812) and stays beside it in support until #2812 settles ' +
    'where the shared pattern lives.',
  // s2811 (#2811 plain-HTTP x402 capability, to come):
  coerceJsonField:
    'Only the #2811 handlers call it; retained in support until #2811 moves it into its capability module.',
  wrongTool:
    'Only the #2811 handlers call it; retained in support until #2811 moves it into its capability module.',
  resolveResumeState:
    'Only the #2811 handlers call it; retained in support until #2811 moves it into its capability module.',
}

/** Support module → its runtime export names, enumerated (not derived). */
const SUPPORT_MODULE_EXPORTS: Record<string, string[]> = {
  'cap-price': [
    'assertWithinMaxAmount',
    'readMaxAmountCap',
    'humanToAtomic',
    'resolveCapAtomic',
    'atomicToDisplay',
    'requireSettleableSelection',
    'priceSelectedOption',
    'CAP_WARNING_TEXT',
    'QUOTE_EXPIRES_SOON_MS',
    'quoteWarnings',
  ],
  'catalog-entry': ['getUsableCatalogMcpEntry'],
  errors: [
    'HostedToolError',
    'runTool',
    'isX402PaymentWindowExpired',
    'paymentWindowExpiredError',
    'paymentWindowExpiredErrorFor',
    'normalizeError',
  ],
  guidance: ['buildAgentGuidance', 'buildPurchaseSummary'],
  'mcp-context': [
    'delegationSignFields',
    'isMerchantEndpointMiss',
    'withDiscoveryGuidance',
    'quoteMcpToolCall',
    'serializeMcpTransport',
    'parseMcpTransport',
    'resolveMerchantCallContext',
    'deliverMerchantPayment',
    'buildX402SigningContext',
    'coerceJsonField',
    'submitSignatureWithExpiryMapping',
    'submitErc7710WithExpiryMapping',
    'preflightMcpPaymentHeader',
  ],
  'quote-response': [
    'buildMcpToolQuoteResponse',
    'isPendingApproval',
    'wrongTool',
    'resolveResumeState',
  ],
  'signer-compat': ['SIGNER_CAPABILITY_KEY', 'signerCompatibilityNotice'],
}

/** Type-only exports: mapped for ownership, absent at runtime by design. */
const TYPE_ONLY_EXPORTS = new Set(['MaxAmountCap', 'ResolvedMerchantCallContext'])

/**
 * Exact-name exclusion for symbols that appear on a module namespace at
 * runtime but are not helpers and can never be owned: vitest's module
 * internals (import.meta/env interop). Listed explicitly — NOT a prefix or
 * regex — so a future real helper named like these can never be hidden from
 * enforcement. Re-check the keys when vitest major versions change them.
 */
const MODULE_INTERNAL_SYMBOLS = new Set(['default', 'META_ENV'])

const SUPPORT_MODULE_OBJECTS: Record<string, Record<string, unknown>> = {
  'cap-price': capPrice,
  'catalog-entry': catalogEntry,
  errors,
  guidance,
  'mcp-context': mcpContext,
  'quote-response': quoteResponse,
  'signer-compat': signerCompat,
}

// Type-level names ride the mapped export; the TYPE_ONLY set covers their
// absence at runtime in the checks above.

describe('shared-helper ownership map (#2808)', () => {
  it('maps every support-module export to exactly one ownership entry', () => {
    // Ground truth is the IMPORTED NAMESPACE, not the SUPPORT_MODULE_EXPORTS
    // enumeration: an export added to a module but forgotten in the list must
    // still fail here (the runtime→enumeration direction). Vitest-visible
    // module-internal symbols are excluded by exact name, never by prefix —
    // a blanket prefix filter could hide a future real helper.
    const unowned: string[] = []
    for (const [moduleName, runtime] of Object.entries(SUPPORT_MODULE_OBJECTS)) {
      for (const name of Object.keys(runtime)) {
        if (MODULE_INTERNAL_SYMBOLS.has(name) || TYPE_ONLY_EXPORTS.has(name)) continue
        const owner = HELPER_OWNERSHIP[name]
        if (!owner) unowned.push(`${moduleName}.${name} (no HELPER_OWNERSHIP entry)`)
        else if (owner.module !== moduleName) unowned.push(`${moduleName}.${name} (mapped to ${owner.module})`)
      }
    }
    expect(
      unowned,
      `support exports without exactly one matching ownership entry (add them to HELPER_OWNERSHIP with their module and slices): ${unowned.join(', ')}`,
    ).toEqual([])
    const unmapped: string[] = []
    for (const [moduleName, exports] of Object.entries(SUPPORT_MODULE_EXPORTS)) {
      const runtime = SUPPORT_MODULE_OBJECTS[moduleName] as Record<string, unknown>
      for (const name of exports) {
        if (!TYPE_ONLY_EXPORTS.has(name) && !(name in runtime)) {
          throw new Error(`support/${moduleName}.ts declares export "${name}" that does not exist at runtime`)
        }
        if (!HELPER_OWNERSHIP[name]) unmapped.push(`${moduleName}.${name}`)
      }
    }
    expect(unmapped, `unmapped support exports (add them to HELPER_OWNERSHIP with their slices): ${unmapped.join(', ')}`).toEqual([])
  })

  it('maps only names that exist in a support module', () => {
    const phantom: string[] = []
    for (const [name, owner] of Object.entries(HELPER_OWNERSHIP)) {
      // Type-only exports carry no runtime export; the module is still their
      // single owner (declared there, exported nowhere else).
      if (TYPE_ONLY_EXPORTS.has(name)) continue
      const moduleExports = SUPPORT_MODULE_EXPORTS[owner.module] ?? []
      if (!moduleExports.includes(name)) phantom.push(`${owner.module}⊥${name}`)
    }
    expect(phantom, `ownership entries naming helpers their module does not carry: ${phantom.join(', ')}`).toEqual([])
  })

  it('keeps parse/parseStrict owned by the #2807 parsing seam, never support', () => {
    // The issue is explicit: parse/parseStrict remain #2807's contract/parsing
    // seam. No support module may carry them.
    for (const [moduleName, exports] of Object.entries(SUPPORT_MODULE_EXPORTS)) {
      expect(exports, `${moduleName} must not own the parsing seam`).not.toContain('parse')
      expect(exports, `${moduleName} must not own the parsing seam`).not.toContain('parseStrict')
    }
    for (const runtime of Object.values(SUPPORT_MODULE_OBJECTS)) {
      expect('parse' in runtime, 'parse must stay in tools/parsing.ts').toBe(false)
      expect('parseStrict' in runtime, 'parseStrict must stay in tools/parsing.ts').toBe(false)
    }
    expect(typeof parse).toBe('function')
    expect(typeof parseStrict).toBe('function')
  })

  it('keeps tools.ts a handler+facade module: no helper definitions regrow there', () => {
    // The facade keeps createToolHandlers + re-exports; the #2807 seam and
    // #2808 support carry everything else. Read the SOURCE, not the runtime:
    // a helper definition regrowing in tools.ts must move to its capability
    // slice or support — this suite refuses to ratify it.
    const fsMod = fs
    const src = fsMod.readFileSync(new URL('../../tools.ts', import.meta.url), 'utf8')
    for (const name of Object.keys(HELPER_OWNERSHIP)) {
      expect(
        src.match(new RegExp(`(export )?(async )?function ${name}\\b|(export )?class ${name}\\b|(export )?const ${name}\\b`)),
        `"${name}" must live in support, not be re-defined in tools.ts`,
      ).toBeNull()
    }
  })

  it('keeps every mapped helper justified as shared (the issue names five)', () => {
    // Slice tags must reference real slices of the #2806 chain (no typos).
    const realSlices = new Set(Object.keys(CAPABILITY_SLICES))
    for (const [name, entry] of Object.entries(HELPER_OWNERSHIP)) {
      for (const slice of entry.slices) {
        expect(realSlices.has(slice), `"${name}" names unknown slice "${slice}"`).toBe(true)
      }
    }
    // The issue requires the mapping to include, AT MINIMUM:
    for (const required of [
      'buildMcpToolQuoteResponse',
      'isPendingApproval',
      'quoteWarnings',
      'HostedToolError',
      'submitSignatureWithExpiryMapping',
    ]) {
      const entry = HELPER_OWNERSHIP[required]
      expect(entry, `the issue REQUIRES "${required}" in the committed mapping`).toBeDefined()
    }
  })

  it('enforces the single-slice rule: 2+ slices here, or a declared retained reason', () => {
    // The map's stated rule is now executable, in BOTH directions:
    //   →  every HELPER_OWNERSHIP entry must have 2+ slices OR be declared in
    //      SINGLE_SLICE_RETAINED with a non-empty reason — a future slice
    //      cannot add a single-slice support export without declaring it;
    //   ←  every SINGLE_SLICE_RETAINED key must be a HELPER_OWNERSHIP entry
    //      measured at exactly one slice — an exception cannot outlive the
    //      measurement that justifies it (e.g. after a carve-out moves the
    //      helper or a second slice starts calling it, the declaration must
    //      be re-judged, not silently kept).
    const undeclared: string[] = []
    for (const [name, entry] of Object.entries(HELPER_OWNERSHIP)) {
      if (entry.slices.length >= 2) continue
      const reason = SINGLE_SLICE_RETAINED[name]
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        undeclared.push(`${name} (${entry.slices.join('+')})`)
      }
    }
    expect(
      undeclared,
      `single-slice support exports without a SINGLE_SLICE_RETAINED reason (move them to their capability or declare why they are retained): ${undeclared.join(', ')}`,
    ).toEqual([])
    const stale: string[] = []
    for (const name of Object.keys(SINGLE_SLICE_RETAINED)) {
      const entry = HELPER_OWNERSHIP[name]
      if (!entry) stale.push(`${name} (no HELPER_OWNERSHIP entry)`)
      else if (entry.slices.length !== 1) stale.push(`${name} (${entry.slices.join('+')})`)
    }
    expect(
      stale,
      `SINGLE_SLICE_RETAINED entries that are not single-slice HELPER_OWNERSHIP entries (re-judge the declaration): ${stale.join(', ')}`,
    ).toEqual([])
  })
})

// ── MUTATION (a): the cap binds the SELECTED option, not another entry ────────
//
// Proven live on #2051/#2052: a merchant-controlled accepts[] could steer the
// cap onto the unselected entry — 900 USDC authorized against a stated 1 USDC
// cap while the response reported 1 USDC. `priceSelectedOption` (support) is
// the one function all three purchase paths go through. Reverting its
// assertWithinMaxAmount call (or reordering selection/cap) makes THE EXPLOIT
// succeed at 900000000 while THE MIRROR keeps passing.

const FACILITATORS = ['0x4444444444444444444444444444444444444444']
const DELEGATION_AGENT = { ...AGENT_RESPONSE, execution_rail: 'delegation' }
const CHILD = {
  payment_id: 'pay_7710',
  status: 'pending_signature',
  sign_data: {
    hash: '0x' + '11'.repeat(32),
    signature_scheme: 'eip712_delegation',
    typed_data: { domain: {}, types: {}, primaryType: 'Delegation', message: { caveats: [] } },
  },
}

/** Two payable Base-USDC entries that differ in amount and in the erc7710 tag. */
function steeredMerchant(standardAtomic: string, erc7710Atomic: string | null) {
  const base = PAYMENT_REQUIRED.accepts[0]
  return {
    ...PAYMENT_REQUIRED,
    accepts: [
      { ...base, amount: standardAtomic, maxAmountRequired: standardAtomic },
      ...(erc7710Atomic === null
        ? []
        : [
            {
              ...base,
              amount: erc7710Atomic,
              maxAmountRequired: erc7710Atomic,
              extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: FACILITATORS },
            },
          ]),
    ],
  }
}

/** The authorize request body — assert on what was SENT, never on call counts. */
function x402Body() {
  const call = recordedCalls().find((c) => new URL(c.url).pathname === '/x402')
  if (!call) return undefined
  const raw = call.body
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, any>
}

describe('MUTATION (a): selecting the wrong quoted option fails the cap', () => {
  function pay(pr: unknown, agent: Record<string, unknown>, cap: Record<string, string>) {
    stubFetch({
      'POST /mcp': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(pr)) },
      },
      'GET /machine-payments/agent': { status: 200, body: agent },
      // The SUCCESSFUL authorize stub: an unfixed build does not merely error,
      // it MINTS the settlement child at the over-cap amount.
      'POST /x402': { status: 201, body: CHILD },
    })
    return handlers().haven_pay_mcp_tool({
      merchant_url: 'http://merchant.test/mcp',
      tool_name: 'create_text',
      arguments: { prompt: 'Hello' },
      ...cap,
    })
  }

  it('THE EXPLOIT: refuses an over-cap erc7710 entry advertised beside an under-cap standard entry', async () => {
    // 1 USDC standard (passes the cap) + 900 USDC erc7710 (the one actually sent).
    const res = await pay(steeredMerchant('1000000', '900000000'), DELEGATION_AGENT, {
      max_amount_human: '1',
    })
    expect(res.success).toBe(false)
    expect((res as { code?: string }).code).toBe(AgentPaymentFailureCode.PriceExceedsMax)
    // Refused BEFORE the authorize: no settlement child was ever minted.
    expect(x402Body()).toBeUndefined()
  })

  it('THE MIRROR (positive control): a cheap erc7710 beside an over-cap standard entry is allowed', async () => {
    // Refusing here would cite an amount that was never going to be authorized
    // (#2052 measured 3 USDC standard / 0.50 USDC erc7710 against a 1 USDC cap).
    const res = ok<Record<string, any>>(
      await pay(steeredMerchant('3000000', '500000'), DELEGATION_AGENT, { max_amount_human: '1' }),
    )
    expect(res.data.settlement_scheme).toBe('erc7710')
    expect(x402Body()?.amount).toBe('500000')
    expect(x402Body()?.settlementScheme).toBe('erc7710')
  })

  it('a human cap converts with the SELECTED option decimals, not another entry (via support)', () => {
    // Unit-level pin on the moved helper: two options, both Base USDC — the
    // conversion uses the option HANDED IN, so the cap cannot drift between
    // entries at the helper level either. 1.5 USDC quoted against a 1 USDC
    // cap refuses; the same helper pricing the 0.5 entry passes.
    const option = PAYMENT_REQUIRED.accepts[0]
    expect(() => capPrice.priceSelectedOption({ kind: 'human', value: '1' }, option)).toThrow(
      /exceeds max_amount_human 1 USDC/,
    )
    const cheap = { ...option, amount: '500000', maxAmountRequired: '500000' }
    const priced = capPrice.priceSelectedOption({ kind: 'human', value: '1' }, cheap)
    expect(priced.amountAtomic).toBe('500000')
    expect(priced.amount).toBe('0.5')
    expect(priced.token).toBe('USDC')
  })
})

// ── MUTATION (b): the relay never precedes merchant-context validation ────────
//
// Proven on #2282: a settle whose merchant-call context is unavailable used to
// relay FUNDING first and only then discover the missing context — stranding a
// funded_but_unsettled intent. resolveMerchantCallContext (support) now runs
// before anything is submitted, on both schemes. Reverting that ordering in
// mcp-context.ts/deliverMerchantPayment makes "does NOT relay funding" red
// while the retryable positive control stays green.

const SIG = '0x' + '11'.repeat(65)

/** The exact wire assertion that matters: did any funding relay leave? */
const fundingRelayed = () =>
  recordedCalls().some(
    (call) => call.method === 'POST' && call.url.endsWith('/payments/pay_x402/sign'),
  )

describe('MUTATION (b): relaying before merchant-context validation fails', () => {
  beforeAll(async () => {
    await mintPaymentHeaders()
  })

  it('does NOT relay funding when a quote-first intent has no stored merchant context (3009)', async () => {
    // The #2282 repro: an intent created by haven_pay_x402_quote stores no MCP
    // call context. Route the funding relay as a SUCCESS so the assertion
    // cannot pass for the wrong reason — if the ordering regresses, the money
    // moves.
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError(
        'No stored merchant call context for this intent — pass merchant_url, tool_name, ' +
          'arguments, and mcp_transport explicitly (version-skew fallback).',
        409,
      ),
    )
    const merchant = vi.spyOn(haven, 'completeX402MerchantCall')

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })

    // THE assertion: no funding userop was relayed. An error code alone is not
    // enough — the pre-#2282 behaviour produced this same code with the money
    // already gone.
    expect(fundingRelayed()).toBe(false)
    expect(merchant).not.toHaveBeenCalled()
    if (payload.success) throw new Error('expected a context-unavailable failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantCallContextUnavailable)
    expect(payload.next_action).toBe(AgentPaymentNextAction.RetryWithExplicitContext)
  })

  it('positive control: the same tool succeeds on an explicit-context retry, nothing stranded', async () => {
    stubFetch({
      'POST /payments/pay_x402/sign': { status: 200, body: { status: 'confirmed', tx_hash: '0xfund' } },
    })
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError('No stored merchant call context for this intent', 409),
    )
    vi.spyOn(haven, 'completeX402MerchantCall').mockResolvedValue({
      status: 200, ok: true, body: { result: 'ok' }, settlementTxHash: '0xsettle',
    })
    const h = createToolHandlers(haven)

    const refused = await h.haven_settle_mcp_tool({
      payment_id: 'pay_x402', signature: SIG, payment_header: VALID_PAYMENT_HEADER_REF.v1,
    })
    expect(refused.success).toBe(false)
    expect(fundingRelayed()).toBe(false)

    const retry = ok<{ settled: boolean; funding_tx_hash: string | null }>(
      await h.haven_settle_mcp_tool({
        payment_id: 'pay_x402',
        signature: SIG,
        merchant_url: 'http://merchant.test/mcp',
        tool_name: 'buy_vpn',
        arguments: { plan: 'legacy' },
        mcp_transport: { handshake_required: true, source: 'path' },
        payment_header: VALID_PAYMENT_HEADER_REF.v1,
      }),
    )
    expect(fundingRelayed()).toBe(true)
    expect(retry.data.settled).toBe(true)
    expect(retry.data.funding_tx_hash).toBe('0xfund')
  })

  it('does NOT submit the erc7710 settlement child when the context is unavailable', async () => {
    // The no-funding-leg scheme has the same shape: POST /x402/:id/settle
    // consumes the signed settlement child, which cannot be re-signed.
    stubFetch({})
    const haven = keylessClient()
    vi.spyOn(haven, 'getX402MerchantCallContext').mockRejectedValue(
      new HavenApiError('No stored merchant call context for this intent', 409),
    )
    const settle = vi.spyOn(haven, 'submitX402Erc7710')

    const payload = await createToolHandlers(haven).haven_settle_mcp_tool({
      payment_id: 'pay_x402',
      signature: SIG,
      // no payment_header => erc7710 branch
    })

    expect(settle).not.toHaveBeenCalled()
    if (payload.success) throw new Error('expected a context-unavailable failure')
    expect(payload.code).toBe(AgentPaymentFailureCode.MerchantCallContextUnavailable)
  })
})

// ── ADOPTION: the shared fixture replaces the cloned setups ───────────────────

describe('shared fixture (test-support/hosted-mcp.ts)', () => {
  it('records every fetch with url/method/body/headers — the superset stub', async () => {
    stubFetch({
      'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
      'GET /machine-payments/allowances': { status: 200, body: AGENT_ALLOWANCES_RESPONSE },
    })
    await handlers().haven_get_agent({})
    const calls = recordedCalls()
    // getAgentSummary reads the agent AND its allowances (two GETs, the shape
    // the original tools.test.ts fixture modeled).
    expect(calls).toHaveLength(2)
    const agentCall = calls.find((c) => c.url.endsWith('/machine-payments/agent'))!
    expect(agentCall.method).toBe('GET')
    expect(agentCall.headers).toBeDefined()
    expect(agentCall.body).toBeUndefined()
  })

  it('keeps the custody invariant fixture: the delegate key never crosses the wire', async () => {
    stubFetch({
      'POST /payments': { status: 201, body: { payment_id: 'pay_1', status: 'pending_signature', sign_data: { hash: '0x1' } } },
    })
    await handlers().haven_pay({ token: 'USDC', amount: '1', to: '0xabc' })
    expect(JSON.stringify(recordedCalls())).not.toContain(DELEGATE_KEY)
    expect(JSON.stringify(recordedCalls())).not.toContain('delegate_key')
  })

  it('serves the x402 quote fixture the later capability splits consume', async () => {
    stubFetch({
      'GET /paid': {
        status: 402,
        responseHeaders: { 'PAYMENT-REQUIRED': btoa(JSON.stringify(PAYMENT_REQUIRED)) },
      },
    })
    const res = ok<Record<string, any>>(
      await handlers().haven_quote_x402({ url: 'http://haven.test/paid' }),
    )
    expect(res.data.payment_required).toBeDefined()
    expect(res.data.accepted_scheme).toBeDefined()
  })
})
