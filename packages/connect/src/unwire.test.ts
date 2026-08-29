/**
 * --unwire (#2169): removal primitives and the end-to-end unwireAgent flow.
 *
 * The removal functions are the exact inverse of the merge* writers and are
 * held to the same hygiene bar: unrelated lines survive byte-identical, an
 * ambiguous managed key refuses instead of rewriting, and an UNNAMED pair is
 * only touched when this directory's own wrapper (or API key) is the one the
 * config/environment actually launches.
 *
 * CRITICAL: these suites touch Hermes paths, and the Hermes config path
 * resolution honours process.env.HERMES_HOME. A developer running the suite
 * from inside a Hermes gateway shell (where HERMES_HOME is exported) would
 * otherwise write into the REAL Hermes home instead of the fixture — so every
 * test clears the variable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UnreadableRuntimeConfigError,
  mergeHermesEnv,
  mergeHermesYaml,
  removeCodexToml,
  removeHermesEnv,
  removeHermesYaml,
  removeJsonMcpConfig,
} from './config-writers.js'
import { serverNamesFor } from './server-names.js'
import { unwireAgent } from './unwire.js'
import { runDoctor, type DoctorDeps } from './doctor.js'
import { acknowledgeLocalSignerConsent } from './signer-consent.js'

const HOSTED_URL = 'https://mcp.haven.example/mcp'
const BARE = serverNamesFor()
const RESEARCH = serverNamesFor('research')

let savedHermesHome: string | undefined

beforeEach(() => {
  savedHermesHome = process.env.HERMES_HOME
  delete process.env.HERMES_HOME
})

afterEach(() => {
  if (savedHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = savedHermesHome
})

async function seedAgent(
  homeDir: string,
  input: { agentId: string; slug?: string; apiKey: string; hostedUrl: string; wrapperPath: string },
): Promise<string> {
  const dir = join(homeDir, '.haven', 'agents', input.slug ?? input.agentId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'identity.json'), JSON.stringify({
    api_key: input.apiKey,
    agent_id: input.agentId,
    hosted_mcp_url: input.hostedUrl,
  }))
  await writeFile(join(dir, 'signer.json'), JSON.stringify({
    version: 1,
    delegate_key: '0x' + '11'.repeat(32),
    delegate_address: '0x' + 'cd'.repeat(20),
    agent_id: input.agentId,
    safe_address: '0x' + 'ab'.repeat(20),
    chain_id: 84532,
    network: 'eip155:84532',
  }), { mode: 0o600 })
  await acknowledgeLocalSignerConsent(join(dir, 'signer.json'))
  await writeFile(join(dir, 'signer-runtime.json'), JSON.stringify({
    ...(input.slug ? { server_name: input.slug } : {}),
    wrapper_path: input.wrapperPath,
  }))
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(join(dir, 'bin', 'haven-signer.mjs'), '// wrapper\n')
  return dir
}

/** Write a Hermes config + env under a fixture home with one merged pair. */
async function seedHermes(
  homeDir: string,
  hostedUrl: string,
  apiKey: string,
  wrapperPath: string,
  names = BARE,
  base = 'model: hermes-4\nagent:\n  max_turns: 8\n',
  envExtra = 'OTHER_MCP_TOKEN=keep-me\n',
): Promise<{ configPath: string; envPath: string }> {
  const dir = join(homeDir, '.hermes')
  await mkdir(dir, { recursive: true })
  const configPath = join(dir, 'config.yaml')
  const envPath = join(dir, '.env')
  const config = mergeHermesYaml(
    base,
    { url: hostedUrl, headers: { Authorization: `Bearer $MCP_KEY` } },
    { command: wrapperPath, args: [] },
    names,
    configPath,
  )
  const env = mergeHermesEnv(envExtra, apiKey, names.hermesEnvKey)
  await writeFile(configPath, config)
  await writeFile(envPath, env)
  return { configPath, envPath }
}

describe('removeHermesYaml (#2169)', () => {
  it('removes the pair, leaving unrelated servers and top-level keys byte-identical', () => {
    const base = 'model: hermes-4\nother_server:\n  ok: true\n'
    const withPair =
      base + 'mcp_servers:\n  haven:\n    url: https://x\n  haven-signer:\n    command: /w\n  keepme:\n    command: npx\n'
    const out = removeHermesYaml(withPair, BARE)
    expect(out).not.toContain('haven')
    expect(out).toContain('keepme')
    expect(out).toContain(base)
    expect(out).toContain('mcp_servers:')
  })

  it('drops the whole mcp_servers key when nothing else is inside', () => {
    const input = 'model: hermes-4\nmcp_servers:\n  haven:\n    url: https://x\n  haven-signer:\n    command: /w\n'
    expect(removeHermesYaml(input, BARE)).toBe('model: hermes-4\n')
  })

  it('returns the input unchanged when the pair is absent', () => {
    const input = 'model: hermes-4\nmcp_servers:\n  other:\n    command: npx\n'
    expect(removeHermesYaml(input, BARE)).toBe(input)
  })

  it('refuses (unreadable) instead of rewriting a malformed config', () => {
    expect(() => removeHermesYaml('mcp_servers: [Bearer «redacted:sk_…»\n', BARE)).toThrow(UnreadableRuntimeConfigError)
  })
})

describe('removeHermesEnv (#2169)', () => {
  it('removes only the managed key, preserving other lines and the trailing newline', () => {
    const input = 'OTHER_MCP_TOKEN=keep-me\nMCP_HAVEN_API_KEY=sk_test_1\nANOTHER=2\n'
    expect(removeHermesEnv(input, 'MCP_HAVEN_API_KEY')).toBe('OTHER_MCP_TOKEN=keep-me\nANOTHER=2\n')
  })

  it('preserves CRLF line endings byte-for-byte', () => {
    const input = 'OTHER_MCP_TOKEN=keep-me\r\nMCP_HAVEN_API_KEY=sk_test_1\r\n'
    expect(removeHermesEnv(input, 'MCP_HAVEN_API_KEY')).toBe('OTHER_MCP_TOKEN=keep-me\r\n')
  })

  it('returns the input unchanged when the key is absent', () => {
    expect(removeHermesEnv('OTHER_MCP_TOKEN=keep-me\n', 'MCP_HAVEN_API_KEY')).toBe('OTHER_MCP_TOKEN=keep-me\n')
  })

  it('refuses an ambiguous managed line rather than rewriting it', () => {
    expect(() => removeHermesEnv('MCP_HAVEN_API_KEY # do not parse this\n', 'MCP_HAVEN_API_KEY')).toThrow(
      'ambiguous managed key',
    )
  })
})

describe('removeJsonMcpConfig / removeCodexToml (#2169)', () => {
  it('removes the owned pair from a JSON MCP config and keeps unrelated servers', () => {
    const input = JSON.stringify({ mcpServers: { haven: { url: 'x' }, 'haven-signer': { command: 'npx' }, keepme: { command: 'v' } } })
    const out = removeJsonMcpConfig(input, 'mcpServers', BARE)
    expect(out).not.toContain('haven')
    expect(JSON.parse(out).mcpServers.keepme).toEqual({ command: 'v' })
  })

  it('drops the empty serverRoot when the pair was the only content', () => {
    const input = JSON.stringify({ mcpServers: { haven: { url: 'x' }, 'haven-signer': { command: 'npx' } } })
    const out = removeJsonMcpConfig(input, 'mcpServers', BARE)
    expect(JSON.parse(out)).not.toHaveProperty('mcpServers')
  })

  it('returns a JSON config unchanged when the pair is absent', () => {
    const input = JSON.stringify({ mcpServers: { other: { command: 'npx' } } })
    expect(removeJsonMcpConfig(input, 'mcpServers', BARE)).toBe(input)
  })

  it('removes the Codex TOML tables and keeps unrelated tables', () => {
    const input = '[mcp_servers.haven]\nurl = "x"\n[mcp_servers.haven_signer]\ncommand = "/w"\n[mcp_servers.keepme]\ncommand = "v"\n'
    const out = removeCodexToml(input, BARE)
    expect(out).not.toContain('haven')
    expect(out).toContain('keepme')
  })
})

describe('unwireAgent end-to-end (#2169)', () => {
  it('named agent: tombstone-first, removes YAML pair + env key, unrelated content byte-identical, mirror written', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-named-'))
    const tombstonesDir = join(homeDir, '.haven', 'tombstones')
    const wrapper = join(homeDir, '.haven', 'agents', 'research', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, {
      agentId: 'agent-research', slug: 'research', apiKey: 'sk_research', hostedUrl: HOSTED_URL, wrapperPath: wrapper,
    })
    const envExtra = 'OTHER_MCP_TOKEN=keep-me\n'
    const { configPath, envPath } = await seedHermes(
      homeDir, HOSTED_URL, 'sk_research', wrapper, RESEARCH, 'model: hermes-4\nagent:\n  max_turns: 8\n', envExtra,
    )
    expect(await readFile(configPath, 'utf8')).toContain('haven-research')

    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir })

    expect(result.tombstoned).toBe(true)
    expect(result.slug).toBe('research')
    expect(result.runtimes.some((r) => r.runtime === 'hermes' && r.status === 'removed')).toBe(true)

    const configAfter = await readFile(configPath, 'utf8')
    expect(configAfter).not.toContain('haven-research')
    expect(configAfter).toContain('model: hermes-4')
    expect(configAfter).toContain('max_turns: 8')

    const envAfter = await readFile(envPath, 'utf8')
    expect(envAfter).not.toContain('MCP_HAVEN_RESEARCH_API_KEY')
    expect(envAfter).toContain('OTHER_MCP_TOKEN=keep-me')

    // Tombstone-first artefacts: in-place + mirrored record outside the dir.
    expect(await readFile(join(dir, 'TOMBSTONE.json'), 'utf8')).toContain('agent-research')
    expect(await readFile(join(tombstonesDir, 'agent-research.json'), 'utf8')).toContain('agent-research')

    // Full local teardown of the TARGET's key material — the doctor's
    // mutation-proof rule (a tombstone never excuses a live key) is what makes
    // `retired` honest. Nothing is revoked on the backend here.
    await expect(readFile(join(dir, 'signer.json'), 'utf8')).rejects.toThrow()
    const identityAfter = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8'))
    expect(identityAfter).not.toHaveProperty('api_key')
    expect(identityAfter.agent_id).toBe('agent-research')
    // The tombstoned wrapper stays in place for stale hosts to hit.
    expect(await readFile(join(dir, 'bin', 'haven-signer.mjs'), 'utf8')).toContain('HAVEN-TOMBSTONE')
  })

  it('two UNNAMED agents: refuses to unwire the pair owned by the other, leaves config + env untouched', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-two-unnamed-'))
    const tombstonesDir = join(homeDir, '.haven', 'tombstones')
    const wrapperA = join(homeDir, '.haven', 'agents', 'agent-a', 'bin', 'haven-signer.mjs')
    const wrapperB = join(homeDir, '.haven', 'agents', 'agent-b', 'bin', 'haven-signer.mjs')
    const dirA = await seedAgent(homeDir, { agentId: 'agent-a', apiKey: 'sk_a', hostedUrl: HOSTED_URL, wrapperPath: wrapperA })
    const dirB = await seedAgent(homeDir, { agentId: 'agent-b', apiKey: 'sk_b', hostedUrl: HOSTED_URL, wrapperPath: wrapperB })
    // Only A is wired: the config launches A's wrapper and the env holds A's key.
    const envExtra = 'OTHER_MCP_TOKEN=keep-me\n'
    await seedHermes(homeDir, HOSTED_URL, 'sk_a', wrapperA, BARE, 'model: hermes-4\n', envExtra)
    const configBefore = await readFile(join(homeDir, '.hermes', 'config.yaml'), 'utf8')
    const envBefore = await readFile(join(homeDir, '.hermes', '.env'), 'utf8')

    const result = await unwireAgent({ directory: dirB, homeDir, tombstonesDir })

    // B is tombstoned (retiring it is still an operator decision for B), but
    // the config and env it does NOT own are refused — and therefore untouched.
    expect(result.tombstoned).toBe(true)
    const refused = result.runtimes.filter((r) => r.status === 'refused')
    expect(refused.length).toBeGreaterThan(0)
    expect(await readFile(join(homeDir, '.hermes', 'config.yaml'), 'utf8')).toBe(configBefore)
    expect(await readFile(join(homeDir, '.hermes', '.env'), 'utf8')).toBe(envBefore)

    // Now unwire A (the owner): its pair + env key come out cleanly.
    const resultA = await unwireAgent({ directory: dirA, homeDir, tombstonesDir })
    expect(resultA.runtimes.filter((r) => r.status === 'refused')).toEqual([])
    expect(await readFile(join(homeDir, '.hermes', 'config.yaml'), 'utf8')).not.toContain('haven:')
    expect(await readFile(join(homeDir, '.hermes', '.env'), 'utf8')).not.toContain('MCP_HAVEN_API_KEY')
    expect(resultA.tombstoned).toBe(true)
  })

  it('owner unwire: --doctor afterwards reports the directory as retired, not superseded', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-retired-'))
    const tombstonesDir = join(homeDir, '.haven', 'tombstones')
    const wrapper = join(homeDir, '.haven', 'agents', 'agent-1', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-1', apiKey: 'sk_1', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    await seedHermes(homeDir, HOSTED_URL, 'sk_1', wrapper, BARE)

    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir })
    expect(result.runtimes.filter((r) => r.status === 'refused')).toEqual([])

    const deps: DoctorDeps & {
      probeSignerTools: ReturnType<typeof vi.fn>
      probeHosted: ReturnType<typeof vi.fn>
      probeHostedIdentity: ReturnType<typeof vi.fn>
    } = {
      probeHosted: vi.fn(async () => ({ status: 'ok' as const })),
      probeHostedIdentity: vi.fn(async () => ({
        status: 'ok' as const, agentId: 'agent-1', delegateAddress: '0x' + 'cd'.repeat(20),
      })),
      probeSignerTools: vi.fn(async () => ({
        status: 'ok' as const,
        toolNames: [],
        serverInfo: { name: 'haven-signer', version: '0.0.0' },
        capabilities: {},
      })),
    }
    const report = await runDoctor({ runtime: 'hermes' }, { homeDir, ...deps })
    const entry = report.agents.find((a) => a.directory === dir)
    expect(entry?.classification).toBe('retired')
  })

  it('is idempotent: a second run does not double-write the tombstone', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-idem-'))
    const tombstonesDir = join(homeDir, '.haven', 'tombstones')
    const wrapper = join(homeDir, '.haven', 'agents', 'agent-1', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-1', apiKey: 'sk_1', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    await seedHermes(homeDir, HOSTED_URL, 'sk_1', wrapper, BARE)

    const first = await unwireAgent({ directory: dir, homeDir, tombstonesDir })
    const second = await unwireAgent({ directory: dir, homeDir, tombstonesDir })
    expect(first.tombstoned).toBe(true)
    expect(second.tombstoned).toBe(false)
    expect(second.runtimes.filter((r) => r.status === 'removed')).toEqual([])
  })

  it('refuses the Hermes env key when it holds a different agent\u2019s key (unnamed)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-envrefuse-'))
    const tombstonesDir = join(homeDir, '.haven', 'tombstones')
    const wrapper = join(homeDir, '.haven', 'agents', 'agent-1', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-1', apiKey: 'sk_1', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    // Config launches THIS wrapper, but the env holds a DIFFERENT agent's key —
    // the classic post-accident blend this whole epic was about.
    await seedHermes(homeDir, HOSTED_URL, 'sk_OTHER', wrapper, BARE)
    const envBefore = await readFile(join(homeDir, '.hermes', '.env'), 'utf8')

    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir })
    const envRefusal = result.runtimes.find((r) => r.label === 'Hermes env')
    expect(envRefusal?.status).toBe('refused')
    expect(envRefusal?.detail).toContain('different agent')
    expect(await readFile(join(homeDir, '.hermes', '.env'), 'utf8')).toBe(envBefore)
  })

  it('reports an unreadable Hermes config as a hand-fixable refusal, never rewriting it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-unreadable-'))
    const tombstonesDir = join(homeDir, '.haven', 'tombstones')
    const wrapper = join(homeDir, '.haven', 'agents', 'agent-1', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-1', apiKey: 'sk_1', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    await mkdir(join(homeDir, '.hermes'), { recursive: true })
    const bad = 'mcp_servers: [Bearer «redacted:sk_…»\n'
    await writeFile(join(homeDir, '.hermes', 'config.yaml'), bad)

    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir })
    const unreadable = result.runtimes.find((r) => r.runtime === 'hermes')
    expect(unreadable?.status).toBe('unreadable')
    expect(await readFile(join(homeDir, '.hermes', 'config.yaml'), 'utf8')).toBe(bad)
  })
})
