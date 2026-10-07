import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createEdgeSigner } from './core.js'
import { signerInstructions } from './capabilities.js'
import { buildSignerMcpServer } from './server.js'
import type { SignerCredentials } from './credentials.js'

/**
 * #3738: once one harness carries several Haven pairs, the model confirms a
 * signer belongs to the hosted server it called by IDENTITY — the hosted
 * `haven_get_agent` returns `id` and `delegate_address`, and the signer states
 * its own in the `initialize` instructions. These drive the real server build
 * and read what the client receives, not the source text.
 */

const TEST_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DELEGATE = privateKeyToAccount(TEST_KEY).address
const AGENT_ID = '7d4f2a1e-3b6c-4e8a-9f10-2c5d8e6b1a43'

async function instructionsFor(credentials?: SignerCredentials): Promise<string> {
  const server = buildSignerMcpServer(createEdgeSigner(TEST_KEY), { credentials })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const instructions = client.getInstructions() ?? ''
  await client.close()
  await server.close()
  return instructions
}

describe('signer identity in the handshake (#3738)', () => {
  it('states the agent id and delegate address from the credential file', async () => {
    const instructions = await instructionsFor({ delegateKey: TEST_KEY, agentId: AGENT_ID })
    expect(instructions).toContain(
      `This signer is bound to agent id ${AGENT_ID} and delegate address ${DELEGATE}.`,
    )
  })

  it('still states the delegate address on the bare-key path, with no agent id to give', async () => {
    const instructions = await instructionsFor(undefined)
    expect(instructions).toContain(
      `This signer is bound to no recorded agent id (the key was supplied without a credential file) and delegate address ${DELEGATE}.`,
    )
  })

  it('never puts the delegate key on the identity surface', async () => {
    const instructions = await instructionsFor({ delegateKey: TEST_KEY, agentId: AGENT_ID })
    expect(instructions).not.toContain(TEST_KEY.slice(2))
  })

  it('carries the several-pairs rule, inside the first 2,000 characters', async () => {
    // Claude Code truncates server instructions at about 2,048 characters.
    const instructions = await instructionsFor({ delegateKey: TEST_KEY, agentId: AGENT_ID })
    const identity = instructions.indexOf('This signer is bound to')
    const rule = instructions.indexOf('When more than one Haven pair is configured')
    const ruleEnd = instructions.indexOf('switch to the signer whose identity matches.')
    expect(identity).toBeGreaterThan(-1)
    expect(identity).toBeLessThan(rule)
    expect(rule).toBeLessThan(2000)
    expect(ruleEnd).toBeGreaterThan(rule)
    expect(ruleEnd).toBeLessThan(2000)
    expect(instructions).toContain('ask\nbefore any payment tool')
    expect(instructions).toContain(
      'haven-<slug> with haven-signer-<slug>, bare haven with haven-signer, Codex haven with\nhaven_signer',
    )
    expect(instructions).toContain('compare the identity above with haven_get_agent (its id\nand delegate_address)')
  })

  it('omits the identity line when called with no identity (the exported default)', () => {
    expect(signerInstructions()).not.toContain('This signer is bound to')
    expect(signerInstructions()).toContain('When more than one Haven pair is configured')
  })
})
