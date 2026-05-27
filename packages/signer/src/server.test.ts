import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { verifySignature } from '@haven_ai/sdk'
import { createEdgeSigner } from './core.js'
import { buildSignerMcpServer, resolveEdgeSigner } from './server.js'
import { createToolHandlers, type ToolSuccess, type ToolPayload } from './tools.js'

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const HASH = '0x' + 'cd'.repeat(32)

function ok<T = unknown>(payload: ToolPayload): ToolSuccess<T> {
  if (!payload.success) throw new Error(`expected success, got failure: ${payload.message}`)
  return payload as ToolSuccess<T>
}

describe('resolveEdgeSigner', () => {
  it('builds a signer from an explicit delegate key', async () => {
    const signer = await resolveEdgeSigner({ delegateKey: TEST_KEY })
    expect(signer.delegateAddress).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })
})

describe('buildSignerMcpServer', () => {
  it('lists only the sign tools', async () => {
    const server = buildSignerMcpServer(createEdgeSigner(TEST_KEY))
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['haven_sign', 'haven_x402_sign_header'])

    await client.close()
    await server.close()
  })
})

describe('haven_sign tool', () => {
  it('returns a signature that recovers to the delegate, and emits no key', async () => {
    const signer = createEdgeSigner(TEST_KEY)
    const handlers = createToolHandlers(signer)

    const result = ok<{ signature: string }>(await handlers.haven_sign({ payload_hash: HASH }))

    expect(verifySignature(HASH, result.data.signature, signer.delegateAddress)).toBe(true)
    // Custody: the output is only the signature — never the key.
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
    expect(JSON.stringify(result)).not.toContain(TEST_KEY.slice(2))
  })

  it('rejects a malformed payload_hash without throwing', async () => {
    const handlers = createToolHandlers(createEdgeSigner(TEST_KEY))
    const payload = await handlers.haven_sign({ payload_hash: 'nope' })
    expect(payload.success).toBe(false)
  })
})
