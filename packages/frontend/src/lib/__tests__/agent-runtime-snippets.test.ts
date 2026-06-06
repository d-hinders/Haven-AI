import { describe, it, expect } from 'vitest'
import { buildAgentCredential } from '@/lib/agent-credential'
import {
  buildRuntimeSnippets,
  buildRuntimeSnippet,
} from '@/lib/agent-runtime-snippets'
import type { HandoffInput } from '@/lib/agent-handoff'

const BASE_INPUT: HandoffInput = {
  agent: {
    id: 'agt_abc123',
    name: 'Research Agent',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: {
    allowances: [{ tokenSymbol: 'USDC', amount: '25', resetPeriodMin: 10080 }],
  },
  credentials: {
    apiKey: 'sk_agent_TESTKEY_NEVERREAL',
    delegatePrivateKey: '0xPRIVATEKEY_NEVERREAL',
  },
  apiBaseUrl: 'https://havenbackend.example',
  appBaseUrl: 'https://app.haven.example',
}

function credential() {
  return buildAgentCredential(BASE_INPUT).json
}

describe('buildRuntimeSnippets — inline mode', () => {
  it('builds one snippet per supported runtime', () => {
    const all = buildRuntimeSnippets({ credential: credential() }, 'inline')
    expect(all.map((s) => s.id).sort()).toEqual([
      'claude-desktop',
      'cursor',
      'generic-mcp',
      'python',
      'sdk-cli',
      'vscode',
      'windsurf',
    ])
  })

  it('Claude Desktop snippet inlines the secret via env vars', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'claude-desktop', 'inline')
    expect(snippet.language).toBe('json')
    const config = JSON.parse(snippet.code)
    expect(config.mcpServers.haven.command).toBe('npx')
    expect(config.mcpServers.haven.args).toEqual(['-y', '@haven_ai/mcp'])
    expect(config.mcpServers.haven.env.HAVEN_API_KEY).toBe('sk_agent_TESTKEY_NEVERREAL')
    expect(config.mcpServers.haven.env.HAVEN_DELEGATE_KEY).toBe('0xPRIVATEKEY_NEVERREAL')
    // No --credentials arg in inline mode.
    expect(snippet.code).not.toContain('--credentials')
  })

  it('Cursor snippet has the same env-var shape as Claude Desktop', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'cursor', 'inline')
    const config = JSON.parse(snippet.code)
    expect(config.mcpServers.haven.env.HAVEN_API_KEY).toBe('sk_agent_TESTKEY_NEVERREAL')
    expect(snippet.destination).toContain('~/.cursor/mcp.json')
  })

  it('Other agents snippet is a bash command with env vars prefixed', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'generic-mcp', 'inline')
    expect(snippet.language).toBe('bash')
    expect(snippet.code).toContain('HAVEN_API_KEY=sk_agent_TESTKEY_NEVERREAL')
    expect(snippet.code).toContain('HAVEN_DELEGATE_KEY=0xPRIVATEKEY_NEVERREAL')
    expect(snippet.code).toContain('npx -y @haven_ai/mcp')
  })

  it('SDK/CLI snippet imports the SDK and references the credential', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'sdk-cli', 'inline')
    expect(snippet.language).toBe('typescript')
    expect(snippet.code).toContain("from '@haven_ai/sdk'")
    expect(snippet.code).toContain('process.env.HAVEN_API_KEY')
    expect(snippet.code).toContain('process.env.HAVEN_DELEGATE_KEY')
  })

  it('Windsurf snippet has the correct destination path', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'windsurf', 'inline')
    expect(snippet.language).toBe('json')
    expect(snippet.destination).toBe('~/.codeium/windsurf/mcp_config.json')
    const config = JSON.parse(snippet.code)
    expect(config.mcpServers.haven.env.HAVEN_API_KEY).toBe('sk_agent_TESTKEY_NEVERREAL')
  })

  it('VS Code snippet uses the servers (not mcpServers) schema and stdio type', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'vscode', 'inline')
    expect(snippet.language).toBe('json')
    const config = JSON.parse(snippet.code)
    expect(config.servers).toBeDefined()
    expect(config.servers.haven.type).toBe('stdio')
    expect(config.servers.haven.env.HAVEN_API_KEY).toBe('sk_agent_TESTKEY_NEVERREAL')
  })

  it('VS Code inline snippet guidance references the correct Command Palette label', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'vscode', 'inline')
    expect(snippet.guidance).toContain('MCP: Open User Configuration')
    expect(snippet.guidance).not.toContain('MCP: Open User Settings')
  })

  it('Python snippet has python language and pip install comment', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'python', 'inline')
    expect(snippet.language).toBe('python')
    expect(snippet.code).toContain('pip install haven-ai-sdk')
    expect(snippet.code).toContain('HavenClient')
    expect(snippet.code).toContain('HAVEN_API_KEY')
  })

  it('env-based SDK examples do not echo raw credential values in comments', () => {
    for (const id of ['sdk-cli', 'python'] as const) {
      const snippet = buildRuntimeSnippet({ credential: credential() }, id, 'inline')
      expect(snippet.code).toContain('HAVEN_API_KEY')
      expect(snippet.code).toContain('HAVEN_DELEGATE_KEY')
      expect(snippet.code).not.toContain('sk_agent_TESTKEY_NEVERREAL')
      expect(snippet.code).not.toContain('0xPRIVATEKEY_NEVERREAL')
    }
  })

  it('MCP-based snippets include a consentNote; non-MCP do not', () => {
    const mcpIds = ['claude-desktop', 'cursor', 'windsurf', 'vscode', 'generic-mcp'] as const
    for (const id of mcpIds) {
      const snippet = buildRuntimeSnippet({ credential: credential() }, id, 'inline')
      expect(snippet.consentNote, `${id} should have a consentNote`).toBeTruthy()
      expect(snippet.consentNote).toContain('--ack')
    }
    const nonMcpIds = ['sdk-cli', 'python'] as const
    for (const id of nonMcpIds) {
      const snippet = buildRuntimeSnippet({ credential: credential() }, id, 'inline')
      expect(snippet.consentNote, `${id} should NOT have a consentNote`).toBeUndefined()
    }
  })
})

describe('buildRuntimeSnippets — file mode', () => {
  const PATH = '/Users/example/secrets/haven-agent.json'

  it('Claude Desktop snippet references the credential file path instead of env', () => {
    const snippet = buildRuntimeSnippet(
      { credential: credential(), credentialFilePath: PATH },
      'claude-desktop',
      'file',
    )
    const config = JSON.parse(snippet.code)
    expect(config.mcpServers.haven.args).toEqual(['-y', '@haven_ai/mcp', '--credentials', PATH])
    expect(config.mcpServers.haven.env).toBeUndefined()
    // Secret is NOT in the snippet in file mode.
    expect(snippet.code).not.toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(snippet.code).not.toContain('0xPRIVATEKEY_NEVERREAL')
  })

  it('Other agents file-mode snippet uses HAVEN_CREDENTIALS', () => {
    const snippet = buildRuntimeSnippet(
      { credential: credential(), credentialFilePath: PATH },
      'generic-mcp',
      'file',
    )
    expect(snippet.code).toContain(`HAVEN_CREDENTIALS=${PATH}`)
    expect(snippet.code).not.toContain('sk_agent_TESTKEY_NEVERREAL')
  })

  it('falls back to a placeholder path when none is provided', () => {
    const snippet = buildRuntimeSnippet({ credential: credential() }, 'claude-desktop', 'file')
    expect(snippet.code).toContain('/absolute/path/to/haven-agent-research-agent.json')
  })

  it('Windsurf file-mode snippet references the credential path via --credentials', () => {
    const snippet = buildRuntimeSnippet(
      { credential: credential(), credentialFilePath: PATH },
      'windsurf',
      'file',
    )
    const config = JSON.parse(snippet.code)
    expect(config.mcpServers.haven.args).toContain('--credentials')
    expect(config.mcpServers.haven.args).toContain(PATH)
    expect(snippet.code).not.toContain('sk_agent_TESTKEY_NEVERREAL')
  })

  it('VS Code file-mode snippet references the credential path via --credentials', () => {
    const snippet = buildRuntimeSnippet(
      { credential: credential(), credentialFilePath: PATH },
      'vscode',
      'file',
    )
    const config = JSON.parse(snippet.code)
    expect(config.servers.haven.args).toContain('--credentials')
    expect(config.servers.haven.args).toContain(PATH)
    expect(snippet.code).not.toContain('sk_agent_TESTKEY_NEVERREAL')
  })

  it('Python file-mode snippet reads the credential file instead of env vars', () => {
    const snippet = buildRuntimeSnippet(
      { credential: credential(), credentialFilePath: PATH },
      'python',
      'file',
    )
    expect(snippet.code).toContain(PATH)
    expect(snippet.code).toContain('json.load')
    expect(snippet.code).not.toContain('sk_agent_TESTKEY_NEVERREAL')
  })

  it('SDK/CLI file-mode snippet reads the credential file without raw secrets', () => {
    const snippet = buildRuntimeSnippet(
      { credential: credential(), credentialFilePath: PATH },
      'sdk-cli',
      'file',
    )
    expect(snippet.code).toContain(PATH)
    expect(snippet.code).toContain('readFile')
    expect(snippet.code).toContain('cred.api_key')
    expect(snippet.code).toContain('cred.delegate_key')
    expect(snippet.code).not.toContain('sk_agent_TESTKEY_NEVERREAL')
    expect(snippet.code).not.toContain('0xPRIVATEKEY_NEVERREAL')
  })
})
