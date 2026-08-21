/**
 * #1695 — named server pairs in every config writer. The discriminating claim
 * in each test is SURGICALITY: a writer touches exactly the pair it owns and
 * leaves every sibling Haven pair (bare or named) byte-untouched. That is
 * what removes #1569's clobbering class — a writer that updates by name
 * cannot collide with itself or overwrite a sibling.
 */
import { describe, it, expect } from 'vitest'
import {
  mergeCodexTomlHosted,
  mergeHermesEnv,
  mergeHermesYaml,
  mergeJsonMcpConfig,
} from './config-writers.js'
import { serverNamesFor } from './server-names.js'

const HOSTED_A = { url: 'https://mcp.haven.example/mcp', headers: { Authorization: 'Bearer sk_agent_aaa' } }
const SIGNER_A = { command: '/home/u/.haven/agents/aaaa/bin/haven-signer.mjs', args: [] as string[] }
const HOSTED_B = { url: 'https://mcp.haven.example/mcp', headers: { Authorization: 'Bearer sk_agent_bbb' } }
const SIGNER_B = { command: '/home/u/.haven/agents/bbbb/bin/haven-signer.mjs', args: [] as string[] }

describe('JSON runtimes (Cursor, VS Code, Claude Desktop shapes)', () => {
  it('MUTATION PROOF: three coexisting pairs round-trip with only the targeted pair modified', () => {
    let config = mergeJsonMcpConfig(null, 'mcpServers', HOSTED_A, SIGNER_A) // bare
    config = mergeJsonMcpConfig(config, 'mcpServers', HOSTED_A, SIGNER_A, serverNamesFor('research'))
    config = mergeJsonMcpConfig(config, 'mcpServers', HOSTED_B, SIGNER_B, serverNamesFor('ops'))

    const before = JSON.parse(config).mcpServers
    expect(Object.keys(before)).toEqual([
      'haven', 'haven-signer', 'haven-research', 'haven-signer-research', 'haven-ops', 'haven-signer-ops',
    ])

    // Re-run ONLY the research pair with new credentials.
    const updated = mergeJsonMcpConfig(config, 'mcpServers', HOSTED_B, SIGNER_B, serverNamesFor('research'))
    const after = JSON.parse(updated).mcpServers
    expect(after['haven-research']).toEqual(HOSTED_B)
    expect(after['haven-signer-research']).toEqual(SIGNER_B)
    // Bare pair and the ops pair byte-untouched.
    expect(after.haven).toEqual(before.haven)
    expect(after['haven-signer']).toEqual(before['haven-signer'])
    expect(after['haven-ops']).toEqual(before['haven-ops'])
    expect(after['haven-signer-ops']).toEqual(before['haven-signer-ops'])
  })

  it('a named write into an unnamed config leaves the bare pair alone', () => {
    const bare = mergeJsonMcpConfig(null, 'mcpServers', HOSTED_A, SIGNER_A)
    const withNamed = mergeJsonMcpConfig(bare, 'mcpServers', HOSTED_B, SIGNER_B, serverNamesFor('ops'))
    const servers = JSON.parse(withNamed).mcpServers
    expect(servers.haven).toEqual(HOSTED_A)
    expect(servers['haven-signer']).toEqual(SIGNER_A)
    expect(servers['haven-ops']).toEqual(HOSTED_B)
  })
})

describe('Codex TOML', () => {
  it('MUTATION PROOF: a named re-run removes-then-adds only its own tables; bare pair, sibling pair, and user config survive', () => {
    const userConfig = '# my comment\nmodel = "gpt-5"\n\n[mcp_servers.other]\nurl = "https://x"\n'
    let toml = mergeCodexTomlHosted(userConfig, 'https://mcp.haven.example/mcp', 'sk_agent_aaa', SIGNER_A)
    toml = mergeCodexTomlHosted(toml, 'https://mcp.haven.example/mcp', 'sk_agent_bbb', SIGNER_B, serverNamesFor('ops'))

    // Update ONLY the ops pair.
    const updated = mergeCodexTomlHosted(
      toml, 'https://mcp.haven.example/mcp', 'sk_agent_ccc', SIGNER_B, serverNamesFor('ops'),
    )

    expect(updated).toContain('# my comment')
    expect(updated).toContain('model = "gpt-5"')
    expect(updated).toContain('[mcp_servers.other]')
    // The bare pair still carries agent A's identity.
    expect(updated).toContain('[mcp_servers.haven]')
    expect(updated).toContain('[mcp_servers.haven_signer]')
    expect(updated).toContain('Bearer sk_agent_aaa')
    // The ops pair carries the NEW identity, exactly once.
    expect(updated.match(/\[mcp_servers\.haven-ops\]/g)).toHaveLength(1)
    expect(updated.match(/\[mcp_servers\.haven-signer-ops\]/g)).toHaveLength(1)
    expect(updated).toContain('Bearer sk_agent_ccc')
    expect(updated).not.toContain('sk_agent_bbb')
  })

  it("the #1569 class: a bare re-run cannot clobber a named sibling, and vice versa", () => {
    let toml = mergeCodexTomlHosted('', 'https://mcp.haven.example/mcp', 'sk_agent_aaa', SIGNER_A)
    toml = mergeCodexTomlHosted(toml, 'https://mcp.haven.example/mcp', 'sk_agent_bbb', SIGNER_B, serverNamesFor('ops'))
    const bareRerun = mergeCodexTomlHosted(toml, 'https://mcp.haven.example/mcp', 'sk_agent_ddd', SIGNER_A)
    expect(bareRerun).toContain('Bearer sk_agent_bbb') // ops untouched
    expect(bareRerun).toContain('Bearer sk_agent_ddd')
    expect(bareRerun).not.toContain('sk_agent_aaa')
  })
})

describe('Hermes YAML + env', () => {
  it('MUTATION PROOF: named pair coexists with the bare pair; only the targeted pair moves on re-run', () => {
    const hostedBare = { ...HOSTED_A, headers: { Authorization: 'Bearer ${MCP_HAVEN_API_KEY}' }, enabled: true }
    const hostedOps = { ...HOSTED_B, headers: { Authorization: 'Bearer ${MCP_HAVEN_OPS_API_KEY}' }, enabled: true }
    let yaml = mergeHermesYaml(null, hostedBare, { ...SIGNER_A, enabled: true })
    yaml = mergeHermesYaml(yaml, hostedOps, { ...SIGNER_B, enabled: true }, serverNamesFor('ops'))

    expect(yaml).toContain('haven:')
    expect(yaml).toContain('haven-signer:')
    expect(yaml).toContain('haven-ops:')
    expect(yaml).toContain('haven-signer-ops:')

    const updated = mergeHermesYaml(
      yaml, hostedOps, { command: '/new/wrapper.mjs', args: [], enabled: true }, serverNamesFor('ops'),
    )
    expect(updated).toContain('/new/wrapper.mjs')
    expect(updated).toContain(SIGNER_A.command) // bare signer untouched
    expect(updated.match(/haven-ops:/g)).toHaveLength(1)
  })

  it('each pair owns its own env key — a named upsert never touches the bare key', () => {
    let env = mergeHermesEnv(null, 'sk_agent_aaa')
    env = mergeHermesEnv(env, 'sk_agent_bbb', serverNamesFor('ops').hermesEnvKey)
    expect(env).toBe('MCP_HAVEN_API_KEY=sk_agent_aaa\nMCP_HAVEN_OPS_API_KEY=sk_agent_bbb\n')

    // Re-key ONLY ops.
    const updated = mergeHermesEnv(env, 'sk_agent_ccc', serverNamesFor('ops').hermesEnvKey)
    expect(updated).toBe('MCP_HAVEN_API_KEY=sk_agent_aaa\nMCP_HAVEN_OPS_API_KEY=sk_agent_ccc\n')

    // And re-keying the bare pair leaves ops alone (prefix keys must not
    // false-match: MCP_HAVEN_API_KEY vs MCP_HAVEN_OPS_API_KEY).
    const bareUpdated = mergeHermesEnv(updated, 'sk_agent_ddd')
    expect(bareUpdated).toBe('MCP_HAVEN_API_KEY=sk_agent_ddd\nMCP_HAVEN_OPS_API_KEY=sk_agent_ccc\n')
  })
})
