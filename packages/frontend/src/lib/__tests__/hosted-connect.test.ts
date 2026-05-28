import { describe, it, expect } from 'vitest'
import {
  buildHostedConnectSnippet,
  buildDeepLink,
  hasDeepLink,
  DEEP_LINK_LABEL,
  resolveHostedMcpUrl,
  HOSTED_CLIENT_OPTIONS,
} from '@/lib/hosted-connect'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'

const API_KEY = 'sk_agent_TESTKEY_HOSTED_ONLY'
const DELEGATE_KEY = '0xPRIVATEKEY_MUST_NEVER_BE_IN_CONNECT_SNIPPET'

const BASE_INPUT: HandoffInput = {
  agent: {
    id: 'agt_test',
    name: 'Research Agent',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: {
    allowances: [{ tokenSymbol: 'USDC', amount: '25', resetPeriodMin: 1440 }],
  },
  credentials: {
    apiKey: API_KEY,
    delegatePrivateKey: DELEGATE_KEY,
  },
  apiBaseUrl: 'https://havenbackend.example',
  appBaseUrl: 'https://app.haven.example',
}

function credential() {
  return buildAgentCredential(BASE_INPUT).json
}

const TEST_URL = 'https://mcp.haven.example/v1'

// ─────────────────────────────────────────────────────────────────────────────
// resolveHostedMcpUrl
// ─────────────────────────────────────────────────────────────────────────────
describe('resolveHostedMcpUrl', () => {
  it('returns the env override when set', () => {
    expect(resolveHostedMcpUrl('https://custom.example/v1')).toBe('https://custom.example/v1')
  })

  it('strips a trailing slash', () => {
    expect(resolveHostedMcpUrl('https://custom.example/v1/')).toBe('https://custom.example/v1')
  })

  it('falls back to the default URL when no override', () => {
    const url = resolveHostedMcpUrl(null)
    expect(url).toContain('railway.app')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildHostedConnectSnippet — custody invariant
// ─────────────────────────────────────────────────────────────────────────────
describe('buildHostedConnectSnippet — custody invariant', () => {
  it('never includes the delegate private key in any snippet', () => {
    const cred = credential()
    for (const option of HOSTED_CLIENT_OPTIONS) {
      const snippet = buildHostedConnectSnippet(option.id, cred, TEST_URL)
      expect(snippet.code, `${option.id} should not contain the private key`).not.toContain(DELEGATE_KEY)
    }
  })

  it('includes the api_key (identity) in every snippet', () => {
    const cred = credential()
    for (const option of HOSTED_CLIENT_OPTIONS) {
      const snippet = buildHostedConnectSnippet(option.id, cred, TEST_URL)
      expect(snippet.code, `${option.id} should contain the api key`).toContain(API_KEY)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildHostedConnectSnippet — per-client shape
// ─────────────────────────────────────────────────────────────────────────────
describe('buildHostedConnectSnippet — per-client shape', () => {
  it('claude-code produces a bash snippet with claude mcp add', () => {
    const snippet = buildHostedConnectSnippet('claude-code', credential(), TEST_URL)
    expect(snippet.language).toBe('bash')
    expect(snippet.code).toContain('claude mcp add --transport http haven')
    expect(snippet.code).toContain(TEST_URL)
    expect(snippet.code).toContain(`Bearer ${API_KEY}`)
  })

  it('claude-desktop produces a json mcpServers config block', () => {
    const snippet = buildHostedConnectSnippet('claude-desktop', credential(), TEST_URL)
    expect(snippet.language).toBe('json')
    const parsed = JSON.parse(snippet.code) as { mcpServers: { haven: { url: string; headers: { Authorization: string } } } }
    expect(parsed.mcpServers.haven.url).toBe(TEST_URL)
    expect(parsed.mcpServers.haven.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(snippet.code).not.toContain(DELEGATE_KEY)
  })

  it('cursor produces the same json shape as claude-desktop', () => {
    const cursor = buildHostedConnectSnippet('cursor', credential(), TEST_URL)
    const desktop = buildHostedConnectSnippet('claude-desktop', credential(), TEST_URL)
    // Same code shape, different guidance
    expect(JSON.parse(cursor.code)).toEqual(JSON.parse(desktop.code))
    expect(cursor.guidance).not.toBe(desktop.guidance)
  })

  it('other produces a bash snippet with env vars and curl example', () => {
    const snippet = buildHostedConnectSnippet('other', credential(), TEST_URL)
    expect(snippet.language).toBe('bash')
    expect(snippet.code).toContain(`HAVEN_MCP_URL=${TEST_URL}`)
    expect(snippet.code).toContain(`HAVEN_API_KEY=${API_KEY}`)
    expect(snippet.code).toContain('tools/list')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #188: buildDeepLink
// ─────────────────────────────────────────────────────────────────────────────
describe('buildDeepLink — #188', () => {
  it('claude-desktop link uses the claude:// protocol', () => {
    const url = buildDeepLink('claude-desktop', credential(), TEST_URL)
    expect(url).toMatch(/^claude:\/\//)
    expect(url).not.toContain(DELEGATE_KEY)
  })

  it('claude-desktop link encodes the MCP URL and api_key but NOT the delegate key', () => {
    const url = buildDeepLink('claude-desktop', credential(), TEST_URL)
    // Decode the base64 payload to verify content
    const match = url.match(/\?add=([^&]+)/)
    expect(match).not.toBeNull()
    const decoded = atob(decodeURIComponent(match![1]))
    const payload = JSON.parse(decoded) as { url: string; headers: { Authorization: string }; name: string }
    expect(payload.url).toBe(TEST_URL)
    expect(payload.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(JSON.stringify(payload)).not.toContain(DELEGATE_KEY)
  })

  it('cursor link uses the cursor:// protocol', () => {
    const url = buildDeepLink('cursor', credential(), TEST_URL)
    expect(url).toMatch(/^cursor:\/\//)
    expect(url).not.toContain(DELEGATE_KEY)
  })

  it('cursor link encodes url, transport=http, and Bearer header', () => {
    const url = buildDeepLink('cursor', credential(), TEST_URL)
    expect(url).toContain('transport=http')
    expect(url).toContain(encodeURIComponent(TEST_URL))
    // Decode the headers param
    const match = url.match(/headers=([^&]+)/)
    expect(match).not.toBeNull()
    const headers = JSON.parse(atob(decodeURIComponent(match![1]))) as { Authorization: string }
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('neither deep link contains the delegate private key in any form', () => {
    const cred = credential()
    for (const client of ['claude-desktop', 'cursor'] as const) {
      const url = buildDeepLink(client, cred, TEST_URL)
      expect(url, `${client} deep link must not contain the private key`).not.toContain(DELEGATE_KEY)
      // Also check the decoded payload
      expect(atob(decodeURIComponent(url.match(/(?:add|headers)=([^&]+)/)![1]))).not.toContain(DELEGATE_KEY)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// hasDeepLink + DEEP_LINK_LABEL
// ─────────────────────────────────────────────────────────────────────────────
describe('hasDeepLink + DEEP_LINK_LABEL', () => {
  it('returns true for claude-desktop and cursor only', () => {
    expect(hasDeepLink('claude-desktop')).toBe(true)
    expect(hasDeepLink('cursor')).toBe(true)
    expect(hasDeepLink('claude-code')).toBe(false)
    expect(hasDeepLink('other')).toBe(false)
  })

  it('has non-empty labels for deep-link clients', () => {
    expect(DEEP_LINK_LABEL['claude-desktop']).toBeTruthy()
    expect(DEEP_LINK_LABEL['cursor']).toBeTruthy()
  })
})
