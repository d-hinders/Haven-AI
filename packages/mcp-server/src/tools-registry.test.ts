/**
 * #2807 — the runtime twin of the hosted tool registry's compile-time
 * exhaustiveness guards.
 *
 * The compile-time half lives in `tools/contracts.ts` (the `Record`
 * annotations and the input-policy sentinels) and is exercised whenever the
 * package type-checks. vitest does not type-check, so these tests drive
 * `findHostedToolRegistryIssues` / `assertHostedToolRegistry` and prove each
 * failure mode fails AT RUNTIME and NAMES the offending tool — the other half
 * of #2349's "a guard only one instrument can see is half a guard" rule.
 *
 * The completeness test below is deliberately double-anchored:
 *  - its handler map comes from the REAL `createToolHandlers`, and
 *  - its expected name set is pinned in this file, independent of the
 *    contract maps,
 * so removing ANY real registry entry (schema, description, input-policy
 * decision, or handler) turns it red naming the tool. That is the exact
 * mutation the five-mode proof performs against real source. The injectable
 * entries API additionally lets the twin's detection logic be driven against
 * deliberately broken registry inputs without touching shipped files.
 *
 * Known asymmetry, recorded rather than hidden: a duplicate key WITHIN one
 * shipped object literal (TS1117) collapses last-wins at construction, so no
 * runtime reader can observe it. Its twin coverage is compile-time (TS1117
 * fires at the duplicated line) plus the injectable-entries unit test, which
 * proves the twin flags an entries list that names a tool twice. Ownership
 * duplication ACROSS the two input-policy lists — the #2349 double-decision —
 * IS observable at runtime and flagged below.
 */
import { describe, it, expect } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import {
  PERMISSIVE_INPUT_TOOLS,
  STRICT_INPUT_TOOLS,
  toolDescriptions,
  toolSchemas,
  createToolHandlers,
  type HostedToolName,
} from './tools.js'
import {
  assertHostedToolRegistry,
  findHostedToolRegistryIssues,
  findHostedToolRegistryIssuesFor,
  type HostedToolRegistryEntries,
  type HostedToolRegistryInputs,
} from './tools/registry.js'

/**
 * The 22 hosted tool names, pinned HERE independently of `toolSchemas` — so
 * the completeness assertion cannot heal itself when a contract entry is
 * removed (a mutation proof deletes the entry; a list derived from the
 * mutated map would shrink with it and stay green).
 */
const PINNED_TOOL_NAMES: readonly HostedToolName[] = [
  'haven_get_agent',
  'haven_get_allowances',
  'haven_send',
  'haven_pay',
  'haven_submit',
  'haven_pay_mcp_tool',
  'haven_quote_mcp_tool',
  'haven_prepare_catalog_purchase',
  'haven_quote_catalog_purchase',
  'haven_complete_mcp_tool',
  'haven_settle_mcp_tool',
  'haven_quote_x402',
  'haven_pay_x402_quote',
  'haven_resume_x402_payment',
  'haven_report_x402_outcome',
  'haven_get_payment_status',
  'haven_get_resume_state',
  'haven_list_receipts',
  'haven_verify_receipt',
  'haven_sweep_delegate',
  'haven_discover_tools',
  'haven_submit_catalog_entry',
]

/** A complete synthetic registry for the injectable detection-logic tests. */
function fullRegistry(): HostedToolRegistryInputs {
  return {
    schemas: Object.entries(toolSchemas) as HostedToolRegistryEntries,
    descriptions: Object.entries(toolDescriptions) as HostedToolRegistryEntries,
    strictInputTools: Object.entries(STRICT_INPUT_TOOLS) as HostedToolRegistryEntries,
    permissiveInputTools: Object.entries(PERMISSIVE_INPUT_TOOLS) as HostedToolRegistryEntries,
    handlers: PINNED_TOOL_NAMES.map(
      (n) => [n, async () => ({ success: true })] as const,
    ) as HostedToolRegistryEntries,
  }
}

function entriesWithout(entries: HostedToolRegistryEntries, name: HostedToolName) {
  return entries.filter(([n]) => n !== name)
}

function entriesPlus(entries: HostedToolRegistryEntries, name: HostedToolName, value: unknown = 'x') {
  return [...entries, [name, value] as const] as HostedToolRegistryEntries
}

/** Handlers for every pinned name, built WITHOUT reading the contract maps. */
function syntheticHandlersForPinnedNames(): Record<HostedToolName, unknown> {
  return Object.fromEntries(
    PINNED_TOOL_NAMES.map((n) => [n, async () => ({ success: true })]),
  ) as Record<HostedToolName, unknown>
}

describe('hosted tool registry runtime twin (#2807)', () => {
  it('the shipped registry is complete for every pinned hosted tool name', () => {
    // REAL handlers (via the facade) + the injected pinned name list: this is
    // the assertion a registry mutation turns red, naming the tool.
    const handlers = createToolHandlers(
      new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' }),
    )
    expect(findHostedToolRegistryIssuesFor(handlers)).toEqual([])
    expect(Object.keys(handlers).sort()).toEqual([...PINNED_TOOL_NAMES].sort())
  })

  it('finds no issues in the complete synthetic registry', () => {
    expect(findHostedToolRegistryIssues(fullRegistry())).toEqual([])
  })

  it('names the tool when its schema entry is missing', () => {
    const inputs = { ...fullRegistry(), schemas: entriesWithout(fullRegistry().schemas, 'haven_pay') }
    expect(findHostedToolRegistryIssues(inputs)).toEqual([
      { kind: 'missing-schema', tool: 'haven_pay' },
    ])
  })

  it('names the tool when its description entry is missing', () => {
    const inputs = {
      ...fullRegistry(),
      descriptions: entriesWithout(fullRegistry().descriptions, 'haven_pay'),
    }
    expect(findHostedToolRegistryIssues(inputs)).toEqual([
      { kind: 'missing-description', tool: 'haven_pay' },
    ])
  })

  it('names the tool when it carries no input-policy decision', () => {
    const inputs = {
      ...fullRegistry(),
      strictInputTools: entriesWithout(fullRegistry().strictInputTools, 'haven_pay'),
    }
    expect(findHostedToolRegistryIssues(inputs)).toEqual([
      { kind: 'missing-input-policy', tool: 'haven_pay' },
    ])
  })

  it('names the tool when its handler entry is missing', () => {
    const inputs = {
      ...fullRegistry(),
      handlers: entriesWithout(fullRegistry().handlers, 'haven_pay'),
    }
    expect(findHostedToolRegistryIssues(inputs)).toEqual([
      { kind: 'missing-handler', tool: 'haven_pay' },
    ])
  })

  it('names the tool when BOTH input-policy lists claim it (duplicated ownership)', () => {
    const inputs = {
      ...fullRegistry(),
      permissiveInputTools: entriesPlus(
        fullRegistry().permissiveInputTools,
        'haven_pay',
        'decided twice',
      ),
    }
    expect(findHostedToolRegistryIssues(inputs)).toEqual([
      { kind: 'duplicate-ownership', tool: 'haven_pay' },
    ])
  })

  it('names the tool when one ownership map lists it twice (duplicated entries)', () => {
    const inputs = {
      ...fullRegistry(),
      handlers: entriesPlus(fullRegistry().handlers, 'haven_pay', async () => ({ success: true })),
    }
    expect(findHostedToolRegistryIssues(inputs)).toEqual([
      { kind: 'duplicate-ownership', tool: 'haven_pay' },
    ])
  })

  it('assertHostedToolRegistry passes on the shipped registry and names a missing tool', () => {
    const shipped = syntheticHandlersForPinnedNames()
    expect(() => assertHostedToolRegistry(shipped)).not.toThrow()
    const broken: Partial<Record<HostedToolName, unknown>> = { ...shipped }
    delete broken.haven_pay
    expect(() => assertHostedToolRegistry(broken)).toThrow(
      /Hosted MCP tool registry is incomplete:[\s\S]*haven_pay[\s\S]*missing-handler/,
    )
  })

  it('the production view (findHostedToolRegistryIssuesFor) is clean on real maps', () => {
    expect(findHostedToolRegistryIssuesFor(syntheticHandlersForPinnedNames())).toEqual([])
  })
})
