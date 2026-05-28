import { describe, expect, it } from 'vitest'
import {
  buildHostedConnectSnippet,
  HOSTED_CLIENT_OPTIONS,
  resolveHostedMcpUrl,
  type HostedClientId,
} from '@/lib/hosted-connect'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'

const API_KEY = 'sk_agent_TESTKEY_UNIT'
const DELEGATE_KEY = '0xPRIVATEKEY_NEVERREAL_FOR_UNIT'

const INPUT: HandoffInput = {
  agent: {
    id: 'agt_test',
    name: 'A',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: { allowances: [] },
  credentials: { apiKey: API_KEY, delegatePrivateKey: DELEGATE_KEY },
}

function credential() {
  return buildAgentCredential(INPUT).json
}

describe('resolveHostedMcpUrl', () => {
  it('honours an explicit override', () => {
    expect(resolveHostedMcpUrl('https://override.test/v2/')).toBe('https://override.test/v2')
  })

  it('falls back to the production default when no override is given', () => {
    // Don't poke process.env (mutating it leaks across tests); pass undefined.
    expect(resolveHostedMcpUrl(undefined as unknown as string)).toMatch(/^https:\/\/.+/)
  })
})

describe('buildHostedConnectSnippet', () => {
  const HOST = 'https://mcp.test.example/v1'

  for (const client of HOSTED_CLIENT_OPTIONS.map((o) => o.id) as HostedClientId[]) {
    it(`includes the api key and URL but never the delegate key for ${client}`, () => {
      const snippet = buildHostedConnectSnippet(client, credential(), HOST)
      expect(snippet.code).toContain(API_KEY)
      expect(snippet.code).toContain(HOST)
      // Custody invariant at the snippet boundary: the delegate key never
      // appears in the box-1 connect command.
      expect(snippet.code).not.toContain(DELEGATE_KEY)
    })
  }

  it('emits a `claude mcp add` shell command for Claude Code', () => {
    const s = buildHostedConnectSnippet('claude-code', credential(), HOST)
    expect(s.language).toBe('bash')
    expect(s.code).toMatch(/claude mcp add --transport http haven/)
    expect(s.code).toContain(`Bearer ${API_KEY}`)
  })

  it('emits the JSON MCP-config block for Claude Desktop and Cursor', () => {
    for (const c of ['claude-desktop', 'cursor'] as HostedClientId[]) {
      const s = buildHostedConnectSnippet(c, credential(), HOST)
      expect(s.language).toBe('json')
      const parsed = JSON.parse(s.code) as {
        mcpServers: { haven: { url: string; headers: Record<string, string> } }
      }
      expect(parsed.mcpServers.haven.url).toBe(HOST)
      expect(parsed.mcpServers.haven.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    }
  })
})
