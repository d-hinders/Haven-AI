import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { HAVEN_MINIMUM_NODE_VERSION } from '@haven_ai/sdk'
import {
  assertSupportedNodeVersion,
  createHavenClient,
  createHavenMcpServer,
  resolveHavenClient,
  runStdioServer,
} from './index.js'

describe('MCP server Node floor (#1161)', () => {
  it("matches this package's declared engines.node", () => {
    const engines = createRequire(import.meta.url)('../package.json').engines as { node?: string }
    expect(engines.node).toBe(`>=${HAVEN_MINIMUM_NODE_VERSION.split('.')[0]}`)
  })

  it('refuses to start below the floor', () => {
    expect(() => assertSupportedNodeVersion('21.1.0')).toThrow(/requires Node\.js >=22\.0\.0/)
    expect(() => assertSupportedNodeVersion('20.0.0')).toThrow(/The Haven MCP server/)
  })

  it('carries a machine-readable code', () => {
    let code: string | undefined
    try {
      assertSupportedNodeVersion('20.0.0')
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code
    }
    expect(code).toBe('HAVEN_MCP_UNSUPPORTED_NODE')
  })

  it('allows the floor and above', () => {
    expect(() => assertSupportedNodeVersion('22.0.0')).not.toThrow()
    expect(() => assertSupportedNodeVersion('25.2.0')).not.toThrow()
  })

  it('refuses before credentials are resolved', async () => {
    await expect(
      runStdioServer({
        credentialsPath: '/nonexistent/haven/agent.json',
        nodeVersion: '21.1.0',
      }),
    ).rejects.toThrow(/requires Node\.js >=22\.0\.0/)
  })

  // The client built by these is delegate-key-bound — pay(), sign() and the
  // x402 paths activate the moment delegateKey is set — so guarding only the
  // stdio entrypoint would leave the embedding constructors handing back a
  // signing-capable client on an unsupported runtime.
  describe('every key-bound entry point is guarded, not just the stdio server', () => {
    const CREDENTIALS = {
      apiKey: 'sk_agent_test',
      delegateKey: '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38',
      apiUrl: 'https://api.haven.example',
    }

    it('refuses in resolveHavenClient', async () => {
      await expect(
        resolveHavenClient({ credentials: CREDENTIALS, nodeVersion: '21.1.0' }),
      ).rejects.toThrow(/requires Node\.js >=22\.0\.0/)
    })

    it('refuses in createHavenClient', async () => {
      await expect(
        createHavenClient({ credentials: CREDENTIALS, nodeVersion: '21.1.0' }),
      ).rejects.toThrow(/requires Node\.js >=22\.0\.0/)
    })

    it('refuses in createHavenMcpServer', async () => {
      await expect(
        createHavenMcpServer({ credentials: CREDENTIALS, nodeVersion: '21.1.0' }),
      ).rejects.toThrow(/requires Node\.js >=22\.0\.0/)
    })

    it('still builds a client on a supported Node', async () => {
      const { client } = await resolveHavenClient({ credentials: CREDENTIALS, nodeVersion: '22.0.0' })
      expect(client).toBeDefined()
    })
  })
})
