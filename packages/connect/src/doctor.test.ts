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

  it('MUTATION PROOF: an unreachable hosted API does NOT pass — a comparison that did not happen is not a match', async () => {
    // #1697 review, finding 1: the old code said "skipped, not passed" in the
    // text while setting ok:true, so a real key mismatch coinciding with a
    // network blip sailed through every consumer that reads the boolean —
    // exit code, --json, CI. The earlier version of this test asserted only on
    // detail text, so it did not back its own title.
    const { homeDir } = await healthyHome()
    for (const status of ['network_error', 'bad_response'] as const) {
      const deps = healthyDeps()
      deps.probeHostedIdentity.mockResolvedValue({ status })

      const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })
      const check = report.checks.find((c) => c.id === 'identity_match')
      expect(check?.ok, status).toBe(false)
      expect(report.ok, status).toBe(false)
      expect(check?.detail).toMatch(/cannot be reported as a match/)
      expect(check?.repair).toBeTruthy()
    }
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

/**
 * #1697 review — the three classification/attribution defects the independent
 * pass found. Each test below exists because none of the tests written with
 * the feature caught it.
 */
describe('classification correctness (#1697 review)', () => {
  it('MUTATION PROOF: a live agent whose config still uses the retired npx launch is NOT called superseded', async () => {
    // Finding 2. The directory has a prepared sidecar, but the config names no
    // wrapper at all (the pre-#1586 npx shape, which runtime_config flags
    // separately). Condemning it as superseded would tell the user to revoke
    // the one agent that actually works.
    const { homeDir } = await healthyHome()
    await writeFile(join(homeDir, '.codex', 'config.toml'), [
      '[mcp_servers.haven]',
      `url = "${HOSTED}"`,
      '[mcp_servers.haven_signer]',
      'command = "npx"',
      `args = ["-y", "@haven_ai/signer@${MCP_RUNTIME_MANIFEST.signerVersion}"]`,
    ].join('\n'))

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...healthyDeps() })

    const agent = report.agents.find((a) => a.agentId === 'agent-1')
    expect(agent?.classification).toBe('wired')
    // The stale config is reported as what it is — a config problem, not a
    // reason to revoke a credential.
    expect(report.checks.find((c) => c.id === 'runtime_config')?.ok).toBe(false)
    expect(report.checks.find((c) => c.id === 'superseded_agents')?.repair ?? '').not.toMatch(/[Rr]evoke/)
  })

  it("MUTATION PROOF: a prefix-sharing agent id cannot borrow another agent's classification", async () => {
    // Finding 3. Resolving a label back to its entry by string PREFIX picks
    // the first sibling whose id is a prefix of the label — so with a
    // superseded `agent-1` listed before a wired `agent-10`, the wired
    // agent inherits the superseded one's verdict and the user is told to
    // revoke the agent they are actively using.
    //
    // Both prefix-sharing agents must be NON-primary for this to bite: the
    // primary is excluded from the scan, so a two-directory fixture leaves
    // exactly one candidate and the wrong lookup cannot pick wrongly. An
    // earlier version of this test made that mistake and passed against the
    // reintroduced bug.
    const { homeDir } = await healthyHome()

    // Oldest first, so the newest (agent-main) is the primary.
    const opsDir = join(homeDir, '.haven', 'agents', 'ops')
    await mkdir(join(opsDir, 'bin'), { recursive: true })
    const opsWrapper = join(opsDir, 'bin', 'haven-signer.mjs')
    await writeFile(opsWrapper, '// wrapper')
    await writeFile(join(opsDir, 'signer-runtime.json'), JSON.stringify({
      server_name: 'ops', wrapper_path: opsWrapper,
      signer_package: MCP_RUNTIME_MANIFEST.signerPackage,
      signer_version: MCP_RUNTIME_MANIFEST.signerVersion,
      sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
      sdk_version: MCP_RUNTIME_MANIFEST.sdkVersion,
      runtime_directory: join(homeDir, '.haven', 'signer-runtime', MCP_RUNTIME_MANIFEST.signerVersion),
      npm_cache_directory: join(homeDir, '.haven', 'npm-cache'),
      cli_path: join(homeDir, 'cli.js'),
    }))
    await writeFile(join(opsDir, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_tensecret', agent_id: 'agent-10',
      api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))

    const strayDir = join(homeDir, '.haven', 'agents', 'stray')
    await mkdir(strayDir, { recursive: true })
    await writeFile(join(strayDir, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_straysecret', agent_id: 'agent-1',
      api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))

    const mainDir = join(homeDir, '.haven', 'agents', 'agent-main')
    await mkdir(join(mainDir, 'bin'), { recursive: true })
    const mainWrapper = join(mainDir, 'bin', 'haven-signer.mjs')
    await writeFile(mainWrapper, '// wrapper')
    await writeFile(join(mainDir, 'identity.json'), JSON.stringify({
      api_key: 'sk_agent_mainsecret', agent_id: 'agent-main',
      api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))

    // agent-main owns the bare pair; ops is wired under its named entries;
    // stray (agent-1) appears nowhere and is genuinely superseded.
    await writeFile(join(homeDir, '.codex', 'config.toml'), [
      '[mcp_servers.haven]', `url = "${HOSTED}"`,
      '[mcp_servers.haven_signer]', `command = "${mainWrapper}"`,
      '[mcp_servers.haven-ops]', `url = "${HOSTED}"`,
      '[mcp_servers.haven-signer-ops]', `command = "${opsWrapper}"`,
    ].join('\n'))

    const deps = healthyDeps()
    deps.probeHosted.mockImplementation(async () => ({ status: 'ok' as const }))

    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, ...deps })
    const check = report.checks.find((c) => c.id === 'superseded_agents')

    expect(report.agents.find((a) => a.agentId === 'agent-10')?.classification).toBe('wired')
    expect(report.agents.find((a) => a.agentId === 'agent-1')?.classification).toBe('superseded')
    // The genuinely superseded agent is named...
    expect(check?.repair).toContain('agent-1')
    // ...and the WIRED agent whose id merely starts with it is not.
    expect(check?.repair).not.toContain('agent-10')
  })
})

/**
 * #1910 — `--repair` used to call `writeRuntimeConfig` with no `serverName`,
 * so `serverNamesFor(undefined)` handed it the BARE `haven` / `haven-signer`
 * pair. Repairing a NAMED agent therefore left that agent untouched AND
 * overwrote a co-wired bare agent's entries with the named agent's
 * credentials — a repair tool breaking a second, working agent.
 */
describe('runRepair writes the NAMED pair, not the bare one (#1910)', () => {
  const BARE_KEY = 'sk_agent_bareagentkey000000000000'
  const NAMED_KEY = 'sk_agent_namedagentkey00000000000'

  /** The `[mcp_servers.<name>]` block, verbatim, for a byte-identical comparison. */
  function codexTable(text: string, name: string): string {
    const lines = text.split('\n')
    const start = lines.findIndex((line) => line.trim() === `[mcp_servers.${name}]`)
    if (start === -1) return ''
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => line.trimStart().startsWith('['))
    return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n').trimEnd()
  }

  async function seedNamedAgent(homeDir: string, slug: string, agentId: string, apiKey: string) {
    const dir = join(homeDir, '.haven', 'agents', slug)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'identity.json'), JSON.stringify({
      api_key: apiKey,
      agent_id: agentId,
      api_url: 'https://api.haven.example',
      hosted_mcp_url: HOSTED,
    }))
    await writeFile(join(dir, 'signer.json'), JSON.stringify({
      version: 1, delegate_key: '0x' + '22'.repeat(32), delegate_address: '0x' + 'ef'.repeat(20),
      agent_id: agentId, chain_id: 84532, network: 'eip155:84532',
    }), { mode: 0o600 })
    const runtime = await seedRuntime(homeDir, dir)
    // The sidecar is where the slug lives (#1696) — the fix reads it from here
    // rather than asking the user to repeat --name on every repair.
    await writeFile(join(dir, 'signer-runtime.json'), JSON.stringify({
      server_name: slug,
      signer_package: MCP_RUNTIME_MANIFEST.signerPackage,
      signer_version: MCP_RUNTIME_MANIFEST.signerVersion,
      sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
      sdk_version: MCP_RUNTIME_MANIFEST.sdkVersion,
      wrapper_path: runtime.wrapperPath,
      runtime_directory: runtime.runtimeDirectory,
      npm_cache_directory: join(homeDir, '.haven', 'npm-cache'),
      cli_path: runtime.cliPath,
    }))
    return { dir, ...runtime }
  }

  async function twoAgentHome() {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-repair-named-'))
    const bareDir = await seedCredentials(homeDir, 'agent-bare')
    await writeFile(join(bareDir, 'identity.json'), JSON.stringify({
      api_key: BARE_KEY, agent_id: 'agent-bare',
      api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))
    const bareRuntime = await seedRuntime(homeDir, bareDir)
    const named = await seedNamedAgent(homeDir, 'research', 'agent-research', NAMED_KEY)
    // Both pairs co-wired in one Codex config, exactly as #1696 intends.
    await mkdir(join(homeDir, '.codex'), { recursive: true })
    await writeFile(join(homeDir, '.codex', 'config.toml'), [
      '[mcp_servers.haven]',
      `url = "${HOSTED}"`,
      `bearer_token = "${BARE_KEY}"`,
      '',
      '[mcp_servers.haven_signer]',
      `command = "${bareRuntime.wrapperPath}"`,
      '',
      '[mcp_servers.haven-research]',
      `url = "${HOSTED}"`,
      `bearer_token = "${NAMED_KEY}"`,
      '',
      '[mcp_servers.haven-signer-research]',
      `command = "${named.wrapperPath}"`,
      '',
    ].join('\n'))
    return { homeDir, bareDir, bareRuntime, named }
  }

  it('repairing a NAMED agent rewrites only haven-<slug> / haven-signer-<slug>', async () => {
    const { homeDir, named } = await twoAgentHome()
    const configPath = join(homeDir, '.codex', 'config.toml')

    const repair = await runRepair(
      { runtime: 'codex-cli', credentialsDir: named.dir },
      { homeDir, runCommand: vi.fn() },
    )
    expect(repair.ok).toBe(true)

    const after = await readFile(configPath, 'utf8')
    // The named pair is the one that was written, and it carries the NAMED
    // agent's key and wrapper.
    expect(codexTable(after, 'haven-research')).toContain(NAMED_KEY)
    expect(codexTable(after, 'haven-signer-research')).toContain(join(named.dir, 'bin', 'haven-signer.mjs'))
  })

  it('leaves a co-wired BARE agent\'s haven / haven_signer entries byte-identical', async () => {
    const { homeDir, bareRuntime, named } = await twoAgentHome()
    const configPath = join(homeDir, '.codex', 'config.toml')
    const before = await readFile(configPath, 'utf8')
    const bareHostedBefore = codexTable(before, 'haven')
    const bareSignerBefore = codexTable(before, 'haven_signer')
    expect(bareHostedBefore).toContain(BARE_KEY)

    await runRepair({ runtime: 'codex-cli', credentialsDir: named.dir }, { homeDir, runCommand: vi.fn() })

    const after = await readFile(configPath, 'utf8')
    // The clobbering half, asserted on its own: the bare pair is not merely
    // "still there", it is unchanged down to the bytes.
    expect(codexTable(after, 'haven')).toBe(bareHostedBefore)
    expect(codexTable(after, 'haven_signer')).toBe(bareSignerBefore)
    // And specifically: the named agent's credentials did not land in it.
    expect(codexTable(after, 'haven')).not.toContain(NAMED_KEY)
    expect(codexTable(after, 'haven_signer')).toContain(bareRuntime.wrapperPath)
  })

  it('preserves the slug in the sidecar — prepareSignerRuntime rewrites it and must be told', async () => {
    const { homeDir, named } = await twoAgentHome()
    await runRepair({ runtime: 'codex-cli', credentialsDir: named.dir }, { homeDir, runCommand: vi.fn() })
    const sidecar = JSON.parse(await readFile(join(named.dir, 'signer-runtime.json'), 'utf8'))
    // Without this, a repaired named agent reads as UNNAMED to every later
    // --doctor and to every later --repair, which re-arms the same defect.
    expect(sidecar.server_name).toBe('research')
  })

  it('repairing a BARE agent is unchanged (characterization)', async () => {
    const { homeDir, dir } = await healthyHome()
    await rm(join(homeDir, '.codex', 'config.toml'))
    const repair = await runRepair({ runtime: 'codex-cli' }, { homeDir, runCommand: vi.fn() })
    expect(repair.ok).toBe(true)
    const after = await readFile(join(homeDir, '.codex', 'config.toml'), 'utf8')
    expect(after).toContain('[mcp_servers.haven]')
    expect(after).toContain('[mcp_servers.haven_signer]')
    expect(after).toContain(join(dir, 'bin', 'haven-signer.mjs'))
    expect(after).not.toContain('haven-signer-')
  })
})

/**
 * #1911 — a started-but-unfinished `--rekey` parks a private key in the
 * credential directory and nothing reported it. These pin what the diagnostic
 * says, what it refuses to say (the private half), and the one backend
 * distinction it can actually make.
 */
describe('pending re-key reporting (#1911)', () => {
  // SYNTHETIC throwaway values — not a real key, never used to sign anything,
  // present only so the "never printed" assertion has something to look for.
  const SYNTHETIC_PENDING_KEY = '0x' + 'ee'.repeat(32)
  const PENDING_ADDRESS = '0x' + 'a1'.repeat(20)
  const NOW = Date.parse('2026-08-23T12:00:00.000Z')

  async function seedPending(dir: string, overrides: Record<string, unknown> = {}) {
    await writeFile(join(dir, 'rekey-pending.json'), JSON.stringify({
      agent_id: 'agent-1',
      new_delegate_address: PENDING_ADDRESS,
      new_delegate_key: SYNTHETIC_PENDING_KEY,
      started_at: '2026-08-23T09:00:00.000Z',
      expires_at: '2026-08-24T09:00:00.000Z',
      ...overrides,
    }), { mode: 0o600 })
  }

  it('reports an open pending re-key: address, path, timing — and does not fail the doctor', async () => {
    const { homeDir, dir } = await healthyHome()
    await seedPending(dir)
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })

    const check = report.checks.find((c) => c.id === 'rekey_pending')
    expect(check?.ok).toBe(true)
    expect(check?.detail).toContain(PENDING_ADDRESS)
    expect(check?.detail).toContain(join(dir, 'rekey-pending.json'))
    expect(check?.detail).toContain('2026-08-23T09:00:00.000Z')
    // An open re-key is a normal mid-flow state, not a fault.
    expect(report.ok).toBe(true)
    // Re-printable: this IS the recovery for a scrolled-away terminal.
    expect(check?.detail).toContain('Replace signing key')
  })

  it('says plainly that it cannot tell whether the on-chain revoke already ran (#1868)', async () => {
    const { homeDir, dir } = await healthyHome()
    await seedPending(dir)
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })
    const check = report.checks.find((c) => c.id === 'rekey_pending')
    expect(check?.detail).toContain('cannot tell')
    expect(check?.detail).toContain('#1868')
    // It must not imply the reassuring half on its own.
    expect(check?.detail).toContain('owner re-grant')
  })

  it('an EXPIRED pending re-key is a distinct, actionable failure', async () => {
    const { homeDir } = await healthyHome()
    const dir = join(homeDir, '.haven', 'agents', 'agent-1')
    await seedPending(dir, { expires_at: '2026-08-22T09:00:00.000Z' })
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })

    const check = report.checks.find((c) => c.id === 'rekey_pending')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('EXPIRED')
    expect(check?.repair).toContain('rekey-pending.json')
    expect(check?.repair).toContain('--rekey')
    // Not folded into a generic warning: the doctor now exits non-zero on it.
    expect(report.ok).toBe(false)
  })

  it('distinguishes a backend re-key that COMPLETED — only the local finish is outstanding', async () => {
    const { homeDir, dir } = await healthyHome()
    await seedPending(dir)
    const deps = healthyDeps()
    // Haven already reports the address this machine generated: agents.
    // delegate_address is swapped at the `complete` stage, so this proves the
    // whole owner-signed sequence ran.
    deps.probeHostedIdentity = vi.fn(async () => ({
      status: 'ok' as const, agentId: 'agent-1', delegateAddress: PENDING_ADDRESS,
    }))
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...deps })

    const check = report.checks.find((c) => c.id === 'rekey_pending')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('COMPLETED on Haven')
    expect(check?.repair).toContain('--rekey-finish')
    // The wedge language is exactly what must NOT appear here — nothing is
    // wedged when the sequence finished.
    expect(check?.detail).not.toContain('#1868')
  })

  it('never puts the private half in the report, plain or --json', async () => {
    const { homeDir, dir } = await healthyHome()
    await seedPending(dir)
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(SYNTHETIC_PENDING_KEY)
    expect(serialized).not.toContain('ee'.repeat(32))
    expect(serialized).not.toContain('new_delegate_key')
    // The public address IS reported — the assertion above must be failing for
    // the right reason, not because nothing was read at all.
    expect(serialized).toContain(PENDING_ADDRESS)
  })

  it('carries the same fields per-agent in the agents[] shape (#1697)', async () => {
    const { homeDir, dir } = await healthyHome()
    await seedPending(dir)
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })
    const entry = report.agents.find((a) => a.directory === dir)
    expect(entry?.rekeyPending).toMatchObject({
      state: 'pending',
      newDelegateAddress: PENDING_ADDRESS,
      startedAt: '2026-08-23T09:00:00.000Z',
    })
    expect(Object.keys(entry?.rekeyPending ?? {})).not.toContain('newDelegateKey')
  })

  it('reports a pending re-key in a SUPERSEDED directory — nothing else looks there', async () => {
    const { homeDir } = await healthyHome()
    const otherDir = await seedCredentials(homeDir, 'agent-old')
    await seedPending(otherDir, { agent_id: 'agent-old' })
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })
    const entry = report.agents.find((a) => a.directory === otherDir)
    expect(entry?.classification).not.toBe('wired')
    expect(entry?.rekeyPending?.state).toBe('pending')
    expect(entry?.checks.some((c) => c.id === 'rekey_pending')).toBe(true)
  })

  it('an unparseable pending file is still reported — it holds what was a key', async () => {
    const { homeDir, dir } = await healthyHome()
    await writeFile(join(dir, 'rekey-pending.json'), 'not json at all', { mode: 0o600 })
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })
    const check = report.checks.find((c) => c.id === 'rekey_pending')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('does not parse')
  })

  it('--repair does NOT delete a pending re-key', async () => {
    const { homeDir, dir } = await healthyHome()
    await seedPending(dir)
    await runRepair({ runtime: 'codex-cli' }, { homeDir, runCommand: vi.fn() })
    // The TTL is a refusal to USE the key, not a licence to destroy key
    // material the owner may still be mid-flow on. Deleting is their call.
    const still = await readFile(join(dir, 'rekey-pending.json'), 'utf8')
    expect(still).toContain(PENDING_ADDRESS)
  })

  it('no pending file: no check, and the report is untouched', async () => {
    const { homeDir } = await healthyHome()
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })
    expect(report.checks.find((c) => c.id === 'rekey_pending')).toBeUndefined()
    expect(report.agents.every((a) => a.rekeyPending === undefined)).toBe(true)
    expect(report.ok).toBe(true)
  })
})

/**
 * Regression guard for the seam #1911 opened. The flat check list falls back
 * to running `checksForAgent` for an UNWIRED primary directory, and that
 * fallback used to key off "no checks collected yet". A pending re-key now
 * contributes one check from the inventory pass, so the old predicate would
 * have read a single `rekey_pending` entry as "already done" and skipped every
 * real check for the directory the user explicitly pointed at.
 */
describe('unwired primary with a pending re-key still gets its full checks (#1911)', () => {
  it('runs credentials / hosted_mcp / signer_process, not just rekey_pending', async () => {
    const { homeDir } = await healthyHome()
    const otherDir = await seedCredentials(homeDir, 'agent-unwired')
    await writeFile(join(otherDir, 'rekey-pending.json'), JSON.stringify({
      agent_id: 'agent-unwired',
      new_delegate_address: '0x' + 'b2'.repeat(20),
      // SYNTHETIC throwaway — not a real key.
      new_delegate_key: '0x' + 'dd'.repeat(32),
      started_at: '2026-08-23T09:00:00.000Z',
      expires_at: '2026-08-24T09:00:00.000Z',
    }), { mode: 0o600 })

    const report = await runDoctor(
      { runtime: 'codex-cli', credentialsDir: otherDir },
      { homeDir, now: () => Date.parse('2026-08-23T12:00:00.000Z'), ...healthyDeps() },
    )
    const ids = report.checks.map((c) => c.id)
    expect(ids).toContain('rekey_pending')
    expect(ids).toContain('credentials')
    expect(ids).toContain('hosted_mcp')
    expect(ids).toContain('signer_process')
  })
})

/**
 * Review nit 3, resolved by cascading rather than by clarifying alone.
 *
 * `report.ok` rolls up the flat check list plus WIRED entries only, so an
 * abandoned parked key in a superseded directory would be *reported* in
 * `agents[]` and still leave `--json` + `report.ok` green — the obvious CI
 * health-check would pass over live private-key material. `superseded_agents`
 * is the precedent for the other answer: a flat check that fails on a
 * credential hazard in a directory that is explicitly not wired.
 */
describe('an abandoned parked key elsewhere reaches the exit code (#1911, review nit 3)', () => {
  const NOW = Date.parse('2026-08-23T12:00:00.000Z')
  const OTHER_KEY = 'sk_agent_otherdirectorykey0000000'
  const PARKED_ADDRESS = '0x' + 'c3'.repeat(20)
  // SYNTHETIC throwaway — not a real key, never used to sign anything.
  const SYNTHETIC_KEY = '0x' + 'ab'.repeat(32)

  async function seedOther(homeDir: string, agentId: string, expiresAt: string) {
    const otherDir = await seedCredentials(homeDir, agentId)
    // A DISTINCT, already-revoked key. Without this the extra directory trips
    // `superseded_agents`, which fails the report on its own — and then every
    // `report.ok` assertion below would pass for a reason that has nothing to
    // do with the parked key. Isolating the exit code is the whole point of
    // these tests, so the co-tenant hazard is deliberately made benign.
    await writeFile(join(otherDir, 'identity.json'), JSON.stringify({
      api_key: OTHER_KEY, agent_id: agentId,
      api_url: 'https://api.haven.example', hosted_mcp_url: HOSTED,
    }))
    await writeFile(join(otherDir, 'rekey-pending.json'), JSON.stringify({
      agent_id: agentId,
      new_delegate_address: PARKED_ADDRESS,
      new_delegate_key: SYNTHETIC_KEY,
      started_at: '2026-08-21T09:00:00.000Z',
      expires_at: expiresAt,
    }), { mode: 0o600 })
    return otherDir
  }

  /** Healthy deps, except the other directory's key reads as already revoked. */
  function depsWithRevokedOther() {
    const deps = healthyDeps()
    deps.probeHosted = vi.fn(async (apiKey: string) => (
      apiKey === OTHER_KEY ? { status: 'unauthorized' as const } : { status: 'ok' as const }
    ))
    return deps
  }

  it('fails the doctor when a SUPERSEDED directory holds an expired parked key', async () => {
    const { homeDir } = await healthyHome()
    const otherDir = await seedOther(homeDir, 'agent-abandoned', '2026-08-22T09:00:00.000Z')
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...depsWithRevokedOther() })

    const check = report.checks.find((c) => c.id === 'rekey_pending_elsewhere')
    expect(check?.ok).toBe(false)
    expect(check?.detail).toContain('ABANDONED')
    expect(check?.detail).toContain(join(otherDir, 'rekey-pending.json'))
    // Non-vacuous: this check is the ONLY failing one, so report.ok being
    // false is attributable to it and not to a co-tenant hazard.
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['rekey_pending_elsewhere'])
    expect(report.ok).toBe(false)
    // And it must still not tell the owner to delete blindly.
    expect(check?.repair).toContain('#1868')
  })

  it('stays informational for an OPEN pending re-key elsewhere', async () => {
    const { homeDir } = await healthyHome()
    await seedOther(homeDir, 'agent-midflow', '2026-08-24T09:00:00.000Z')
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...depsWithRevokedOther() })

    const check = report.checks.find((c) => c.id === 'rekey_pending_elsewhere')
    expect(check?.ok).toBe(true)
    expect(check?.repair).toBeUndefined()
    expect(report.checks.filter((c) => !c.ok)).toEqual([])
    expect(report.ok).toBe(true)
  })

  it('still carries the private half nowhere, even on this path', async () => {
    const { homeDir } = await healthyHome()
    await seedOther(homeDir, 'agent-abandoned', '2026-08-22T09:00:00.000Z')
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...depsWithRevokedOther() })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain(SYNTHETIC_KEY)
    // Positively assert the address IS there, so the negative cannot pass by
    // the check simply not having run.
    expect(serialized).toContain(PARKED_ADDRESS)
  })

  it('no check at all when no other directory holds one', async () => {
    const { homeDir } = await healthyHome()
    await seedCredentials(homeDir, 'agent-plain')
    const report = await runDoctor({ runtime: 'codex-cli' }, { homeDir, now: () => NOW, ...healthyDeps() })
    expect(report.checks.find((c) => c.id === 'rekey_pending_elsewhere')).toBeUndefined()
  })
})
