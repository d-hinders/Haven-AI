/**
 * #4789 (epic #4788 slice 1) — the LOCAL ↔ HOSTED contract parity manifest.
 *
 * The local MCP (`@haven_ai/mcp`) and this hosted one expose the same agent
 * surface twice, and nothing made a tool with the same name the same tool.
 * The cost on record is #2348 — four tools where the local MCP taught a
 * different argument name — and its worst case, `haven_send`'s idempotency key
 * silently dropped on the hosted surface. The remedy then was a pin per key; a
 * difference nobody had named yet was checked by nothing.
 *
 * This test derives EVERY difference between the two contracts from the two
 * live registries and fails unless `PARITY_MANIFEST` below lists exactly those,
 * each with a reason. It runs in both directions: an undeclared difference
 * fails, and so does a manifest entry that no longer corresponds to one, so the
 * manifest shrinks when the surfaces converge.
 *
 * It supersedes the `#3620` block that lived in `strict-tool-input.test.ts`,
 * which did this for the two budget-scope keys only. That block's one
 * allowlist entry (`haven_pay_x402_quote` / `sub_budget_id`) and its
 * different-name pair (`haven_pay` ↔ `haven_send`) are carried over here; the
 * budget-scope keys are ordinary keys to this test.
 *
 * Five difference classes:
 *   1. `localOnly`      — an input key only the local schema declares.
 *   2. `hostedOnly`     — an input key only the hosted schema declares.
 *   3. `requiredness`   — a key both declare, required on one side only.
 *   4. `legacyRefused`  — a key the local schema declares ONLY so its handler
 *                         can refuse it by name (#3411). Not an accepted
 *                         argument; each entry is proven by a call.
 *   5. `description`    — the two descriptions differ. The entry pins a short
 *                         hash of BOTH, so a later edit to either side of an
 *                         already-different pair is still a reviewed line.
 *
 * Required-ness is read the same way on both sides — `isOptional()` on each
 * zod field. Reading it from the zod type name on one side and a JSON-Schema
 * `required` list on the other reports a false difference for `z.unknown()`
 * fields; that mixed instrument is how the 2026-11-09 scan first counted 8
 * differing tools where there are 7.
 *
 * Out of scope, deliberately: the value TYPES of same-named keys, and strict
 * versus permissive parsing (hosted tools are strict through
 * `STRICT_INPUT_TOOLS`, local ones strip) — the per-tool transport pins in
 * `strict-tool-input.test.ts` cover that.
 *
 * A changed contract is fixed HERE, in the manifest, with a reason — or by
 * making the two surfaces agree.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  createToolHandlers as createLocalToolHandlers,
  toolDescriptions as localToolDescriptions,
  toolSchemas as localToolSchemas,
} from '@haven_ai/mcp'
import { toolDescriptions as hostedToolDescriptions, toolSchemas as hostedToolSchemas } from './tools/contracts.js'

type Shape = Record<string, z.ZodTypeAny>
type Reasons = Record<string, string>

interface PairManifest {
  localOnly?: Reasons
  hostedOnly?: Reasons
  requiredness?: Reasons
  legacyRefused?: Reasons
  description?: { local: string; hosted: string; reason: string }
}

const hostedShapes = hostedToolSchemas as unknown as Record<string, Shape>
const localShapes = localToolSchemas as unknown as Record<string, Shape>
const hostedDescriptions = hostedToolDescriptions as Record<string, string>
const localDescriptions = localToolDescriptions as Record<string, string>

/** A short, stable fingerprint of a description: enough to notice an edit. */
const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * Equivalent tools registered under different names (carried over from the
 * #3620 block). Hosted `haven_pay` is the direct wallet payment
 * (token/amount/to → POST /payments), the same operation as local
 * `haven_send` (asset/recipient/amount).
 */
const DIFFERENT_NAME_PAIRS: ReadonlyArray<readonly [hosted: string, local: string]> = [['haven_pay', 'haven_send']]

/** Tools that exist on one surface only. Adding a tool to either side is a line here. */
const LOCAL_ONLY_TOOLS: Reasons = {
  haven_pay_x402:
    'The local one-shot x402 fetch-and-pay. The hosted surface has no one-call equivalent: it is keyless, ' +
    'and pays x402 through haven_quote_x402 and haven_pay_x402_quote with the edge signer in between.',
}

const HOSTED_ONLY_NO_COUNTERPART =
  'Hosted-only tool; the local package has no counterpart. It is kept deliberately smaller: owner decision 2026-11-10, ' +
  'https://github.com/d-hinders/Haven-AI/issues/4788#issuecomment-6769233650.'

const HOSTED_ONLY_TOOLS: Reasons = {
  haven_check_funds: HOSTED_ONLY_NO_COUNTERPART,
  haven_pay: 'The hosted name for the direct wallet payment; the local package calls the same operation haven_send (see DIFFERENT_NAME_PAIRS).',
  haven_quote_mcp_tool: 'Hosted two-step paid-MCP flow (quote, then settle or complete); the local package pays an MCP tool in one call.',
  haven_settle_mcp_tool: 'Hosted two-step paid-MCP flow (quote, then settle or complete); the local package pays an MCP tool in one call.',
  haven_complete_mcp_tool: 'Hosted two-step paid-MCP flow (quote, then settle or complete); the local package pays an MCP tool in one call.',
  haven_quote_catalog_purchase: HOSTED_ONLY_NO_COUNTERPART,
  haven_prepare_catalog_purchase: HOSTED_ONLY_NO_COUNTERPART,
  haven_report_x402_outcome: HOSTED_ONLY_NO_COUNTERPART,
  haven_report_delivery_quality: HOSTED_ONLY_NO_COUNTERPART,
  haven_report_settlement_evidence: HOSTED_ONLY_NO_COUNTERPART,
}

const KEYLESS_SIGNING_PAYLOAD =
  'The hosted server is keyless and can return the signing payload for the edge signer (#1272); the local process signs itself.'
const LEGACY_IDEMPOTENCY_KEY =
  'Legacy camelCase spelling, declared only so the local handler can refuse it by name instead of the MCP SDK stripping it (#3411).'

/**
 * Keyed `hosted↔local`. A pair with no entry must have NO difference. Every
 * key and hash below must match the measured difference exactly.
 */
const PARITY_MANIFEST: Record<string, PairManifest> = {
  'haven_send↔haven_send': {
    hostedOnly: { include_signing_payload: KEYLESS_SIGNING_PAYLOAD },
    legacyRefused: { idempotencyKey: LEGACY_IDEMPOTENCY_KEY },
    description: {
      local: 'cdecc99b6a33',
      hosted: 'b484fd5fde05',
      reason:
        '#4796: each text names only tools its own surface has — the local one says no tool there checks funds against an amount (on funds, naming haven_get_allowances only for fundsCoverRemaining) and keeps haven_pay_x402, the hosted one points at haven_quote_x402 and haven_check_funds.',
    },
  },
  'haven_sweep_delegate↔haven_sweep_delegate': {
    hostedOnly: {
      authorization: 'The hosted sweep is keyless: the signed authorization comes back from the edge signer and is relayed in.',
      signature: 'The hosted sweep is keyless: the signature comes back from the edge signer and is relayed in.',
    },
    description: {
      local: 'b702163e8c18',
      hosted: 'de1f44567c0a',
      reason:
        'The hosted text describes two keyless phases (the authorization out, the signature back in); the local text describes one call.',
    },
  },
  'haven_submit↔haven_submit': {
    hostedOnly: {
      settlement_scheme:
        'Hosted haven_submit relays either a funding signature or an erc7710 settlement child and is told which; the local one takes no scheme.',
    },
    description: {
      local: '8d6a9dedf88c',
      hosted: 'e86bdff11c81',
      reason:
        'The local text opens with the three ids a signature can belong to; the hosted text leads with the payment signature and adds settlement_scheme and the decomposed-x402 follow-up.',
    },
  },
  'haven_pay_mcp_tool↔haven_pay_mcp_tool': {
    hostedOnly: {
      max_amount: 'The hosted tool takes a pre-funding price cap in atomic units; the local tool declares none.',
      max_amount_human: 'The hosted tool takes a pre-funding price cap in whole tokens; the local tool declares none.',
      include_signing_payload: KEYLESS_SIGNING_PAYLOAD,
    },
    legacyRefused: { idempotencyKey: LEGACY_IDEMPOTENCY_KEY },
    description: {
      local: 'f540347d6c34',
      hosted: '7eabc12dd14c',
      reason:
        'The local text describes the whole initialize, pay and retry round trip in one call; the hosted text describes step 1 of a flow that hands a funding intent to the signer.',
    },
  },
  'haven_quote_x402↔haven_quote_x402': {
    localOnly: {
      idempotency_key: 'The local quote accepts the key; the hosted surface takes it on haven_pay_x402_quote instead.',
    },
    legacyRefused: { idempotencyKey: LEGACY_IDEMPOTENCY_KEY },
    description: {
      local: '4bdcbaf93f4d',
      hosted: '86b932e45565',
      reason:
        'Each text names its own follow-up: the local quote is the input to haven_pay_x402_quote, the hosted one returns a next step restating the request with a cap. Both now say Haven is read for the agent (and, hosted, its budget) rather than "not contacted" (#4830).',
    },
  },
  'haven_pay_x402_quote↔haven_pay_x402_quote': {
    localOnly: {
      quote:
        'The local tool pays the quote object haven_quote_x402 returned; the hosted tool takes payment_required or the restated request instead.',
      sub_budget_id:
        'Owner decision 2 on epic #3615 (https://github.com/d-hinders/Haven-AI/issues/3615): the hosted forwarding was ' +
        'deleted rather than the argument declared (#3617); a sub-agent pays x402 through the local MCP.',
    },
    hostedOnly: {
      url: 'The hosted tool restates the quoted request; it does not accept a quote object.',
      method: 'The hosted tool restates the quoted request; it does not accept a quote object.',
      headers: 'The hosted tool restates the quoted request; it does not accept a quote object.',
      body: 'The hosted tool restates the quoted request; it does not accept a quote object.',
      payment_required:
        'Optional on hosted: the 402 body, for payment_required mode; request mode re-fetches it (#3739). The local quote object carries it.',
      max_amount: 'The hosted tool takes a pre-funding price cap in atomic units; the local quote object fixes the price.',
      max_amount_human: 'The hosted tool takes a pre-funding price cap in whole tokens; the local quote object fixes the price.',
      include_signing_payload: KEYLESS_SIGNING_PAYLOAD,
    },
    legacyRefused: { idempotencyKey: LEGACY_IDEMPOTENCY_KEY },
    description: {
      local: '49aa7859cd0a',
      hosted: '86bacb9685b5',
      reason:
        'Two different input contracts under one name (a quote object versus a restated request), each described as such.',
    },
  },
  'haven_resume_x402_payment↔haven_resume_x402_payment': {
    hostedOnly: { url: '#3097: the hosted tool takes the https URL originally quoted, as haven_pay_x402_quote does.' },
    description: {
      local: 'fc8f347c51db',
      hosted: '671adfb0a4d0',
      reason:
        'The local text retries the merchant itself with the signed header; the hosted text returns the signing context for the signer to rebuild it.',
    },
  },
  'haven_discover_tools↔haven_discover_tools': {
    description: {
      local: '47196709f983',
      hosted: '342bd2c26816',
      reason:
        'Same inputs and the same text, except that the hosted one ends by pointing at haven_prepare_catalog_purchase, a hosted-only tool.',
    },
  },
  'haven_open_task_budget↔haven_open_task_budget': {
    description: {
      local: 'de104b0f1fa7',
      hosted: 'c0d794452742',
      reason:
        'Same inputs; the local text returns next_tool and next_arguments for the signature, the hosted text returns sign_data and names the haven_submit relay.',
    },
  },
  'haven_close_task_budget↔haven_close_task_budget': {
    description: {
      local: '4820ffb90a95',
      hosted: '9f4f5a7c917f',
      reason:
        'Same inputs; the local text returns next_tool and next_arguments for the signature, the hosted text returns sign_data and names signer_compatibility.',
    },
  },
  'haven_get_task_budget↔haven_get_task_budget': {
    description: {
      local: 'b53efc5dca8e',
      hosted: 'cde4fcb7b025',
      reason:
        'Same inputs; the local text adds one closing clause (this reads any one, closed or expired included).',
    },
  },
  'haven_pay↔haven_send': {
    localOnly: {
      asset: 'Vocabulary: the local tool says asset where the hosted haven_pay says token.',
      recipient: 'Vocabulary: the local tool says recipient where the hosted haven_pay says to.',
    },
    hostedOnly: {
      token: 'Vocabulary: the hosted haven_pay says token where the local tool says asset.',
      to: 'Vocabulary: the hosted haven_pay says to where the local tool says recipient.',
      include_signing_payload: KEYLESS_SIGNING_PAYLOAD,
    },
    legacyRefused: { idempotencyKey: LEGACY_IDEMPOTENCY_KEY },
    description: {
      local: 'cdecc99b6a33',
      hosted: 'f376faf01734',
      reason:
        'Two names for the direct wallet payment: the local text describes a send, the hosted text describes constructing an unsigned payload for the signer.',
    },
  },
}

const sharedNames = Object.keys(hostedShapes).filter((name) => name in localShapes)
const pairs: Array<readonly [hosted: string, local: string]> = [
  ...sharedNames.map((name) => [name, name] as const),
  ...DIFFERENT_NAME_PAIRS,
]
const pairKey = (hosted: string, local: string): string => `${hosted}↔${local}`

/** The measured difference for one pair, in the manifest's own shape (reasons dropped). */
function measured(hosted: string, local: string, legacyKeys: readonly string[]) {
  const h = hostedShapes[hosted]
  const l = localShapes[local]
  const localOnly = Object.keys(l).filter((k) => !(k in h))
  const hostedDescription = hostedDescriptions[hosted]
  const localDescription = localDescriptions[local]
  return {
    localOnly: localOnly.filter((k) => !legacyKeys.includes(k)).sort(),
    hostedOnly: Object.keys(h)
      .filter((k) => !(k in l))
      .sort(),
    requiredness: Object.keys(l)
      .filter((k) => k in h && l[k].isOptional() !== h[k].isOptional())
      .sort(),
    legacyRefused: localOnly.filter((k) => legacyKeys.includes(k)).sort(),
    description:
      hostedDescription === localDescription ? null : { local: hashOf(localDescription), hosted: hashOf(hostedDescription) },
  }
}

/** What the manifest declares for one pair, reduced to the same shape. */
function declared(key: string) {
  const entry = PARITY_MANIFEST[key] ?? {}
  return {
    localOnly: Object.keys(entry.localOnly ?? {}).sort(),
    hostedOnly: Object.keys(entry.hostedOnly ?? {}).sort(),
    requiredness: Object.keys(entry.requiredness ?? {}).sort(),
    legacyRefused: Object.keys(entry.legacyRefused ?? {}).sort(),
    description: entry.description ? { local: entry.description.local, hosted: entry.description.hosted } : null,
  }
}

/** Every key any manifest entry classes as declared-only-to-be-refused. */
const LEGACY_KEYS = [...new Set(Object.values(PARITY_MANIFEST).flatMap((entry) => Object.keys(entry.legacyRefused ?? {})))]

describe('#4789 — local ↔ hosted contract parity: every difference is declared, with a reason', () => {
  it('compares something, and the instruments can say yes (anti-vacuity)', () => {
    expect(sharedNames.length).toBeGreaterThan(0)
    expect(pairs.length).toBe(sharedNames.length + DIFFERENT_NAME_PAIRS.length)
    // Both members of every different-name pair exist on their runtime.
    for (const [hosted, local] of DIFFERENT_NAME_PAIRS) {
      expect(Object.keys(hostedShapes)).toContain(hosted)
      expect(Object.keys(localShapes)).toContain(local)
    }
    // The key probe can see a key that is there, and the optionality probe can
    // tell a required field from an optional one, on BOTH registries.
    expect(Object.keys(hostedShapes.haven_send)).toContain('recipient')
    expect(Object.keys(localShapes.haven_send)).toContain('recipient')
    expect(hostedShapes.haven_send.recipient.isOptional()).toBe(false)
    expect(localShapes.haven_send.recipient.isOptional()).toBe(false)
    expect(hostedShapes.haven_send.idempotency_key.isOptional()).toBe(true)
    expect(localShapes.haven_send.idempotency_key.isOptional()).toBe(true)
    // The manifest names only real pairs.
    const keys = pairs.map(([hosted, local]) => pairKey(hosted, local))
    // Carried over from the #3620 block: the pairs that carry a budget scope
    // today are in the list, so it cannot silently shrink past them.
    for (const expected of [
      'haven_send↔haven_send',
      'haven_submit↔haven_submit',
      'haven_get_task_budget↔haven_get_task_budget',
      'haven_close_task_budget↔haven_close_task_budget',
      'haven_pay_x402_quote↔haven_pay_x402_quote',
      'haven_pay↔haven_send',
    ]) {
      expect(keys).toContain(expected)
    }
    for (const scope of ['task_budget_id', 'sub_budget_id']) {
      expect(Object.keys(hostedShapes.haven_send)).toContain(scope)
      expect(Object.keys(localShapes.haven_send)).toContain(scope)
    }
    for (const key of Object.keys(PARITY_MANIFEST)) expect(keys, key).toContain(key)
  })

  for (const [hosted, local] of pairs) {
    const key = pairKey(hosted, local)
    it(`${hosted} (hosted) ↔ ${local} (local): the measured difference is exactly the declared one`, () => {
      expect(
        measured(hosted, local, LEGACY_KEYS),
        `the ${key} contract differs from PARITY_MANIFEST. Declare the difference there with a reason, ` +
          'or make the two surfaces agree.',
      ).toEqual(declared(key))
    })
  }

  it('no manifest entry is empty: an entry declares at least one difference', () => {
    // An entry emptied when two surfaces converge would otherwise sit there
    // asserting nothing. Delete it instead.
    for (const [key, entry] of Object.entries(PARITY_MANIFEST)) {
      const size =
        Object.keys(entry.localOnly ?? {}).length +
        Object.keys(entry.hostedOnly ?? {}).length +
        Object.keys(entry.requiredness ?? {}).length +
        Object.keys(entry.legacyRefused ?? {}).length +
        (entry.description ? 1 : 0)
      expect(size, key).toBeGreaterThan(0)
    }
  })

  it('every declared difference carries a real reason', () => {
    const reasons: Array<[where: string, reason: string]> = []
    for (const [key, entry] of Object.entries(PARITY_MANIFEST)) {
      for (const cls of ['localOnly', 'hostedOnly', 'requiredness', 'legacyRefused'] as const) {
        for (const [k, reason] of Object.entries(entry[cls] ?? {})) reasons.push([`${key} ${cls}.${k}`, reason])
      }
      if (entry.description) reasons.push([`${key} description`, entry.description.reason])
    }
    for (const [name, reason] of Object.entries({ ...LOCAL_ONLY_TOOLS, ...HOSTED_ONLY_TOOLS })) reasons.push([name, reason])
    expect(reasons.length).toBeGreaterThan(0)
    for (const [where, reason] of reasons) {
      expect(reason.trim().length, where).toBeGreaterThanOrEqual(15)
      expect(reason, where).not.toMatch(/\b(todo|tbd|fixme|xxx)\b/i)
    }
  })

  it('a tool that exists on one surface only is a declared line, in both directions', () => {
    const localOnly = Object.keys(localShapes)
      .filter((name) => !(name in hostedShapes))
      .sort()
    const hostedOnly = Object.keys(hostedShapes)
      .filter((name) => !(name in localShapes))
      .sort()
    expect(localOnly).toEqual(Object.keys(LOCAL_ONLY_TOOLS).sort())
    expect(hostedOnly).toEqual(Object.keys(HOSTED_ONLY_TOOLS).sort())
  })
})

describe('#4789 — a legacy key is declared only to be refused (#3411)', () => {
  const legacyCases = Object.entries(PARITY_MANIFEST).flatMap(([key, entry]) =>
    Object.keys(entry.legacyRefused ?? {}).map((legacyKey) => [key.split('↔')[1], legacyKey] as const),
  )
  const uniqueCases = [...new Map(legacyCases.map((c) => [`${c[0]}.${c[1]}`, c])).values()]

  // The tool's own otherwise-valid arguments, so the refusal under test is the
  // legacy key's and not a missing required field's (`INVALID_INPUT`).
  const VALID_ARGS: Record<string, Record<string, unknown>> = {
    haven_send: { asset: 'USDC', recipient: `0x${'1'.repeat(40)}`, amount: '1' },
    haven_pay_mcp_tool: { merchant_url: 'https://merchant.example/mcp', tool_name: 'paid_tool' },
    haven_quote_x402: { url: 'https://merchant.example/paid' },
    haven_pay_x402_quote: { quote: { url: 'https://merchant.example/paid' } },
  }

  it('there is at least one such key to prove, and every case has valid arguments', () => {
    expect(uniqueCases.length).toBeGreaterThan(0)
    for (const [localTool] of uniqueCases) expect(Object.keys(VALID_ARGS), localTool).toContain(localTool)
  })

  it('CONTROL: without the legacy key the same call is NOT refused by that name', async () => {
    // Otherwise "refused" could be the handler refusing every call.
    for (const [localTool] of uniqueCases) {
      const client = new Proxy({}, { get: () => async () => { throw new Error('reached the client') } })
      const handlers = createLocalToolHandlers(client as never) as Record<string, (input: unknown) => Promise<unknown>>
      const result = (await handlers[localTool](VALID_ARGS[localTool])) as { code?: string }
      expect(result.code, localTool).not.toBe('IDEMPOTENCY_KEY_RENAMED')
    }
  })

  for (const [localTool, legacyKey] of uniqueCases) {
    it(`local ${localTool} refuses "${legacyKey}" by name, before anything is contacted`, async () => {
      const reached: string[] = []
      // A client whose every method records the call and fails: a refusal that
      // happens before anything is contacted leaves `reached` empty.
      const client = new Proxy(
        {},
        {
          get: (_target, prop) => async () => {
            reached.push(String(prop))
            throw new Error(`the local handler reached the client (${String(prop)}) before refusing`)
          },
        },
      )
      const handlers = createLocalToolHandlers(client as never) as Record<string, (input: unknown) => Promise<unknown>>
      const result = (await handlers[localTool]({ ...VALID_ARGS[localTool], [legacyKey]: 'legacy-key-value' })) as {
        success?: boolean
        code?: string
      }
      expect(result.success).toBe(false)
      expect(result.code).toBe('IDEMPOTENCY_KEY_RENAMED')
      expect(reached).toEqual([])
    })
  }
})
