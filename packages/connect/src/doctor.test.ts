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

function healthyDeps(): DoctorDeps & { probeSignerTools: ReturnType<typeof vi.fn>; probeHosted: ReturnType<typeof vi.fn> } {
  return {
    probeHosted: vi.fn(async () => ({ status: 'ok' as const })),
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
    expect(report.checks.map((c) => c.id)).toEqual([
      'credentials', 'signer_runtime', 'runtime_config', 'hosted_mcp', 'signer_process', 'restart',
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
