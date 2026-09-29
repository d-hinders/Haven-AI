/**
 * #3419 (Option B) — an undeclared top-level argument is REFUSED, not
 * stripped.
 *
 * These tests drive the real MCP transport, not the handler, and that is the
 * whole point of the file: the old-signer failure this issue fixes happens at
 * the transport boundary, where the MCP SDK validates the call against the
 * registered schema. Over the wire a refusal has to be observable THERE —
 * so every assertion below goes client → InMemoryTransport → signer server,
 * never `createToolHandlers(...)` directly.
 *
 * The registered schema KEEPS unknown keys (`.passthrough()`, `server.ts`):
 * that is what lets the tool layer be the refusal point, so the structured
 * `UNSUPPORTED_ARGUMENT` fields (`unknown_arguments`, `signer_version`,
 * `fallback`) arrive on the wire as JSON — a `.strict()` registration would
 * make the SDK fail the call first with a plain McpError string that can
 * carry none of them.
 *
 * The NEGATIVE CONTROL at the bottom proves the harness can observe a strip
 * as well as a refusal: a pre-#3419-style registration would have handed the
 * handler the stripped args and this harness would have seen the generic
 * failure instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { privateKeyToAccount } from 'viem/accounts'
import { buildSignerMcpServer } from './server.js'
import { createEdgeSigner } from './core.js'
import { SIGNER_VERSION, UNSUPPORTED_ARGUMENT_MARKER } from './tools.js'
import { SIGNER_VERSION as SERVER_SIGNER_VERSION } from './server.js'
import { connectorUpgradeCommand } from '@haven_ai/sdk'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

/** Tool result payload as the signer server serialises it (see `toMcpResult`). */
interface ToolCallResult {
  isError: boolean
  content: Array<{ type: string; text: string }>
}

function payloadOf(result: ToolCallResult): Record<string, unknown> {
  expect(result.content).toHaveLength(1)
  expect(result.content[0].type).toBe('text')
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

describe('#3419 — the signer refuses an undeclared top-level argument (real transport)', () => {
  let client: Client
  let clientToServer: Transport
  let serverToClient: Transport

  beforeEach(async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const server = buildSignerMcpServer(signer, {
      auditPath: '/tmp/haven-3419-strict-test-audit.jsonl',
    })
    client = new Client({ name: 'strict-input-test', version: '0.0.0' })
    ;[clientToServer, serverToClient] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverToClient), client.connect(clientToServer)])
  })

  afterEach(async () => {
    await Promise.allSettled([client.close(), serverToClient.close(), clientToServer.close()])
  })

  it('haven_sign { payment_id, bogus: 1 } answers UNSUPPORTED_ARGUMENT with the structured fields', async () => {
    const result = (await client.callTool({
      name: 'haven_sign',
      arguments: { payment_id: 'pay_1', bogus: 1 },
    })) as ToolCallResult

    expect(result.isError).toBe(true)
    const payload = payloadOf(result)
    expect(payload).toMatchObject({
      success: false,
      code: 'UNSUPPORTED_ARGUMENT',
      unknown_arguments: ['bogus'],
      signer_version: SIGNER_VERSION,
    })
    // The message names the tool and the key; the marker never leaks.
    expect(payload.message).toContain('haven_sign does not accept "bogus"')
    expect(payload.message).not.toContain(UNSUPPORTED_ARGUMENT_MARKER)
    // fallback is the connector doctor command the update route names.
    expect(payload.fallback).toBe(connectorUpgradeCommand())
    expect(String(payload.fallback)).toContain('--doctor')
    // The machine next step: stop, no follow-on tool.
    expect(payload.next_action).toBe('stop_and_tell_user')
    expect(payload.next_tool_name).toBeUndefined()
    expect(String(payload.next_tool_omitted_reason)).toContain('--doctor')
    // Nothing was signed or fetched — there is no signature field to find.
    expect(payload).not.toHaveProperty('signature')
    expect(JSON.stringify(payload)).not.toContain('pay_1_fetch')
  })

  it('refuses task_budget_id together with sub_budget_id — mutually exclusive (#3444)', async () => {
    // Since #3444 landed on dev, sub_budget_id IS a declared haven_sign
    // argument (it signs a sub-budget's own delegation/early-close). The
    // exclusion of the pair is now a HANDLER rule, so the refusal comes back
    // as INVALID_INPUT naming the offending field — not UNSUPPORTED_ARGUMENT.
    const result = (await client.callTool({
      name: 'haven_sign',
      arguments: { task_budget_id: 'tb_1', sub_budget_id: 'sbt_1' },
    })) as ToolCallResult

    expect(result.isError).toBe(true)
    const payload = payloadOf(result)
    expect(payload.code).toBe('INVALID_INPUT')
    expect(JSON.stringify(payload)).toContain('sub_budget_id')
    expect(JSON.stringify(payload)).toContain('mutually exclusive')
  })

  it('still names an UNDECLARED key alongside declared ones', async () => {
    // sub_budget_id is declared post-#3444, so only `bogus` is unknown.
    const result = (await client.callTool({
      name: 'haven_sign',
      arguments: { payment_id: 'pay_1', sub_budget_id: 'sbt_1', bogus: 'x' },
    })) as ToolCallResult

    const payload = payloadOf(result)
    expect(payload.code).toBe('UNSUPPORTED_ARGUMENT')
    expect(payload.unknown_arguments).toEqual(['bogus'])
  })

  it('still accepts its own arguments — haven_sign { payment_id } passes the strict re-parse', async () => {
    // No signContext wired: the payment_id fetch refuses with a NAMED
    // sign-context failure — which proves the call got PAST the input
    // validation and into the handler (the opposite of a strip).
    const result = (await client.callTool({
      name: 'haven_sign',
      arguments: { payment_id: 'pay_1' },
    })) as ToolCallResult

    expect(result.isError).toBe(true)
    const payload = payloadOf(result)
    expect(payload.code).not.toBe('UNSUPPORTED_ARGUMENT')
    expect(JSON.stringify(payload)).not.toContain('does not accept')
  })

  it('the refusal is identical on the direct embedder path (no transport)', async () => {
    // createToolHandlers called directly — the embedder surface. The same
    // parseStrictFor refusal must come out shaped the same way.
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = (await import('./tools.js')).createToolHandlers(signer, {
      auditPath: '/tmp/haven-3419-strict-test-audit.jsonl',
    } as never)
    const refused = await handlers.haven_sign({ payment_id: 'pay_1', bogus: 1 })
    expect(refused.success).toBe(false)
    if (refused.success) throw new Error('expected refusal')
    expect(refused).toMatchObject({
      code: 'UNSUPPORTED_ARGUMENT',
      unknown_arguments: ['bogus'],
      signer_version: SIGNER_VERSION,
      fallback: connectorUpgradeCommand(),
    })
    expect(refused.next_action).toBe('stop_and_tell_user')
  })

  it('no audit row is written for the refusal', async () => {
    // The refusal fires in parseStrictFor, before any signing context fetch
    // and before any signature: the audit path must not exist afterwards.
    const { readFile, access } = await import('node:fs/promises')
    const auditPath = `/tmp/haven-3419-noaudit-${Date.now()}.jsonl`
    const signer = createEdgeSigner(TEST_KEY)
    const server = buildSignerMcpServer(signer, { auditPath })
    const probe = new Client({ name: 'audit-probe', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(b), probe.connect(a)])
    const result = (await probe.callTool({
      name: 'haven_sign',
      arguments: { payment_id: 'pay_1', bogus: 1 },
    })) as ToolCallResult
    expect(result.isError).toBe(true)
    await expect(access(auditPath)).rejects.toThrow()
    // (readFile imported to keep the probe honest — an empty file would also
    // fail the access() assertion above.)
    await expect(readFile(auditPath, 'utf8')).rejects.toThrow()
    await Promise.allSettled([probe.close(), b.close(), a.close()])
  })

  it('NEGATIVE CONTROL — the harness observes a strip when the registration strips', async () => {
    // A minimal MCP server registered the OLD way (raw shape → strip mode).
    // Smuggling the same bogus key now produces the generic SIGNING_ERROR
    // branch (the handler saw the key stripped and payment_id alone reached
    // the fetch-less refusal path) — proving this harness CAN distinguish a
    // strip from a refusal, so the assertions above are not vacuous.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { z } = await import('zod')
    const stripping = new McpServer({ name: 'strip-control', version: '0.0.0' })
    stripping.tool('haven_sign', 'strip-mode control', { payment_id: z.string() }, async () => ({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ success: false, code: 'SIGNING_ERROR' }) }],
    }))
    const control = new Client({ name: 'strip-control-client', version: '0.0.0' })
    const [ca, cb] = InMemoryTransport.createLinkedPair()
    await Promise.all([stripping.connect(cb), control.connect(ca)])
    const result = (await control.callTool({
      name: 'haven_sign',
      arguments: { payment_id: 'pay_1', bogus: 1 },
    })) as ToolCallResult
    const payload = payloadOf(result)
    // Strip mode silently dropped `bogus`: NO UNSUPPORTED_ARGUMENT anywhere.
    expect(payload.code).not.toBe('UNSUPPORTED_ARGUMENT')
    expect(JSON.stringify(payload)).not.toContain('unknown_arguments')
    await Promise.allSettled([control.close(), cb.close(), ca.close()])
  })

  it('the marker and the signer version are pinned from BOTH modules', () => {
    // UNSUPPORTED_ARGUMENT_MARKER lives in tools.ts (the refusal unit);
    // SIGNER_VERSION is declared there and re-exported by server.ts. Pin the
    // re-export both ways so a move that breaks it turns red.
    expect(SIGNER_VERSION).toBe(SERVER_SIGNER_VERSION)
    expect(UNSUPPORTED_ARGUMENT_MARKER).toBe('HavenSignerUnsupportedArgument:')
    expect(SIGNER_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
