/**
 * #2807 characterization — the hosted-MCP contract surface, pinned BEFORE the
 * extraction moves it.
 *
 * This file is committed ahead of any structural change and every assertion in
 * it is written against the `./tools.js` FACADE only — the same surface
 * `index.ts`, `server.ts` and embedders see — so the extraction cannot move
 * what these tests observe. If the refactor is behaviour-preserving, this suite
 * passes byte-identically before and after; if a tool name, advertised schema,
 * description, input-policy decision, or direct-handler input behavior drifts,
 * the drift lands here first.
 *
 * The file deliberately does NOT import the new `tools/` modules: the seam's
 * guarantee is that the facade stays true, not that the internals look a
 * particular way.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod/v3'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { HavenClient } from '@haven_ai/sdk'
import {
  createToolHandlers,
  toolDescriptions,
  toolInputSchema,
  toolSchemas,
  STRICT_INPUT_TOOLS,
  PERMISSIVE_INPUT_TOOLS,
  type HostedToolName,
  type StrictInputToolName,
  type PermissiveInputToolName,
} from './tools.js'

/** The 22 hosted tool names, in `HostedToolName` declaration order. */
const HOSTED_TOOL_NAMES: readonly HostedToolName[] = [
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

describe('hosted tool contract surface (#2807 characterization)', () => {
  it('advertises exactly the 22 hosted tool names, each exactly once', () => {
    const schemaKeys = Object.keys(toolSchemas)
    expect(schemaKeys).toHaveLength(22)
    expect(new Set(schemaKeys).size).toBe(22)
    expect([...schemaKeys].sort()).toEqual([...HOSTED_TOOL_NAMES].sort())
  })

  it('gives every hosted tool a non-empty description, and nothing more', () => {
    const descriptionKeys = Object.keys(toolDescriptions)
    expect([...descriptionKeys].sort()).toEqual([...HOSTED_TOOL_NAMES].sort())
    for (const name of HOSTED_TOOL_NAMES) {
      expect(typeof toolDescriptions[name]).toBe('string')
      expect(toolDescriptions[name].length).toBeGreaterThan(0)
    }
  })

  it('puts every hosted tool on exactly one input-policy list', () => {
    const strict = Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]
    const permissive = Object.keys(PERMISSIVE_INPUT_TOOLS) as PermissiveInputToolName[]
    expect([...strict, ...permissive].sort()).toEqual([...HOSTED_TOOL_NAMES].sort())
    for (const name of strict) {
      expect(permissive).not.toContain(name as never)
    }
  })

  it('registers the same JSON Schema shape for every tool as before the seam', () => {
    // The advertised wire schema is derived from the raw shape; strictness is
    // enforcement, not advertisement. Pin both: raw-shape compatibility output
    // is what every tool's `additionalProperties` story hangs off.
    for (const name of HOSTED_TOOL_NAMES) {
      // registerTool accepts a raw shape or a Zod schema; the SDK wraps a raw
      // shape in z.object internally. Normalize before reading the wire schema.
      const asZod = (v: z.ZodRawShape | z.ZodTypeAny): z.ZodTypeAny =>
        typeof (v as { safeParse?: unknown }).safeParse === 'function'
          ? (v as z.ZodTypeAny)
          : z.object(v as z.ZodRawShape)
      const raw = toJsonSchemaCompat(asZod(toolSchemas[name]), {
        pipeStrategy: 'input',
      }) as Record<string, unknown>
      const registered = toJsonSchemaCompat(asZod(toolInputSchema(name)), {
        pipeStrategy: 'input',
      }) as Record<string, unknown>
      // Properties and required are identical either way for every tool.
      expect(registered.properties).toEqual(raw.properties)
      expect(registered.required).toEqual(raw.required)
    }
  })

  it('refuses an undeclared key on strict tools and strips on permissive tools', () => {
    for (const name of HOSTED_TOOL_NAMES) {
      const shapeOrSchema = toolInputSchema(name)
      // What registerTool receives: a raw shape (permissive) or a ZodObject
      // (strict). Normalize the shape exactly the way the MCP SDK does at
      // registration so the probe sees the enforcement callers get.
      const schema =
        typeof (shapeOrSchema as { safeParse?: unknown }).safeParse === 'function'
          ? (shapeOrSchema as z.ZodTypeAny)
          : z.object(shapeOrSchema as z.ZodRawShape)
      const decorated = { __probe_undeclared_key: 'x' } as Record<string, unknown>
      const isStrict = Object.prototype.hasOwnProperty.call(STRICT_INPUT_TOOLS, name)
      const result = schema.safeParse(decorated)
      if (isStrict) {
        // A strict tool's registered schema REFUSES the undeclared key.
        expect(result.success, `${name} must refuse an undeclared key`).toBe(false)
      } else {
        // A permissive tool's registered schema strips it (raw-shape parse).
        expect(result.success, `${name} must accept (strip) a decorated call`).toBe(true)
      }
    }
  })

  it('names the offending tool when a strict tool refuses via the direct path', async () => {
    // Direct-embedder path: createToolHandlers called like index.ts exports it.
    // haven_get_payment_status is strict with a single required key, so the
    // refusal is reachable without a live Haven backend.
    const handlers = createToolHandlers(
      new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' }),
    )
    const payload = await handlers.haven_get_payment_status({ tx_hash: '0xdeadbeef' })
    expect(payload.success).toBe(false)
    if (!payload.success) {
      expect(payload.code).toBe('INVALID_INPUT')
      expect(payload.message).toContain('haven_get_payment_status')
      expect(payload.message).toContain('tx_hash')
    }
  })

  it('keeps permissive handlers callable with decorated input on the direct path', async () => {
    const handlers = createToolHandlers(
      new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' }),
    )
    // The handler reads no input; the decorated key must not matter (the call
    // fails at the Haven API layer, NOT with INVALID_INPUT).
    const payload = await handlers.haven_get_agent({ random_string: 'Dummy parameter' })
    expect(payload.success).toBe(false)
    if (!payload.success) {
      expect(payload.code).not.toBe('INVALID_INPUT')
    }
  })

  it('exposes parse-level stripping and parseStrict-level refusal symmetric with registration', async () => {
    // parse-level behavior is reached through the same handlers the SDK calls:
    // a permissive tool strips, a strict tool refuses, and the refusal message
    // is the STRICT_INPUT_TOOLS text so both layers cannot drift.
    const handlers = createToolHandlers(
      new HavenClient({ apiKey: 'test-key', baseUrl: 'http://haven.test' }),
    )
    const strict = await handlers.haven_list_receipts({ cursor: 'page-2' } as never)
    expect(strict.success).toBe(false)
    if (!strict.success) {
      expect(strict.message).toContain('haven_list_receipts does not accept "cursor"')
      expect(strict.message).toBe(
        'haven_list_receipts does not accept "cursor". That is deliberate rather than an ' +
          'omission: ' +
          STRICT_INPUT_TOOLS.haven_list_receipts +
          ' Send only the fields this tool declares.',
      )
    }
  })

  it('advertising and registration stay in 1:1 correspondence through the facade', () => {
    // Every advertised name is registrable and every registrable name is
    // advertised — the invariant `server.ts`'s for-loop depends on.
    const advertised = new Set(Object.keys(toolSchemas))
    for (const name of advertised) {
      expect(toolDescriptions[name as HostedToolName]).toBeTruthy()
      expect(toolInputSchema(name as HostedToolName)).toBeTruthy()
    }
    expect(advertised.size).toBe(22)
  })
})
