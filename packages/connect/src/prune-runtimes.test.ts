/**
 * #3123 — the signer-runtime prune. Enumerates the ROOT (so override-keyed
 * directories are seen, S4), keeps anything a credential directory's sidecar
 * names or the current pin, removes the rest, reports through #3121's levels.
 */
import { mkdir, mkdtemp, readFile, realpath, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import { runtimeSpecOverrideDirectoryKey } from './runtime-spec-override.js'
import { normalizeRuntimePath, pruneSignerRuntimes, referencedRuntimeDirectories, rollUpPruneLevel, signerRuntimeRoot } from './prune-runtimes.js'

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

    const norm = (p: string) => normalizeRuntimePath(p)
    expect([...(await referencedRuntimeDirectories(homeDir)).keys()]).toEqual([await norm(a)])
    // #3151 review: the explicit directory's parent is read IN ADDITION to the default root — a union.
    expect([...(await referencedRuntimeDirectories(homeDir, explicitDir)).keys()].sort()).toEqual([await norm(a), await norm(b)].sort())
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

describe('reference rules hardened by the #3151 review', () => {
  async function seedRuntimeDir2(root: string, key: string, bytes = 1024): Promise<string> {
    const dir = join(root, key, 'node_modules', '@haven_ai', 'signer', 'dist')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'cli.js'), 'x'.repeat(bytes))
    return join(root, key)
  }

  it('BLOCKING fix: an explicit --credentials-dir elsewhere does NOT blind the prune to the default root — a live default-root agent keeps its runtime', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-union-'))
    const root = signerRuntimeRoot(homeDir)
    const live = await seedRuntimeDir2(root, '0.0.0-dev.live.aaaaaaa')
    const elsewhereRuntime = await seedRuntimeDir2(root, '0.0.0-dev.elsewhere.bbbbbbb')
    const stale = await seedRuntimeDir2(root, '0.0.0-dev.stale.ccccccc')
    // Default-root agent references `live`; an agent in an unrelated parent references `elsewhereRuntime`.
    const liveAgent = join(homeDir, '.haven', 'agents', 'agent-live')
    await mkdir(liveAgent, { recursive: true })
    await writeFile(join(liveAgent, 'signer-runtime.json'), JSON.stringify({ runtime_directory: live }))
    const elsewhere = await mkdtemp(join(tmpdir(), 'haven-prune-elsewhere-'))
    const explicitDir = join(elsewhere, 'agent-x')
    await mkdir(explicitDir, { recursive: true })
    await writeFile(join(explicitDir, 'signer-runtime.json'), JSON.stringify({ runtime_directory: elsewhereRuntime }))

    const report = await pruneSignerRuntimes({ dryRun: false }, { homeDir, credentialsDir: explicitDir })
    const byKey = Object.fromEntries(report.entries.map((e) => [e.key, e]))
    expect(byKey['0.0.0-dev.live.aaaaaaa'].action).toBe('kept')
    expect(byKey['0.0.0-dev.elsewhere.bbbbbbb'].action).toBe('kept')
    expect(byKey['0.0.0-dev.stale.ccccccc'].action).toBe('removed')
    await expect(stat(live)).resolves.toBeDefined()
    await expect(stat(elsewhereRuntime)).resolves.toBeDefined()
    await expect(stat(stale)).rejects.toThrow()
  })

  it('a credential directory with a MISSING or CORRUPT sidecar but an intact wrapper still keeps the runtime the wrapper launches', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-wrapper-'))
    const root = signerRuntimeRoot(homeDir)
    const viaWrapper = await seedRuntimeDir2(root, '0.0.0-dev.wrapped.aaaaaaa')
    const viaCorrupt = await seedRuntimeDir2(root, '0.0.0-dev.corrupt.bbbbbbb')
    for (const [name, runtime, sidecar] of [
      ['agent-nosidecar', viaWrapper, null],
      ['agent-corrupt', viaCorrupt, '{ not json'],
    ] as const) {
      const dir = join(homeDir, '.haven', 'agents', name, 'bin')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'haven-signer.mjs'), `#!/usr/bin/env node\nimport('${join(runtime, 'node_modules', '@haven_ai', 'signer', 'dist', 'cli.js')}')\n`)
      if (sidecar !== null) await writeFile(join(homeDir, '.haven', 'agents', name, 'signer-runtime.json'), sidecar)
    }
    const report = await pruneSignerRuntimes({ dryRun: true }, { homeDir })
    const byKey = Object.fromEntries(report.entries.map((e) => [e.key, e]))
    expect(byKey['0.0.0-dev.wrapped.aaaaaaa']).toMatchObject({ action: 'kept', referencedBy: [join(homeDir, '.haven', 'agents', 'agent-nosidecar')] })
    expect(byKey['0.0.0-dev.corrupt.bbbbbbb']).toMatchObject({ action: 'kept', referencedBy: [join(homeDir, '.haven', 'agents', 'agent-corrupt')] })
  })

  it('a sidecar path with a trailing slash, or an unresolved form, still matches the enumerated directory', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-normalize-'))
    const root = signerRuntimeRoot(homeDir)
    const dir = await seedRuntimeDir2(root, '0.0.0-dev.slash.aaaaaaa')
    const dir2 = await seedRuntimeDir2(root, '0.0.0-dev.dots.bbbbbbb')
    const dir3 = await seedRuntimeDir2(root, '0.0.0-dev.real.ccccccc')
    // The realpath spelling (macOS: /var → /private/var) vs the tmpdir spelling the root is enumerated under.
    const realDir3 = await realpath(dir3)
    for (const [name, ref] of [['agent-slash', `${dir}/`], ['agent-dots', join(root, 'x', '..', '0.0.0-dev.dots.bbbbbbb')], ['agent-real', realDir3]] as const) {
      const a = join(homeDir, '.haven', 'agents', name)
      await mkdir(a, { recursive: true })
      await writeFile(join(a, 'signer-runtime.json'), JSON.stringify({ runtime_directory: ref }))
    }
    const report = await pruneSignerRuntimes({ dryRun: true }, { homeDir })
    expect(report.entries.every((e) => e.action === 'kept' || e.key === MCP_RUNTIME_MANIFEST.signerVersion)).toBe(true)
    expect(report.entries.map((e) => e.key).sort()).toEqual(['0.0.0-dev.dots.bbbbbbb', '0.0.0-dev.real.ccccccc', '0.0.0-dev.slash.aaaaaaa'])
    expect(report.entries.map((e) => e.action)).toEqual(['kept', 'kept', 'kept'])
    await expect(stat(dir)).resolves.toBeDefined()
    await expect(stat(dir2)).resolves.toBeDefined()
    expect(realDir3 === dir3 || report.entries.find((e) => e.key === '0.0.0-dev.real.ccccccc')?.referencedBy.length === 1).toBe(true)
  })

  it('measure: false (the doctor path) sizes nothing and reports 0 bytes; measure defaults to true for the CLI and sizes only what it would remove', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'haven-prune-measure-'))
    const root = signerRuntimeRoot(homeDir)
    const kept = await seedRuntimeDir2(root, '0.0.0-dev.kept.aaaaaaa', 5000)
    await seedRuntimeDir2(root, '0.0.0-dev.gone.bbbbbbb', 7000)
    const a = join(homeDir, '.haven', 'agents', 'agent-kept')
    await mkdir(a, { recursive: true })
    await writeFile(join(a, 'signer-runtime.json'), JSON.stringify({ runtime_directory: kept }))
    const unmeasured = await pruneSignerRuntimes({ dryRun: true, measure: false }, { homeDir })
    expect(unmeasured.entries.map((e) => e.bytes)).toEqual([0, 0])
    const measured = await pruneSignerRuntimes({ dryRun: true }, { homeDir })
    const byKey = Object.fromEntries(measured.entries.map((e) => [e.key, e]))
    expect(byKey['0.0.0-dev.gone.bbbbbbb'].bytes).toBe(7000)
    expect(byKey['0.0.0-dev.kept.aaaaaaa'].bytes).toBe(0) // kept directories are never walked
  })
})
