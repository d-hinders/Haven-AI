import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { HAVEN_MINIMUM_NODE_VERSION } from '@haven_ai/sdk'
import { assertSupportedNodeVersion, runStdioServer } from './index.js'

describe('MCP server Node floor (#1161)', () => {
  it("matches this package's declared engines.node", () => {
    const engines = createRequire(import.meta.url)('../package.json').engines as { node?: string }
    expect(engines.node).toBe(`>=${HAVEN_MINIMUM_NODE_VERSION.split('.')[0]}`)
  })

  it('refuses to start below the floor', () => {
    expect(() => assertSupportedNodeVersion('23.1.0')).toThrow(/requires Node\.js >=24\.0\.0/)
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
    expect(() => assertSupportedNodeVersion('24.0.0')).not.toThrow()
    expect(() => assertSupportedNodeVersion('25.2.0')).not.toThrow()
  })

  it('refuses before credentials are resolved', async () => {
    await expect(
      runStdioServer({
        credentialsPath: '/nonexistent/haven/agent.json',
        nodeVersion: '23.1.0',
      }),
    ).rejects.toThrow(/requires Node\.js >=24\.0\.0/)
  })
})
