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
  mergeCodexTomlHosted,
  removeCodexToml,
  removeHermesEnv,
  removeHermesYaml,
  removeJsonMcpConfig,
} from './config-writers.js'
import { serverNamesFor } from './server-names.js'
import { unwireAgent } from './unwire.js'
import { readMcpServerBinding, writeMcpServerBinding } from './storage.js'
import { runDoctor, type DoctorDeps } from './doctor.js'
import { acknowledgeLocalSignerConsent } from './signer-consent.js'
import { isolateHermesHome, restoreHermesHome } from './test-helpers.js'

const HOSTED_URL = 'https://mcp.haven.example/mcp'
const BARE = serverNamesFor()
const RESEARCH = serverNamesFor('research')

// #2179: shared isolation — Hermes path resolution honours process.env.
// HERMES_HOME before the fixture home; a gateway shell would corrupt the real
// home without this. Same guard as the rest of the Hermes-path suites.
beforeEach(isolateHermesHome)
afterEach(restoreHermesHome)

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

  it('owner unwire with NO stored api_url (nothing to preserve, #3123 not_probed): --doctor afterwards reports the directory as retired, not superseded', async () => {
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

  it('#3259: an unwritable ledger still tears down the key material and reports mirrorError', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-mirror-fail-'))
    // A FILE where the ledger directory would go: mkdir fails as any user.
    const blocker = join(homeDir, 'not-a-dir')
    await writeFile(blocker, 'x')
    const wrapper = join(homeDir, '.haven', 'agents', 'agent-1', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-1', apiKey: 'sk_1', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    await seedHermes(homeDir, HOSTED_URL, 'sk_1', wrapper, BARE)

    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(blocker, 'tombstones') })
    expect(result.tombstoned).toBe(true)
    expect(result.mirrorError).toMatch(/^(ENOTDIR|EEXIST)$/)
    expect(await readFile(join(dir, 'TOMBSTONE.json'), 'utf8')).toContain('agent-1')
    await expect(readFile(join(dir, 'signer.json'), 'utf8')).rejects.toThrow()
    expect(JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8'))).not.toHaveProperty('api_key')
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
    expect(first).not.toHaveProperty('mirrorError')
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

/**
 * #3123 — teardown asks before it destroys. `--unwire` used to strip the API
 * key and delete the signer key unconditionally; a revoked agent's API key +
 * delegate signature are exactly what the sweep-recovery routes still accept,
 * so that was the only local means of recovering a stranded balance. Owner
 * decision (option c): refuse on every probe outcome, an explicit flag
 * proceeds, no balance read, no new network call beyond the existing probe.
 */
describe('teardown refuses before destroying the recovery credential (#3123)', () => {
  const API_URL = 'https://api.haven.example'

  async function seedProbeableAgent(homeDir: string, apiKey = 'sk_live_agent') {
    const wrapper = join(homeDir, '.haven', 'agents', 'research', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-research', slug: 'research', apiKey, hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    // The real setup records api_url; the probe needs it. Without it there is nothing to probe with.
    const identity = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(dir, 'identity.json'), JSON.stringify({ ...identity, api_url: API_URL }))
    await writeFile(join(dir, 'rekey-pending.json'), JSON.stringify({ version: 1, agent_id: 'agent-research', address: '0x' + 'ee'.repeat(20), private_key: '0x' + '33'.repeat(32), started_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-09-01T01:00:00.000Z' }))
    const { configPath, envPath } = await seedHermes(homeDir, HOSTED_URL, apiKey, wrapper, RESEARCH)
    return { dir, wrapper, configPath, envPath }
  }

  async function keyMaterialPresent(dir: string): Promise<{ signer: boolean; rekey: boolean; apiKey: boolean }> {
    const has = async (f: string) => readFile(join(dir, f), 'utf8').then(() => true, () => false)
    const identity = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')) as { api_key?: string }
    return { signer: await has('signer.json'), rekey: await has('rekey-pending.json'), apiKey: typeof identity.api_key === 'string' }
  }

  for (const status of ['ok', 'unauthorized', 'network_error', 'bad_response'] as const) {
    it(`probe ${status}: REFUSES — signer key, parked re-key and API key stay; the wiring (config + env) is still removed first (S3)`, async () => {
      const homeDir = await mkdtemp(join(tmpdir(), `haven-unwire-refuse-${status}-`))
      const { dir, configPath, envPath } = await seedProbeableAgent(homeDir)
      const probe = vi.fn(async () => (status === 'ok' ? { status, agentId: 'agent-research', delegateAddress: '0x' + 'cd'.repeat(20) } : { status }))

      const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), probeHostedIdentity: probe })

      expect(result.teardown).toMatchObject({ status: 'retained', probe: status })
      expect(result.teardown.remedy).toBeTruthy()
      expect(await keyMaterialPresent(dir)).toEqual({ signer: true, rekey: true, apiKey: true })
      // S3: the world-readable copies were scrubbed BEFORE the decision; the key survives only in the 0o600 file.
      expect(await readFile(configPath, 'utf8')).not.toContain('haven-research')
      expect(await readFile(envPath, 'utf8')).not.toContain('sk_live_agent')
      expect(result.tombstoned).toBe(true)
      expect(probe).toHaveBeenCalledTimes(1)
      expect(probe).toHaveBeenCalledWith('sk_live_agent', API_URL, undefined)
    })
  }

  it('probe ok: the refusal names the live spend authority and the remedy (revoke on the agent page, or the override)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-ok-'))
    const { dir } = await seedProbeableAgent(homeDir)
    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), probeHostedIdentity: async () => ({ status: 'ok', agentId: 'agent-research', delegateAddress: '0x' + 'cd'.repeat(20) }) })
    expect(result.teardown.detail).toMatch(/still ACTIVE/)
    expect(result.teardown.remedy).toMatch(/Revoke the agent on the Haven agent page/)
    expect(result.teardown.remedy).toContain('--destroy-key-material')
  })

  it('probe unauthorized: says what it does NOT know — a stranded balance MAY exist and the connector cannot check — never that the key is worthless', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-unauth-'))
    const { dir } = await seedProbeableAgent(homeDir)
    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), probeHostedIdentity: async () => ({ status: 'unauthorized' }) })
    const text = `${result.teardown.detail} ${result.teardown.remedy}`
    expect(text).toMatch(/MAY still exist/)
    expect(text).toMatch(/CANNOT check/)
    expect(text).toMatch(/sweep-recovery/)
    // The backend's 401 is deliberately ambiguous (revoked, archived, paused, unknown key all read the
    // same); the connector must not claim a revocation, and must name the alternatives.
    expect(text).not.toMatch(/\b(was|is|has been|got) revoked\b/)
    expect(text).toMatch(/does not say which/)
    expect(text).toMatch(/archived/)
    expect(text).toMatch(/paused/)
    expect(text).not.toMatch(/worthless/)
    // #3151 review N3: the sweep-acceptance clause is hedged — a 401 does not
    // license "holds the only credential the routes still accept".
    expect(text).toMatch(/may hold the only local credential/)
    expect(text).toMatch(/would still accept/)
    expect(text).not.toMatch(/holds the only local credential/)
  })

  it('probe network_error: unknown is not "safe to delete" — refused, with retry as the remedy', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-net-'))
    const { dir } = await seedProbeableAgent(homeDir)
    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), probeHostedIdentity: async () => ({ status: 'network_error' }) })
    expect(result.teardown.detail).toMatch(/Could not verify/)
    expect(result.teardown.detail).toMatch(/Unknown is not "safe to delete"/)
    expect(result.teardown.remedy).toMatch(/Retry/)
  })

  it('--destroy-key-material proceeds on every outcome, destroys all three, and says that local recovery ends', async () => {
    for (const status of ['ok', 'unauthorized', 'network_error'] as const) {
      const homeDir = await mkdtemp(join(tmpdir(), `haven-unwire-force-${status}-`))
      const { dir, configPath, envPath } = await seedProbeableAgent(homeDir)
      const result = await unwireAgent({
        directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), destroyKeyMaterial: true,
        probeHostedIdentity: async () => (status === 'ok' ? { status, agentId: 'agent-research', delegateAddress: '0x' + 'cd'.repeat(20) } : { status }),
      })
      expect(result.teardown).toMatchObject({ status: 'forced', probe: status })
      expect(result.teardown.detail).toContain('--destroy-key-material')
      expect(result.teardown.remedy).toMatch(/Local recovery of a stranded delegate balance ends/)
      expect(await keyMaterialPresent(dir)).toEqual({ signer: false, rekey: false, apiKey: false })
      // After a forced teardown no local copy of the key remains anywhere the connector writes (S3).
      expect(await readFile(configPath, 'utf8')).not.toContain('sk_live_agent')
      expect(await readFile(envPath, 'utf8')).not.toContain('sk_live_agent')
      const identity = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8'))
      expect(identity.agent_id).toBe('agent-research')
    }
  })

  it('S3 with a config that really carries the key (Codex TOML, Bearer header): scrubbed before the decision on a retained teardown, and gone after a forced one', async () => {
    for (const mode of ['retained', 'forced'] as const) {
      const homeDir = await mkdtemp(join(tmpdir(), `haven-unwire-codex-${mode}-`))
      const { dir, wrapper } = await seedProbeableAgent(homeDir)
      const codexDir = join(homeDir, '.codex')
      await mkdir(codexDir, { recursive: true })
      const toml = mergeCodexTomlHosted('[mcp_servers.other]\nurl = "https://x"\n', HOSTED_URL, 'sk_live_agent', { command: wrapper, args: [] }, RESEARCH)
      expect(toml).toContain('sk_live_agent') // the seed is real: the raw key is in the file
      await writeFile(join(codexDir, 'config.toml'), toml)
      const result = await unwireAgent({
        directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'),
        destroyKeyMaterial: mode === 'forced',
        probeHostedIdentity: async () => ({ status: 'ok', agentId: 'agent-research', delegateAddress: '0x' + 'cd'.repeat(20) }),
      })
      expect(result.teardown.status).toBe(mode)
      const after = await readFile(join(codexDir, 'config.toml'), 'utf8')
      expect(after).not.toContain('sk_live_agent')
      expect(after).toContain('[mcp_servers.other]')
      expect(result.runtimes.some((r) => r.runtime === 'codex-cli' && r.status === 'removed')).toBe(true)
    }
  })

  it('no stored API key + URL: nothing the recovery routes would accept, so the teardown proceeds unprobed (the pre-#3123 shape)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-unprobed-'))
    const wrapper = join(homeDir, '.haven', 'agents', 'research', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-research', slug: 'research', apiKey: 'sk_x', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    const probe = vi.fn()
    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), probeHostedIdentity: probe })
    expect(result.teardown).toMatchObject({ status: 'destroyed', probe: 'not_probed' })
    expect(probe).not.toHaveBeenCalled()
    expect(await keyMaterialPresent(dir)).toMatchObject({ signer: false, apiKey: false })
  })

  it('the probe is the ONLY network call on the teardown path: one GET /machine-payments/agent with the stored key, nothing else', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-onecall-'))
    const { dir } = await seedProbeableAgent(homeDir)
    const calls: Array<{ url: string; auth: string | undefined }> = []
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') ?? undefined })
      return new Response(JSON.stringify({ id: 'agent-research', delegate_address: '0x' + 'cd'.repeat(20) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    try {
      const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), fetch: fetchImpl })
      expect(result.teardown).toMatchObject({ status: 'retained', probe: 'ok' })
      expect(calls).toEqual([{ url: `${API_URL}/machine-payments/agent`, auth: 'Bearer sk_live_agent' }])
      expect(globalFetch).not.toHaveBeenCalled()
    } finally {
      globalFetch.mockRestore()
    }
  })
})

describe('--unwire releases the local MCP server-name binding (#3122)', () => {
  it('removes mcp-server-binding.json from the directory and reports bindingReleased; a directory without one reports false', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-binding-'))
    const wrapper = join(homeDir, '.haven', 'agents', 'research', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-research', slug: 'research', apiKey: 'sk_x', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    await writeMcpServerBinding(dir, { version: 1, server_name: 'haven-research', signer_name: 'haven-signer-research', agent_id: 'agent-research', api_url: 'https://api.haven.example', bound_at: '2026-09-18T00:00:00.000Z' })
    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones') })
    expect(result.bindingReleased).toBe(true)
    expect(await readMcpServerBinding(dir)).toBeNull()
    // Idempotent re-run: nothing left to release.
    const again = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones') })
    expect(again.bindingReleased).toBe(false)
  })

  it('the release does not depend on the key-material decision: a RETAINED teardown still frees the name', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-unwire-binding-retained-'))
    const wrapper = join(homeDir, '.haven', 'agents', 'research', 'bin', 'haven-signer.mjs')
    const dir = await seedAgent(homeDir, { agentId: 'agent-research', slug: 'research', apiKey: 'sk_x', hostedUrl: HOSTED_URL, wrapperPath: wrapper })
    const identity = JSON.parse(await readFile(join(dir, 'identity.json'), 'utf8')) as Record<string, unknown>
    await writeFile(join(dir, 'identity.json'), JSON.stringify({ ...identity, api_url: 'https://api.haven.example' }))
    await writeMcpServerBinding(dir, { version: 1, server_name: 'haven-research', signer_name: 'haven-signer-research', agent_id: 'agent-research', api_url: 'https://api.haven.example', bound_at: '2026-09-18T00:00:00.000Z' })
    const result = await unwireAgent({ directory: dir, homeDir, tombstonesDir: join(homeDir, '.haven', 'tombstones'), probeHostedIdentity: async () => ({ status: 'ok', agentId: 'agent-research', delegateAddress: '0x' + 'cd'.repeat(20) }) })
    expect(result.teardown.status).toBe('retained')
    expect(result.bindingReleased).toBe(true)
    expect(await readMcpServerBinding(dir)).toBeNull()
  })
})
