/**
 * #3123 — the signer-runtime prune. Enumerates the ROOT (so override-keyed
 * directories are seen, S4), keeps anything a credential directory's sidecar
 * names or the current pin, removes the rest, reports through #3121's levels.
 */
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import { runtimeSpecOverrideDirectoryKey } from './runtime-spec-override.js'
import { pruneSignerRuntimes, referencedRuntimeDirectories, rollUpPruneLevel, signerRuntimeRoot } from './prune-runtimes.js'

async function seedRuntimeDir(root: string, key: string, bytes = 1024): Promise<string> {
  const dir = join(root, key, 'node_modules', '@haven_ai', 'signer', 'dist')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'cli.js'), 'x'.repeat(bytes))
  return join(root, key)
}

async function seedAgentReferencing(homeDir: string, name: string, runtimeDirectory: string): Promise<string> {
  const dir = join(homeDir, '.haven', 'agents', name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'identity.json'), JSON.stringify({ agent_id: name, api_key: `sk_${name}` }))
  await writeFile(join(dir, 'signer-runtime.json'), JSON.stringify({
    signer_package: MCP_RUNTIME_MANIFEST.signerPackage, signer_version: '0.0.1', sdk_package: MCP_RUNTIME_MANIFEST.sdkPackage,
    sdk_version: '0.0.1', wrapper_path: join(dir, 'bin', 'haven-signer.mjs'), runtime_directory: runtimeDirectory,
    npm_cache_directory: join(homeDir, '.haven', 'npm-cache'), cli_path: join(runtimeDirectory, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js'),
  }))
  return dir
}

describe('pruneSignerRuntimes (#3123)', () => {
  it('removes only directories no credential directory names; a live agent\'s runtime and the current pin survive; bytes are counted', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-'))
    const root = signerRuntimeRoot(homeDir)
    const live = await seedRuntimeDir(root, '0.0.0-dev.202609010000.aaaaaaa', 4096)
    const stale = await seedRuntimeDir(root, '0.0.0-dev.202608010000.bbbbbbb', 8192)
    const pin = await seedRuntimeDir(root, MCP_RUNTIME_MANIFEST.signerVersion, 2048)
    await seedAgentReferencing(homeDir, 'agent-live', live)

    const report = await pruneSignerRuntimes({ dryRun: false }, { homeDir })
    const byKey = Object.fromEntries(report.entries.map((e) => [e.key, e]))
    expect(byKey['0.0.0-dev.202609010000.aaaaaaa']).toMatchObject({ action: 'kept', level: 'ok', kind: 'version' })
    expect(byKey['0.0.0-dev.202609010000.aaaaaaa'].referencedBy).toEqual([join(homeDir, '.haven', 'agents', 'agent-live')])
    expect(byKey[MCP_RUNTIME_MANIFEST.signerVersion]).toMatchObject({ action: 'kept', level: 'ok' })
    expect(byKey['0.0.0-dev.202608010000.bbbbbbb']).toMatchObject({ action: 'removed', level: 'ok', bytes: 8192, referencedBy: [] })
    expect(report).toMatchObject({ removed: 1, reclaimedBytes: 8192, level: 'ok' })
    await expect(stat(stale)).rejects.toThrow()
    await expect(stat(live)).resolves.toBeDefined()
    await expect(stat(pin)).resolves.toBeDefined()
  })

  it('S4: an override-keyed directory is enumerated (the root is walked, not the manifest version list) and pruned when unreferenced', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-override-'))
    const root = signerRuntimeRoot(homeDir)
    const key = runtimeSpecOverrideDirectoryKey(['@haven_ai/signer@dev', '@haven_ai/sdk@dev'])
    expect(key).toMatch(/^override-[0-9a-f]{12}$/)
    const overrideDir = await seedRuntimeDir(root, key, 512)
    const keptOverrideKey = runtimeSpecOverrideDirectoryKey(['@haven_ai/signer@alpha'])
    const keptOverride = await seedRuntimeDir(root, keptOverrideKey, 256)
    await seedAgentReferencing(homeDir, 'agent-dev', keptOverride)

    const report = await pruneSignerRuntimes({ dryRun: false }, { homeDir })
    const byKey = Object.fromEntries(report.entries.map((e) => [e.key, e]))
    expect(byKey[key]).toMatchObject({ kind: 'override', action: 'removed' })
    expect(byKey[keptOverrideKey]).toMatchObject({ kind: 'override', action: 'kept' })
    await expect(stat(overrideDir)).rejects.toThrow()
    await expect(stat(keptOverride)).resolves.toBeDefined()
  })

  it('--dry-run lists what it would remove as advisories, removes nothing, and the report says so', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-dry-'))
    const root = signerRuntimeRoot(homeDir)
    const stale = await seedRuntimeDir(root, '0.0.0-dev.202607010000.ccccccc', 100)
    const report = await pruneSignerRuntimes({ dryRun: true }, { homeDir })
    expect(report.dryRun).toBe(true)
    expect(report.entries[0]).toMatchObject({ action: 'would_remove', level: 'advisory' })
    expect(report).toMatchObject({ removed: 0, reclaimedBytes: 0, level: 'advisory' })
    await expect(stat(stale)).resolves.toBeDefined()
  })

  it('a removal that fails is reported failed (level failed) without aborting the rest', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-fail-'))
    const root = signerRuntimeRoot(homeDir)
    await seedRuntimeDir(root, '0.0.0-dev.1.aaaaaaa')
    await seedRuntimeDir(root, '0.0.0-dev.2.bbbbbbb')
    const report = await pruneSignerRuntimes({ dryRun: false }, {
      homeDir,
      rm: async (directory) => {
        if (directory.endsWith('aaaaaaa')) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
      },
    })
    const byKey = Object.fromEntries(report.entries.map((e) => [e.key, e]))
    expect(byKey['0.0.0-dev.1.aaaaaaa']).toMatchObject({ action: 'failed', level: 'failed' })
    expect(byKey['0.0.0-dev.1.aaaaaaa'].detail).toContain('resource busy')
    expect(byKey['0.0.0-dev.2.bbbbbbb']).toMatchObject({ action: 'removed' })
    expect(report.level).toBe('failed')
  })

  it('references are read from EVERY credential directory, whatever its classification, and an explicit --credentials-dir scans its own parent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-refs-'))
    const root = signerRuntimeRoot(homeDir)
    const a = await seedRuntimeDir(root, '0.0.0-dev.3.aaaaaaa')
    const b = await seedRuntimeDir(root, '0.0.0-dev.4.bbbbbbb')
    await seedAgentReferencing(homeDir, 'retired-agent', a)
    // A retired directory (tombstoned, keys gone) still pins its runtime: the prune never decides who is live.
    await writeFile(join(homeDir, '.haven', 'agents', 'retired-agent', 'TOMBSTONE.json'), '{}')
    const elsewhere = await mkdtemp(join(tmpdir(), 'haven-prune-elsewhere-'))
    const explicitDir = join(elsewhere, 'agent-x')
    await mkdir(explicitDir, { recursive: true })
    await writeFile(join(explicitDir, 'signer-runtime.json'), JSON.stringify({ runtime_directory: b }))

    expect([...(await referencedRuntimeDirectories(homeDir)).keys()]).toEqual([a])
    expect([...(await referencedRuntimeDirectories(homeDir, explicitDir)).keys()]).toEqual([b])
    const report = await pruneSignerRuntimes({ dryRun: true }, { homeDir })
    const byKey = Object.fromEntries(report.entries.map((e) => [e.key, e]))
    expect(byKey['0.0.0-dev.3.aaaaaaa'].action).toBe('kept')
    expect(byKey['0.0.0-dev.4.bbbbbbb'].action).toBe('would_remove')
  })

  it('an absent root is an empty ok report', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-empty-'))
    expect(await pruneSignerRuntimes({ dryRun: false }, { homeDir })).toMatchObject({ entries: [], removed: 0, level: 'ok' })
  })

  it('rollUpPruneLevel: failed beats advisory beats ok', () => {
    expect(rollUpPruneLevel([])).toBe('ok')
    expect(rollUpPruneLevel([{ level: 'ok' }, { level: 'advisory' }])).toBe('advisory')
    expect(rollUpPruneLevel([{ level: 'advisory' }, { level: 'failed' }])).toBe('failed')
  })
})
