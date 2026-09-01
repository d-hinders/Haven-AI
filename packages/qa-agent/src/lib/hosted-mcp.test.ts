/**
 * The hosted-MCP transport quirks (#1154).
 *
 * These three behaviours are the ones a live run cannot cheaply exercise both
 * halves of — the deployed server picks ONE response encoding per call, so a
 * client that only handles that one looks green until the day it doesn't. Each
 * case here feeds the shape the parser must survive.
 */

import { describe, it, expect } from 'vitest'
import {
  parseStreamableHttpBody,
  unwrapToolPayload,
  HostedMcpToolError,
  HostedMcpTransportError,
} from './hosted-mcp.js'

const toolResponse = (payload: unknown) => ({
  jsonrpc: '2.0',
  id: 1,
  result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
})

describe('parseStreamableHttpBody — both encodings are valid (#1154)', () => {
  it('parses a plain JSON body', () => {
    const parsed = parseStreamableHttpBody(JSON.stringify(toolResponse({ success: true, data: { a: 1 } })))
    expect(parsed.result?.content?.[0]?.text).toContain('"a":1')
  })

  it('parses an SSE body', () => {
    const body = `event: message\ndata: ${JSON.stringify(toolResponse({ success: true, data: { a: 1 } }))}\n\n`
    const parsed = parseStreamableHttpBody(body)
    expect(parsed.result?.content?.[0]?.text).toContain('"a":1')
  })

  it('takes the LAST JSON-RPC message in an SSE stream, not the first', () => {
    // A progress notification ahead of the response is legal. Taking the first
    // data line would return the notification as though it were the result —
    // which reads downstream as "the tool returned nothing".
    const body = [
      `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}`,
      `data: ${JSON.stringify(toolResponse({ success: true, data: { final: true } }))}`,
      '',
    ].join('\n')
    expect(parseStreamableHttpBody(body).result?.content?.[0]?.text).toContain('final')
  })

  it('ignores keep-alive and non-JSON data lines', () => {
    const body = [
      ': keep-alive',
      'data: [DONE]',
      `data: ${JSON.stringify(toolResponse({ success: true, data: {} }))}`,
      '',
    ].join('\n')
    expect(() => parseStreamableHttpBody(body)).not.toThrow()
  })

  it.each([
    ['an empty body', ''],
    ['an SSE stream with no JSON-RPC message', 'event: ping\ndata: [DONE]\n\n'],
    ['unparseable JSON', '{ not json'],
  ])('reports %s as a transport fault', (_name, body) => {
    expect(() => parseStreamableHttpBody(body)).toThrow(HostedMcpTransportError)
  })
})

describe('unwrapToolPayload — the doubled envelope (#1154)', () => {
  it('unwraps content[].text then { success, data }', () => {
    // Gotcha 1 from the manual run: forgetting the `.data` hop yields an object
    // whose every field is undefined, which reads as an empty backend response.
    const data = unwrapToolPayload<{ payment_id: string }>(
      'haven_pay_mcp_tool',
      toolResponse({ success: true, data: { payment_id: 'pay_1' } }),
    )
    expect(data.payment_id).toBe('pay_1')
  })

  it('raises a TOOL error for { success: false }, carrying the code', () => {
    // Distinguishable from a transport fault on purpose: a policy refusal and a
    // broken session mean completely different things when a QA leg goes red.
    try {
      unwrapToolPayload('haven_pay_mcp_tool', toolResponse({ success: false, code: 'OVER_BUDGET', message: 'nope' }))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HostedMcpToolError)
      expect((err as HostedMcpToolError).code).toBe('OVER_BUDGET')
    }
  })

  it('surfaces a JSON-RPC error as a transport fault', () => {
    expect(() =>
      unwrapToolPayload('haven_pay_mcp_tool', { error: { code: -32601, message: 'Method not found' } }),
    ).toThrow(/Method not found/)
  })

  it('reports missing text content rather than returning undefined', () => {
    expect(() => unwrapToolPayload('haven_pay_mcp_tool', { result: { content: [] } })).toThrow(
      HostedMcpTransportError,
    )
  })

  it('raises a TOOL error for a strict-schema refusal, in both arrival shapes (#2312)', () => {
    // The four strict hosted tools are refused by the MCP SDK BEFORE the
    // handler, so there is no Haven `{ success: false }` envelope to read. The
    // real wire text, reproduced verbatim from a live InMemoryTransport call:
    const wireText =
      'MCP error -32602: Input validation error: Invalid arguments for tool haven_submit: [\n' +
      '  {\n    "code": "unrecognized_keys",\n    "keys": [\n      "amount"\n    ]\n  }\n]'

    for (const response of [
      // (a) as an isError text result — what the SDK client surfaces.
      { result: { isError: true, content: [{ type: 'text', text: wireText }] } },
      // (b) as a JSON-RPC error object — what a raw Streamable-HTTP call sees.
      { error: { code: -32602, message: wireText } },
    ]) {
      try {
        unwrapToolPayload('haven_submit', response)
        expect.unreachable('should have thrown')
      } catch (err) {
        // The load-bearing half: a TOOL error, not a transport fault. The
        // scenarios that call these tools catch HostedMcpToolError and fail()
        // cleanly, and RETHROW anything else — so misclassifying an argument
        // name as a broken session is an unhandled throw in a QA leg.
        expect(err).toBeInstanceOf(HostedMcpToolError)
        expect(err).not.toBeInstanceOf(HostedMcpTransportError)
        expect((err as HostedMcpToolError).code).toBe('INVALID_INPUT')
        expect((err as HostedMcpToolError).message).toContain('unrecognized_keys')
      }
    }
  })

  it('CONTROL: an ordinary unparseable body is still a TRANSPORT fault', () => {
    // Without this the test above would pass just as well if every non-JSON
    // body were reclassified as a tool error, which would be the opposite bug.
    try {
      unwrapToolPayload('haven_submit', {
        result: { isError: true, content: [{ type: 'text', text: 'TypeError: undefined is not a function' }] },
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(HostedMcpTransportError)
      expect(err).not.toBeInstanceOf(HostedMcpToolError)
    }
  })

  it('passes an un-enveloped payload through verbatim', () => {
    // Not every hosted tool wraps; inventing a `data` that isn't there would
    // silently blank the result.
    expect(unwrapToolPayload<{ x: number }>('t', toolResponse({ x: 5 })).x).toBe(5)
  })
})
