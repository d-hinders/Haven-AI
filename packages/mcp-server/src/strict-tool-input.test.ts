/**
 * #2312 — undeclared arguments are REFUSED, not silently stripped.
 *
 * These tests drive the real MCP transport rather than calling handlers
 * directly, and that is the whole point of the file. #2292's own strictness
 * test calls `createToolHandlers(...).haven_report_x402_outcome({...})`
 * directly, which is the only place its guard could pass: over the wire the
 * MCP SDK validates the call against the registered input schema and hands the
 * handler the already-STRIPPED arguments, so a handler-level `.strict()` never
 * sees the undeclared key. A guard that can only pass in the shape its own
 * test uses is the defect class #2307 removed 56 of.
 *
 * So: every assertion here goes client → transport → server → handler, and the
 * negative control below (`haven_get_payment_status`, deliberately permissive)
 * proves the harness can observe a strip as well as a refusal.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { HavenClient } from '@haven_ai/sdk'
import { buildHostedMcpServer } from './server.js'
import {
  createToolHandlers,
  toolSchemas,
  toolInputSchema,
  STRICT_INPUT_TOOLS,
  type HostedToolName,
  type StrictInputToolName,
  type ToolPayload,
} from './tools.js'

/** Minimum valid arguments for each strict tool, plus the undeclared key to smuggle. */
const VALID_ARGS: Record<StrictInputToolName, Record<string, unknown>> = {
  haven_report_x402_outcome: { payment_id: 'pay_x402', outcome: 'rejected', merchant_status: 402 },
  haven_submit: { payment_id: 'pay_1', signature: '0x' + 'ab'.repeat(32) },
  haven_settle_mcp_tool: { payment_id: 'pay_1', signature: '0x' + 'ab'.repeat(32) },
}

/**
 * One undeclared key per tool, each chosen to be a value the tool really does
 * read from the payment's own RECORD — the #2292 shape, not an invented key.
 */
const SMUGGLED_KEY: Record<StrictInputToolName, string> = {
  haven_report_x402_outcome: 'tx_hash',
  haven_submit: 'amount',
  haven_settle_mcp_tool: 'merchant_address',
}

let fetches: string[]

function stubFetch() {
  fetches = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    fetches.push(`${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`)
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Response
  })
}

async function connectedClient() {
  const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
  const server = buildHostedMcpServer(haven)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'strict-input-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** The text an MCP call came back with, whether it threw or returned isError. */
async function callToolText(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content?: { type: string; text?: string }[]
    }
    return { threw: false, text: result.content?.map((c) => c.text ?? '').join('\n') ?? '' }
  } catch (err) {
    return { threw: true, text: err instanceof Error ? err.message : String(err) }
  }
}

beforeEach(stubFetch)
afterEach(() => vi.unstubAllGlobals())

describe('#2312 strict hosted tool input — over the real MCP transport', () => {
  for (const name of Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]) {
    it(`${name} REFUSES "${SMUGGLED_KEY[name]}" and never reaches the handler`, async () => {
      const client = await connectedClient()
      const { text } = await callToolText(client, name, {
        ...VALID_ARGS[name],
        [SMUGGLED_KEY[name]]: 'smuggled',
      })

      // Refused, and the refusal names the key rather than shrugging.
      expect(text).toContain(SMUGGLED_KEY[name])
      expect(text.toLowerCase()).toContain('unrecognized')
      // The load-bearing half: nothing was read and nothing was written. A
      // refusal that still made its Haven calls would be a strip with a
      // grumble, not a refusal.
      expect(fetches).toEqual([])
    })

    it(`${name} still accepts its own declared arguments`, async () => {
      const client = await connectedClient()
      const { text } = await callToolText(client, name, VALID_ARGS[name])
      // Not asserting success — these fixtures answer `{}` to every Haven call,
      // so the tool fails downstream. What matters is that it got PAST
      // validation: it reached the handler and made a Haven request.
      expect(text.toLowerCase()).not.toContain('unrecognized')
      expect(fetches.length).toBeGreaterThan(0)
    })
  }

  it('CONTROL: a deliberately permissive tool still strips, and the handler still runs', async () => {
    // haven_get_payment_status is NOT on the strict list. If this assertion
    // ever flips to a refusal, the strict set was widened without deciding to.
    // haven_complete_mcp_tool is checked here for a sharper reason: it was in
    // batch 1 until the shipped agent skill was found telling agents to pass it
    // an undeclared `payment_required` (#2353). Until that guidance is fixed,
    // strictness on this tool is a 400 for every agent following Haven's own
    // instructions, so its permissiveness is a DECISION and this pins it.
    expect(Object.keys(STRICT_INPUT_TOOLS)).not.toContain('haven_get_payment_status')
    expect(Object.keys(STRICT_INPUT_TOOLS)).not.toContain('haven_complete_mcp_tool')
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_get_payment_status', {
      payment_id: 'pay_1',
      tx_hash: 'smuggled',
    })
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(fetches.length).toBeGreaterThan(0)
  })
})

describe('#2312 strict hosted tool input — the direct-embedder path', () => {
  // `createToolHandlers` is exported from index.ts, so a caller can bypass the
  // MCP server entirely. `parseStrict` is what covers that path.
  for (const name of Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]) {
    it(`${name} refuses "${SMUGGLED_KEY[name]}" when the handler is called directly`, async () => {
      const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
      const handlers = createToolHandlers(haven)
      const payload = (await handlers[name]({
        ...VALID_ARGS[name],
        [SMUGGLED_KEY[name]]: 'smuggled',
      })) as ToolPayload
      expect(payload.success).toBe(false)
      const failure = payload as { success: false; code: string; message: string }
      expect(failure.code).toBe('INVALID_INPUT')
      expect(failure.message).toContain(SMUGGLED_KEY[name])
      // The refusal explains WHY this tool does not take the key, from the one
      // declaration in STRICT_INPUT_TOOLS — not a generic zod message.
      expect(failure.message).toContain(STRICT_INPUT_TOOLS[name])
      expect(fetches).toEqual([])
    })
  }
})

describe('#2312 — strictness does not change what is advertised', () => {
  it('every hosted tool advertises byte-identical JSON Schema strict or loose', () => {
    for (const name of Object.keys(toolSchemas) as HostedToolName[]) {
      const loose = toJsonSchemaCompat(z.object(toolSchemas[name]) as never, { pipeStrategy: 'input' })
      const strict = toJsonSchemaCompat(z.object(toolSchemas[name]).strict() as never, {
        pipeStrategy: 'input',
      })
      expect(JSON.stringify(strict)).toBe(JSON.stringify(loose))
      // ...and what both advertise is already `additionalProperties: false`,
      // which is why the loose behaviour was a mismatch with the contract
      // rather than an honest permissiveness.
      expect((loose as { additionalProperties?: unknown }).additionalProperties).toBe(false)
    }
  })

  it('the schema a strict tool registers is a strict ZodObject, not a raw shape', () => {
    for (const name of Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]) {
      const schema = toolInputSchema(name)
      expect(schema).toBeInstanceOf(z.ZodObject)
      expect((schema as z.ZodObject<z.ZodRawShape>)._def.unknownKeys).toBe('strict')
    }
    // And a permissive tool still hands the SDK the raw shape it always did.
    expect(toolInputSchema('haven_get_payment_status')).toBe(toolSchemas.haven_get_payment_status)
  })
})
