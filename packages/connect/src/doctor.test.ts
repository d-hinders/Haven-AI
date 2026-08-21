/**
 * #1589 — --doctor / --repair. The healthy path, each simulated failure with
 * its named repair, secret-hygiene, and repair-then-doctor recovery — all via
 * injected deps, no network, no real signer spawn.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import { acknowledgeLocalSignerConsent } from './signer-consent.js'
import { runDoctor, runRepair, type DoctorDeps } from './doctor.js'

const API_KEY = 'sk_agent_1234567890abcdef1234567890abcdef'
const DELEGATE_ADDRESS = '0x' + 'cd'.repeat(20)
const HOSTED = 'https://mcp.haven.example/mcp'

async function seedCredentials(homeDir: string, agentId = 'agent-1') {
  const dir = join(homeDir, '.haven', 'agents', agentId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'identity.json'), JSON.stringify({
    api_key: API_KEY,
    agent_id: agentId,
    api_url: 'https://api.haven.example',
    hosted_mcp_url: HOSTED,
  }))
  await writeFile(join(dir, 'signer.json'), JSON.stringify({
    version: 1,
    delegate_key: '0x' + '11'.repeat(32),
    delegate_address: DELEGATE_ADDRESS,
    agent_id: agentId,
    safe_address: '0x' + 'ab'.repeat(20),
    chain_id: 84532,
    network: 'eip155:84532',
  }), { mode: 0o600 })
  // Consent is an ack sidecar hashed from the credential, not a field in it.
  await acknowledgeLocalSignerConsent(join(dir, 'signer.json'))
  return dir
}

async function seedRuntime(homeDir: string, dir: string) {
  const runtimeDirectory = join(homeDir, '.haven', 'signer-runtime', MCP_RUNTIME_MANIFEST.signerVersion)
  const cliPath = join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js')
  await mkdir(join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist'), { recursive: true })
  await writeFile(cliPath, '// cli')
  for (const pkg of ['signer', 'sdk']) {
    const pkgDir = join(runtimeDirectory, 'node_modules', '@haven_ai', pkg)
    await mkdir(pkgDir, { recursive: true })
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
      version: pkg === 'signer' ? MCP_RUNTIME_MANIFEST.signerVersion : MCP_RUNTIME_MANIFEST.sdkVersion,
    }))
  }
  const wrapperPath = join(dir, 'bin', 'haven-signer.mjs')
  await mkdir(join(dir, 'bin'), { recursive: true })
  await writeFile(wrapperPath, '// wrapper')
  await writeFile(join(dir, 'signer-runtime.json'), JSON.stringify({
    signer_package: MCP_RUNTIME_MANIFEST.signerPackage,
    signer_version: MCP_RUNTIME_MANIFEST.signerVersion,
    sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
    sdk_version: MCP_RUNTIME_MANIFEST.sdkVersion,
    wrapper_path: wrapperPath,
    runtime_directory: runtimeDirectory,
    npm_cache_directory: join(homeDir, '.haven', 'npm-cache'),
    cli_path: cliPath,
  }))
  return { runtimeDirectory, wrapperPath, cliPath }
}

async function seedCodexConfig(homeDir: string, wrapperPath: string) {
  await mkdir(join(homeDir, '.codex'), { recursive: true })
  await writeFile(join(homeDir, '.codex', 'config.toml'), [
    '[mcp_servers.haven]',
    `url = "${HOSTED}"`,
    '[mcp_servers.haven_signer]',
    `command = "${wrapperPath}"`,
  ].join('\n'))
}

function healthyDeps(): DoctorDeps & {
  probeSignerTools: ReturnType<typeof vi.fn>
  probeHosted: ReturnType<typeof vi.fn>
  probeHostedIdentity: ReturnType<typeof vi.fn>
} {
  return {
    probeHosted: vi.fn(async () => ({ status: 'ok' as const })),
    // Stubbed deliberately: an unstubbed identity probe reaches the network,
    // fails, and reports "comparison skipped" — a green check that proves
    // nothing. The mismatch cases below are the real coverage.
    probeHostedIdentity: vi.fn(async () => ({
      status: 'ok' as const, agentId: 'agent-1', delegateAddress: DELEGATE_ADDRESS,
    })),
    probeSignerTools: vi.fn(async () => ({
      status: 'ok' as const,
      toolNames: [...MCP_RUNTIME_MANIFEST.requiredSignerTools],
      serverInfo: { name: 'haven-signer', version: MCP_RUNTIME_MANIFEST.signerVersion },
      // The REAL signer nests MCP capabilities under `experimental`
      // (signerCapabilityAdvertisement) — the mock matches production shape.
      capabilities: { experimental: { 'haven/signer-compatibility': { x402_expected_context_versions: [1, 2] } } },
    })),
  }
}

async function healthyHome() {
  const homeDir = await mkdtemp(join(tmpdir(), 'haven-doctor-'))
  const dir = await seedCredentials(homeDir)
  const runtime = await seedRuntime(homeDir, dir)
  await seedCodexConfig(homeDir, runtime.wrapperPath)
  return { homeDir, dir, ...runtime }
}

describe('runDoctor (#1589)', () => {
  it('healthy hosted install: every check passes, capabilities surfaced, exit-ok', async () => {
    const { homeDir } = await healthyHome()
    const deps = healthyDeps()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })

    expect(report.ok).toBe(true)
    expect(report.checks.filter((c) => !c.ok)).toEqual([])
    // #1697 adds identity_match to the single-agent list, deliberately and
    // visibly: proving the stored API key and the stored signing key belong
    // to the same agent is the half of the #1681 hazard a local tool CAN know.
    expect(report.checks.map((c) => c.id)).toEqual([
      'credentials', 'signer_runtime', 'runtime_config', 'hosted_mcp', 'identity_match', 'signer_process', 'restart',
    ])
    // Compat surface rides from the SAME handshake — the #1587-review design —
    // extracted from the REAL experimental nesting, and the human detail names
    // the versions so a --json-less run still sees them.
    expect(report.signerCapabilities).toMatchObject({
      'haven/signer-compatibility': { x402_expected_context_versions: [1, 2] },
    })
    const signerCheck = report.checks.find((c) => c.id === 'signer_process')
    expect(signerCheck?.detail).toContain('x402 expected-context v[1,2]')
    expect(deps.probeSignerTools).toHaveBeenCalledTimes(1)
  })

  it('NO SECRETS: the report never contains the api key or the delegate private key', async () => {
    const { homeDir } = await healthyHome()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(API_KEY)
    expect(serialized).not.toContain('11'.repeat(32))
  })

  it('missing config entry: that check fails with the repair action, others unaffected', async () => {
    const { homeDir } = await healthyHome()
    await rm(join(homeDir, '.codex', 'config.toml'))
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })
    expect(report.ok).toBe(false)
    const check = report.checks.find((c) => c.id === 'runtime_config')
    expect(check?.ok).toBe(false)
    expect(check?.repair).toContain('--repair')
  })

  it('a config still on the npx launch is flagged as the pre-#1586 shape', async () => {
    const { homeDir } = await healthyHome()
    await writeFile(join(homeDir, '.codex', 'config.toml'), [
      '[mcp_servers.haven]',
      `url = "${HOSTED}"`,
      '[mcp_servers.haven_signer]',
      'command = "npx"',
      `args = ["-y", "@haven_ai/signer@${MCP_RUNTIME_MANIFEST.signerVersion}"]`,
    ].join('\n'))
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })
    const check = report.checks.find((c) => c.id === 'runtime_config')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('npx')
  })

  it('unauthorized hosted probe: names the fresh-token recovery', async () => {
    const { homeDir } = await healthyHome()
    const report = await runDoctor({ runtime: 'codex-cli' }, {
      homeDir,
      ...healthyDeps(),
      probeHosted: vi.fn(async () => ({ status: 'unauthorized' as const })),
    })
    const check = report.checks.find((c) => c.id === 'hosted_mcp')
    expect(check?.ok).toBe(false)
    expect(check?.repair).toContain('--setup <token>')
  })

  it('emptied runtime dir: signer_runtime fails as stale/empty with the repair action', async () => {
    const { homeDir, runtimeDirectory } = await healthyHome()
    await rm(runtimeDirectory, { recursive: true, force: true })
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })
    const check = report.checks.find((c) => c.id === 'signer_runtime')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toMatch(/stale or empty/i)
    expect(check?.repair).toContain('--repair')
  })

  it('signer probe timeout: signer_process fails with the repair action', async () => {
    const { homeDir } = await healthyHome()
    const report = await runDoctor({ runtime: 'codex-cli' }, {
      homeDir,
      ...healthyDeps(),
      probeSignerTools: vi.fn(async () => ({ status: 'timeout' as const })),
    })
    const check = report.checks.find((c) => c.id === 'signer_process')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('timeout')
    expect(check?.repair).toContain('--repair')
  })

  it('un-acknowledged consent reads as CONSENT MISSING, never as a broken signer (#1587 review)', async () => {
    const { homeDir, dir } = await healthyHome()
    // Invalidate the ack: change the credential so the stored hash mismatches.
    await writeFile(join(dir, 'signer.json'), JSON.stringify({
      version: 1,
      delegate_key: '0x' + '22'.repeat(32),
      agent_id: 'agent-1',
      safe_address: '0x' + 'cd'.repeat(20),
      chain_id: 84532,
      network: 'eip155:84532',
    }), { mode: 0o600 })
    const deps = healthyDeps()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })
    const check = report.checks.find((c) => c.id === 'signer_process')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('consent')
    expect(check?.repair).toContain('--ack-local-tools')
    // The probe is never spawned against a gate that will refuse by design.
    expect(deps.probeSignerTools).not.toHaveBeenCalled()
  })
})

describe('runRepair (#1589)', () => {
  it('restores an emptied signer runtime + rewrites wrapper/config; a follow-up doctor passes', async () => {
    const { homeDir, dir, runtimeDirectory } = await healthyHome()
    await rm(runtimeDirectory, { recursive: true, force: true })
    await rm(join(homeDir, '.codex', 'config.toml'))

    // The injected "npm install" materialises what the postconditions check.
    const runCommand = vi.fn(async () => {
      const cliDir = join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist')
      await mkdir(cliDir, { recursive: true })
      await writeFile(join(cliDir, 'cli.js'), '// cli')
      for (const pkg of ['signer', 'sdk']) {
        const pkgDir = join(runtimeDirectory, 'node_modules', '@haven_ai', pkg)
        await mkdir(pkgDir, { recursive: true })
        await writeFile(join(pkgDir, 'package.json'), JSON.stringify({
          version: pkg === 'signer' ? MCP_RUNTIME_MANIFEST.signerVersion : MCP_RUNTIME_MANIFEST.sdkVersion,
        }))
      }
    })
    const repair = await runRepair({ runtime: 'codex-cli' }, { homeDir, runCommand })
    expect(repair.ok).toBe(true)
    expect(runCommand).toHaveBeenCalled()

    const config = await readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')
    expect(config).toContain(join(dir, 'bin', 'haven-signer.mjs'))
    expect(config).not.toContain(API_KEY.slice(0, 12) + '"')

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })
    expect(report.ok).toBe(true)
  })

  it('REFUSES to touch a --local (local-stdio) config — repair must never convert a topology', async () => {
    const { homeDir, dir } = await healthyHome()
    // A local-stdio config: the haven entry is the LOCAL MCP wrapper.
    await writeFile(join(homeDir, '.codex', 'config.toml'), [
      '[mcp_servers.haven]',
      `command = "${join(dir, 'bin', 'haven-mcp')}"`,
    ].join('\n'))
    const runCommand = vi.fn()
    const repair = await runRepair({ runtime: 'codex-cli' }, { homeDir, runCommand })
    expect(repair.ok).toBe(false)
    expect(repair.messages.join('\n')).toContain('LOCAL-stdio topology')
    // Nothing was reinstalled or rewritten.
    expect(runCommand).not.toHaveBeenCalled()
    const config = await readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')
    expect(config).toContain('bin/haven-mcp')
  })

  it('refuses without stored credentials — repair never mints identity', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-doctor-empty-'))
    const repair = await runRepair({ runtime: 'codex-cli' }, { homeDir })
    expect(repair.ok).toBe(false)
    expect(repair.messages.join('\n')).toContain('--setup <token>')
  })
})

/**
 * #1688 — the superseded_agents check. A re-run mints a new agent and retires
 * nothing; these pin that a directory the doctor did NOT select is probed with
 * ITS OWN key, and that the three probe outcomes map to exactly the right
 * severities: live ⇒ failure with the revoke repair, revoked ⇒ informational
 * pass, unreachable ⇒ note that is neither a false alarm nor a clean bill.
 */
describe('superseded agent credentials (#1688)', () => {
  const OLD_KEY = 'sk_agent_oldsecret'

  async function homeWithSuperseded() {
    const { homeDir } = await healthyHome()
    // The OLD directory: seeded after the selected one, so force ordering by
    // touching the selected dir's identity.json to be newest.
    const oldDir = join(homeDir, '.haven', 'agents', 'agent-old')
    await mkdir(oldDir, { recursive: true })
    await writeFile(join(oldDir, 'identity.json'), JSON.stringify({
      api_key: OLD_KEY,
      agent_id: 'agent-old',
      api_url: 'https://api.haven.example',
      hosted_mcp_url: HOSTED,
    }))
    // Make the ORIGINAL dir newest so discovery still selects agent-1.
    const selected = join(homeDir, '.haven', 'agents', 'agent-1', 'identity.json')
    const current = JSON.parse(await readFile(selected, 'utf8')) as Record<string, unknown>
    await writeFile(selected, JSON.stringify(current))
    return { homeDir, oldDir }
  }

  function depsWithOldKeyProbing(oldStatus: 'ok' | 'unauthorized' | 'network_error') {
    const deps = healthyDeps()
    deps.probeHosted.mockImplementation(async (apiKey: string) =>
      apiKey === OLD_KEY ? { status: oldStatus } : { status: 'ok' },
    )
    return deps
  }

  it('MUTATION PROOF: a superseded dir whose key still authenticates FAILS the doctor, naming the agent', async () => {
    const { homeDir } = await homeWithSuperseded()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsWithOldKeyProbing('ok') })

    expect(report.ok).toBe(false)
    const check = report.checks.find((c) => c.id === 'superseded_agents')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('agent-old')
    expect(check?.detail).toMatch(/SPEND-CAPABLE/)
    expect(check?.repair).toMatch(/[Rr]evoke/)
    expect(check?.repair).toContain('agent-old')
    // Connect reports; the user acts. The repair must never claim otherwise.
    expect(check?.repair).toMatch(/never revokes or deletes/)
  })

  it('an already-revoked superseded dir is an informational pass, not a failure', async () => {
    const { homeDir } = await homeWithSuperseded()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsWithOldKeyProbing('unauthorized') })

    const check = report.checks.find((c) => c.id === 'superseded_agents')
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain('already revoked')
    expect(report.ok).toBe(true)
  })

  it('a network error probing the OLD key is a note — never a false "still live", never a clean bill', async () => {
    const { homeDir } = await homeWithSuperseded()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsWithOldKeyProbing('network_error') })

    const check = report.checks.find((c) => c.id === 'superseded_agents')
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain('could not verify')
    expect(check?.detail).not.toMatch(/SPEND-CAPABLE/)
  })

  it('the old cosmetic "N dirs found; examining the newest" note is gone — subsumed by the check', async () => {
    const { homeDir } = await homeWithSuperseded()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsWithOldKeyProbing('ok') })

    const credentials = report.checks.find((c) => c.id === 'credentials')
    expect(credentials?.detail).not.toContain('examining the newest')
  })

  it('no secret material reaches the report, in either state', async () => {
    const { homeDir } = await homeWithSuperseded()
    for (const status of ['ok', 'unauthorized'] as const) {
      const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsWithOldKeyProbing(status) })
      const serialized = JSON.stringify(report)
      expect(serialized).not.toContain(OLD_KEY)
      expect(serialized).not.toContain(API_KEY)
      expect(serialized).not.toContain('11'.repeat(32))
    }
  })

  it('REGRESSION (B2): an explicit --credentials-dir scans ITS OWN parent, never the default root', async () => {
    // Pointing doctor at an explicit directory must not live-probe real keys
    // under ~/.haven/agents — the location the caller explicitly moved away
    // from. Siblings of the explicit dir are the only legitimate "others".
    const { homeDir } = await homeWithSuperseded() // default root holds agent-1 + agent-old
    const customRoot = await mkdtemp(join(tmpdir(), 'haven-custom-'))
    const explicitDir = join(customRoot, 'agent-x')
    await mkdir(explicitDir, { recursive: true })
    await writeFile(join(explicitDir, 'identity.json'), JSON.stringify({
      api_key: API_KEY, agent_id: 'agent-x', api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))
    const sibling = join(customRoot, 'agent-sibling')
    await mkdir(sibling, { recursive: true })
    await writeFile(join(sibling, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_sibsecret', agent_id: 'agent-sibling', api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))

    const deps = healthyDeps()
    const probedKeys: string[] = []
    deps.probeHosted.mockImplementation(async (apiKey: string) => {
      probedKeys.push(apiKey)
      return { status: 'ok' as const }
    })

    const report = await runDoctor(
      { runtime: 'codex-cli', credentialsDir: explicitDir },
      { homeDir, ...deps },
    )

    const check = report.checks.find((c) => c.id === 'superseded_agents')
    expect(check?.detail).toContain('agent-sibling')
    // The default root's OLD key must never have been probed.
    expect(probedKeys).not.toContain(OLD_KEY)
    expect(check?.detail).not.toContain('agent-old')
  })

  it('a single credential directory adds NO superseded check — the id list stays the #1589 shape', async () => {
    const { homeDir } = await healthyHome()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })
    expect(report.checks.map((c) => c.id)).toEqual([
      'credentials', 'signer_runtime', 'runtime_config', 'hosted_mcp', 'identity_match', 'signer_process', 'restart',
    ])
  })

  /**
   * #1681 — a tombstone changes how a directory READS, never whether a
   * still-present key gets probed. Retired-with-keys-removed is an
   * informational pass; tombstoned-with-live-key still fails the doctor.
   */
  it('a tombstoned dir with keys REMOVED reads as retired — informational pass, not "no stored key"', async () => {
    const { homeDir, oldDir } = await homeWithSuperseded()
    const { writeAgentTombstone } = await import('./tombstone.js')
    const { rm } = await import('node:fs/promises')
    await writeAgentTombstone({
      directory: oldDir, agentId: 'agent-old', reason: 'reset', retiredAt: '2026-08-21T10:00:00.000Z',
    })
    await rm(join(oldDir, 'identity.json'))

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })
    const check = report.checks.find((c) => c.id === 'superseded_agents')
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain('tombstoned (keys removed)')
    expect(check?.detail).toContain('agent-old')
    expect(check?.detail).toContain('2026-08-21')
    expect(check?.detail).not.toContain('no stored key/URL to probe')
  })

  it('MUTATION PROOF: a tombstone does NOT excuse a live key — still spend-capable, still a failure', async () => {
    // A tombstone is a marker, not a revocation. If it silenced the probe, a
    // retirement flow that forgot the revoke step would green-wash a key that
    // still spends.
    const { homeDir, oldDir } = await homeWithSuperseded()
    const { writeAgentTombstone } = await import('./tombstone.js')
    await writeAgentTombstone({ directory: oldDir, agentId: 'agent-old', reason: 'reset' })

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsWithOldKeyProbing('ok') })
    const check = report.checks.find((c) => c.id === 'superseded_agents')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toMatch(/SPEND-CAPABLE/)
    expect(check?.detail).toContain('tombstoned — key material still present')
  })
})


/**
 * #1697 — the hosted-vs-local identity compare. On 2026-08-21 the only way to
 * prove a running session was unsafe to pay from was cross-checking the
 * delegate address by hand, mid-purchase. This makes the knowable half
 * mechanical: the stored API key and the stored signing key must belong to
 * the same agent.
 */
describe('hosted identity vs local signing key (#1697)', () => {
  it('MUTATION PROOF: a MISMATCH is a hard failure naming both sides and the remedy', async () => {
    const { homeDir } = await healthyHome()
    const deps = healthyDeps()
    const otherDelegate = '0x' + 'ef'.repeat(20)
    deps.probeHostedIdentity.mockResolvedValue({
      status: 'ok', agentId: 'agent-other', delegateAddress: otherDelegate,
    })

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })
    const check = report.checks.find((c) => c.id === 'identity_match')

    expect(report.ok).toBe(false)
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('MISMATCH')
    expect(check?.detail).toContain('agent-other')
    // Both addresses named — abbreviated, never in full, and never the key.
    expect(check?.detail).toContain(otherDelegate.slice(0, 6))
    expect(check?.detail).toContain(DELEGATE_ADDRESS.slice(0, 6))
    expect(check?.detail).toMatch(/quote as one agent and sign as another/)
    expect(check?.repair).toMatch(/Re-run setup/)
  })

  it('a matching pair passes and says so in the agent inventory too', async () => {
    const { homeDir } = await healthyHome()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })

    expect(report.checks.find((c) => c.id === 'identity_match')?.ok).toBe(true)
    expect(report.agents).toHaveLength(1)
    expect(report.agents[0].classification).toBe('wired')
    expect(report.agents[0].checks.map((c) => c.id)).toContain('identity_match')
  })

  it('an unreachable hosted API is SKIPPED, never passed as a match', async () => {
    const { homeDir } = await healthyHome()
    const deps = healthyDeps()
    deps.probeHostedIdentity.mockResolvedValue({ status: 'network_error' })

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })
    const check = report.checks.find((c) => c.id === 'identity_match')
    expect(check?.detail).toMatch(/comparison skipped, not passed/)
    expect(check?.detail).not.toMatch(/matches/i)
  })

  it('a rejected API key fails the compare — it cannot be called a match', async () => {
    const { homeDir } = await healthyHome()
    const deps = healthyDeps()
    deps.probeHostedIdentity.mockResolvedValue({ status: 'unauthorized' })

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })
    expect(report.checks.find((c) => c.id === 'identity_match')?.ok).toBe(false)
  })

  it('NO SECRETS: neither the api key nor the delegate private key reaches the report', async () => {
    const { homeDir } = await healthyHome()
    const deps = healthyDeps()
    deps.probeHostedIdentity.mockResolvedValue({
      status: 'ok', agentId: 'agent-other', delegateAddress: '0x' + 'ef'.repeat(20),
    })
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(API_KEY)
    expect(serialized).not.toContain('11'.repeat(32))
  })
})

/**
 * #1697 — the inventory itself. "Newest wins" said one directory was real and
 * the rest were notes; multi-agent (#1696) makes several agents legitimately
 * live at once, so the doctor must enumerate and classify instead of choosing.
 */
describe('per-agent inventory (#1697)', () => {
  async function homeWithTwoWiredAgents() {
    const { homeDir, dir } = await healthyHome()
    // A NAMED second agent, wired under its own entry names (#1695/#1696).
    const namedDir = join(homeDir, '.haven', 'agents', 'ops')
    await mkdir(join(namedDir, 'bin'), { recursive: true })
    await writeFile(join(namedDir, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_opssecret', agent_id: 'agent-ops',
      api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))
    await writeFile(join(namedDir, 'signer.json'), JSON.stringify({
      version: 1, delegate_key: '0x' + '22'.repeat(32), delegate_address: '0x' + 'ba'.repeat(20),
      agent_id: 'agent-ops', chain_id: 84532,
    }), { mode: 0o600 })
    await acknowledgeLocalSignerConsent(join(namedDir, 'signer.json'))
    const namedWrapper = join(namedDir, 'bin', 'haven-signer.mjs')
    await writeFile(namedWrapper, '// wrapper')
    const runtimeDirectory = join(homeDir, '.haven', 'signer-runtime', MCP_RUNTIME_MANIFEST.signerVersion)
    await writeFile(join(namedDir, 'signer-runtime.json'), JSON.stringify({
      server_name: 'ops',
      signer_package: MCP_RUNTIME_MANIFEST.signerPackage,
      signer_version: MCP_RUNTIME_MANIFEST.signerVersion,
      sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
      sdk_version: MCP_RUNTIME_MANIFEST.sdkVersion,
      wrapper_path: namedWrapper,
      runtime_directory: runtimeDirectory,
      npm_cache_directory: join(homeDir, '.haven', 'npm-cache'),
      cli_path: join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js'),
    }))
    // Wire BOTH pairs into the Codex config.
    await writeFile(join(homeDir, '.codex', 'config.toml'), [
      '[mcp_servers.haven]', `url = "${HOSTED}"`,
      '[mcp_servers.haven_signer]', `command = "${join(dir, 'bin', 'haven-signer.mjs')}"`,
      '[mcp_servers.haven-ops]', `url = "${HOSTED}"`,
      '[mcp_servers.haven-signer-ops]', `command = "${namedWrapper}"`,
    ].join('\n'))
    return { homeDir, dir, namedDir }
  }

  function depsForTwo(namedOverrides: Record<string, unknown> = {}) {
    const deps = healthyDeps()
    deps.probeHostedIdentity.mockImplementation(async (apiKey: string) =>
      apiKey === 'sk_agent_opssecret'
        ? { status: 'ok' as const, agentId: 'agent-ops', delegateAddress: '0x' + 'ba'.repeat(20), ...namedOverrides }
        : { status: 'ok' as const, agentId: 'agent-1', delegateAddress: DELEGATE_ADDRESS },
    )
    return deps
  }

  it('MUTATION PROOF: BOTH wired agents are reported — a live sibling is not "superseded"', async () => {
    const { homeDir } = await homeWithTwoWiredAgents()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsForTwo() })

    const wired = report.agents.filter((a) => a.classification === 'wired')
    expect(wired).toHaveLength(2)
    expect(wired.map((a) => a.agentId).sort()).toEqual(['agent-1', 'agent-ops'])
    expect(wired.find((a) => a.slug === 'ops')).toBeDefined()
    // Each carries the full per-agent check set, not a summary line.
    for (const agent of wired) {
      expect(agent.checks.map((c) => c.id)).toEqual(
        expect.arrayContaining(['credentials', 'signer_runtime', 'hosted_mcp', 'identity_match', 'signer_process']),
      )
    }
    // A legitimately live second agent must NOT be reported as spend-capable
    // leftover — that was the old heuristic's failure mode.
    const superseded = report.checks.find((c) => c.id === 'superseded_agents')
    expect(superseded?.ok).toBe(true)
    expect(report.ok).toBe(true)
  })

  it('MUTATION PROOF: a failure on a NON-primary wired agent still fails the doctor', async () => {
    // The old shape only ever checked one directory, so a broken second agent
    // was invisible — exactly what multi-agent makes common. The failing agent
    // here is deliberately NOT the one the flat `checks` array describes, so
    // the only thing that can catch it is the inventory.
    const { homeDir } = await homeWithTwoWiredAgents()
    const deps = healthyDeps()
    deps.probeHostedIdentity.mockImplementation(async (apiKey: string) =>
      apiKey === 'sk_agent_opssecret'
        ? { status: 'ok' as const, agentId: 'agent-ops', delegateAddress: '0x' + 'ba'.repeat(20) }
        // agent-1 is the older, non-primary agent: its hosted identity no
        // longer matches the signing key sitting in its directory.
        : { status: 'ok' as const, agentId: 'agent-someone-else', delegateAddress: '0x' + 'ee'.repeat(20) },
    )

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })

    // The flat list describes the PRIMARY agent and is entirely green...
    expect(report.credentialDirectory).toContain('ops')
    expect(report.checks.filter((c) => !c.ok)).toEqual([])
    // ...yet the report as a whole must fail, because a wired agent is broken.
    expect(report.ok).toBe(false)
    const broken = report.agents.find((a) => a.agentId === 'agent-1')
    expect(broken?.classification).toBe('wired')
    expect(broken?.checks.find((c) => c.id === 'identity_match')?.ok).toBe(false)
  })

  it('a credential dir with NO config entry is classified superseded, never silently skipped', async () => {
    const { homeDir } = await homeWithTwoWiredAgents()
    const strayDir = join(homeDir, '.haven', 'agents', 'stray')
    await mkdir(strayDir, { recursive: true })
    await writeFile(join(strayDir, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_straysecret', agent_id: 'agent-stray',
      api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsForTwo() })
    const stray = report.agents.find((a) => a.agentId === 'agent-stray')
    expect(stray?.classification).toBe('superseded')
    // And it is the one that makes the superseded check fail: its key is live.
    expect(report.checks.find((c) => c.id === 'superseded_agents')?.ok).toBe(false)
  })

  it('a tombstoned dir is classified retired, not orphaned', async () => {
    const { homeDir } = await homeWithTwoWiredAgents()
    const deadDir = join(homeDir, '.haven', 'agents', 'dead')
    await mkdir(deadDir, { recursive: true })
    const { writeAgentTombstone } = await import('./tombstone.js')
    await writeAgentTombstone({ directory: deadDir, agentId: 'agent-dead', reason: 'reset' })

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...depsForTwo() })
    const dead = report.agents.find((a) => a.agentId === 'agent-dead')
    expect(dead?.classification).toBe('retired')
    expect(dead?.checks).toEqual([])
  })
})
