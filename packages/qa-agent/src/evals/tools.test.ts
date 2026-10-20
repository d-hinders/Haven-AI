/**
 * Tool-list + name-matching tests for the eval graders (#3958).
 *
 * The lists in `tools.ts` are copies, so they are held equal to their upstream
 * sources here (#4121): the hosted list to the keys of
 * `packages/mcp-server/src/tools-list.snapshot.json`, the signer list to the
 * keys of the built `@haven_ai/signer`'s `toolSchemas`. A tool added upstream
 * without landing in `tools.ts`, or removed upstream and left behind, turns
 * this file red by name. A hosted tool must also be placed in exactly one of
 * `PAYMENT_TOOLS` and `NON_PAYMENT_TOOLS`, so nobody can add it without
 * deciding whether it moves money.
 *
 * The snapshot is read with `readFileSync`, not imported: it lives outside
 * this package's `rootDir: "src"`, so an import would break `tsc --noEmit`.
 * A snapshot-only change still runs this file in CI, through the
 * `tools-list.snapshot.json` arm of `scripts/ci/change-classifier.mjs`.
 */

import { readFileSync } from 'node:fs'
import { toolSchemas } from '@haven_ai/signer'
import { describe, expect, it } from 'vitest'
import {
  ALL_TOOL_NAMES,
  HOSTED_TOOLS,
  NON_PAYMENT_TOOLS,
  PAYMENT_TOOLS,
  SIGNER_TOOLS,
  bareToolName,
  isPaymentTool,
} from './tools.js'
import { TOOL_COUNTS } from './tasks.js'

const SNAPSHOT_URL = new URL('../../../mcp-server/src/tools-list.snapshot.json', import.meta.url)

/** The hosted tool names a client receives: the snapshot's `.tools` keys. */
function snapshotToolNames(): string[] {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as { tools?: Record<string, unknown> }
  if (!snapshot.tools || typeof snapshot.tools !== 'object') {
    throw new Error(`${SNAPSHOT_URL.pathname} has no .tools object; the snapshot shape changed`)
  }
  return Object.keys(snapshot.tools)
}

/** Both directions of a set difference, sorted, so a failure names every tool. */
function setDiff(copy: readonly string[], upstream: readonly string[]) {
  const copySet = new Set(copy)
  const upstreamSet = new Set(upstream)
  return {
    upstreamButNotInCopy: upstream.filter((t) => !copySet.has(t)).sort(),
    inCopyButNotUpstream: copy.filter((t) => !upstreamSet.has(t)).sort(),
  }
}

const NO_DIFF = { upstreamButNotInCopy: [], inCopyButNotUpstream: [] }

describe('the tool lists against their upstream sources', () => {
  it('HOSTED_TOOLS equals the keys of tools-list.snapshot.json', () => {
    expect(setDiff(HOSTED_TOOLS, snapshotToolNames())).toEqual(NO_DIFF)
    expect(new Set(HOSTED_TOOLS).size).toBe(HOSTED_TOOLS.length)
  })

  it('SIGNER_TOOLS equals the keys of the signer toolSchemas', () => {
    expect(setDiff(SIGNER_TOOLS, Object.keys(toolSchemas))).toEqual(NO_DIFF)
    expect(new Set(SIGNER_TOOLS).size).toBe(SIGNER_TOOLS.length)
  })

  it('every snapshot tool is classified as payment or non-payment, exactly once', () => {
    const payment = new Set<string>(PAYMENT_TOOLS)
    const nonPayment = new Set<string>(NON_PAYMENT_TOOLS)
    const snapshot = snapshotToolNames()
    expect({
      unclassified: snapshot.filter((t) => !payment.has(t) && !nonPayment.has(t)).sort(),
      inBoth: PAYMENT_TOOLS.filter((t) => nonPayment.has(t)).sort(),
    }).toEqual({ unclassified: [], inBoth: [] })
    expect(setDiff([...PAYMENT_TOOLS, ...NON_PAYMENT_TOOLS], snapshot)).toEqual(NO_DIFF)
  })
})

describe('the list sizes (a readable count; the drift check is above)', () => {
  it('counts 29 hosted tools', () => {
    expect(HOSTED_TOOLS).toHaveLength(29)
    expect(TOOL_COUNTS.hosted).toBe(29)
  })

  it('counts 5 signer tools', () => {
    expect(SIGNER_TOOLS).toHaveLength(5)
    expect(SIGNER_TOOLS).toContain('haven_sign')
    expect(SIGNER_TOOLS).toContain('haven_x402_sign_header')
  })

  it('counts 9 payment tools, all hosted', () => {
    expect(PAYMENT_TOOLS).toHaveLength(9)
    for (const t of PAYMENT_TOOLS) expect(HOSTED_TOOLS).toContain(t)
    // Read-only tools must never count as payments.
    expect(PAYMENT_TOOLS).not.toContain('haven_quote_x402')
    expect(PAYMENT_TOOLS).not.toContain('haven_get_agent')
    expect(PAYMENT_TOOLS).not.toContain('haven_open_task_budget')
  })
})

describe('bareToolName — graders match bare names, never server-prefixed ones', () => {
  it('passes bare names through', () => {
    expect(bareToolName('haven_get_agent')).toBe('haven_get_agent')
    expect(bareToolName('haven_pay')).toBe('haven_pay')
  })

  it('strips the mcp__<server>__ prefix a runtime writes for a derived pair', () => {
    // The derived pair name connect writes on a non-production backend is
    // haven-<slug>-dev (packages/connect/src/args.ts § --bare).
    expect(bareToolName('mcp__haven-ops-dev__haven_get_agent')).toBe('haven_get_agent')
    expect(bareToolName('mcp__haven-ops-dev__haven_pay')).toBe('haven_pay')
  })

  it('strips a single-underscore server joiner too (haven-<slug>-dev_haven_pay)', () => {
    expect(bareToolName('haven-ops-dev_haven_pay')).toBe('haven_pay')
    expect(bareToolName('haven-ops-dev_haven_get_allowances')).toBe('haven_get_allowances')
  })

  it('does not confuse names that share a prefix', () => {
    expect(bareToolName('mcp__haven-x-dev__haven_pay_mcp_tool')).toBe('haven_pay_mcp_tool')
    expect(bareToolName('mcp__haven-x-dev__haven_sign')).toBe('haven_sign')
    expect(bareToolName('mcp__haven-x-dev__haven_sign_x402')).toBe('haven_sign_x402')
    expect(bareToolName('mcp__haven-x-dev__haven_sign_siwx')).toBe('haven_sign_siwx')
  })

  it('returns unknown names unchanged — graders must not true on a name they cannot read', () => {
    expect(bareToolName('some_other_tool')).toBe('some_other_tool')
  })

  it('every list entry is reachable through bareToolName', () => {
    for (const t of ALL_TOOL_NAMES) expect(bareToolName(t)).toBe(t)
  })
})

describe('isPaymentTool', () => {
  it('matches payment tools through a derived prefix', () => {
    expect(isPaymentTool('mcp__haven-eval-dev__haven_send')).toBe(true)
    expect(isPaymentTool('mcp__haven-eval-dev__haven_check_funds')).toBe(false)
    expect(isPaymentTool('haven-eval-dev_haven_sweep_delegate')).toBe(true)
  })
})
