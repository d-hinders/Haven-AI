// Unit tests for the stale-dist guard (#1188).
// Run with: node --test scripts/check-dist-freshness.test.mjs
// Runs in CI via the ci_config_checks job (#1206 — it previously ran nowhere).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPackages, formatStale } from './check-dist-freshness.mjs'

// ── checkPackages, against a real fixture tree (#1206: the decision logic
// itself was untested — only the formatter was).

/** Build packages/<pkg>/{src,dist} under a temp root with controlled mtimes. */
async function fixture(spec) {
  const root = await mkdtemp(join(tmpdir(), 'dist-freshness-'))
  for (const [pkg, dirs] of Object.entries(spec)) {
    for (const [dir, mtimeSec] of Object.entries(dirs)) {
      const d = join(root, 'packages', pkg, dir)
      await mkdir(d, { recursive: true })
      const f = join(d, 'index.ts')
      await writeFile(f, '// fixture')
      await utimes(f, mtimeSec, mtimeSec)
    }
  }
  return root
}

test('checkPackages: newer dist is fresh, older dist is stale, equal is fresh', async () => {
  const root = await fixture({
    fresh: { src: 1_000, dist: 2_000 },
    stale: { src: 2_000, dist: 1_000 },
    equal: { src: 1_500, dist: 1_500 },
  })
  try {
    const byPkg = Object.fromEntries(
      (await checkPackages(['fresh', 'stale', 'equal'], root)).map((r) => [r.pkg, r.state]),
    )
    assert.deepEqual(byPkg, { fresh: 'fresh', stale: 'stale', equal: 'fresh' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checkPackages: the NEWEST file under src decides, including nested ones', async () => {
  // One old file at the top and one new file nested a directory down — the
  // recursion must surface the nested mtime, or an edit in a subdirectory
  // never marks the dist stale.
  const root = await fixture({ pkg: { src: 1_000, dist: 2_000 } })
  try {
    const nested = join(root, 'packages', 'pkg', 'src', 'deep')
    await mkdir(nested, { recursive: true })
    const f = join(nested, 'new.ts')
    await writeFile(f, '// newer than dist')
    await utimes(f, 3_000, 3_000)
    const [r] = await checkPackages(['pkg'], root)
    assert.equal(r.state, 'stale')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('checkPackages: missing dist is "missing", missing src is "no-dist-package"', async () => {
  const root = await fixture({ srconly: { src: 1_000 }, distonly: { dist: 1_000 } })
  try {
    const byPkg = Object.fromEntries(
      (await checkPackages(['srconly', 'distonly', 'absent'], root)).map((r) => [r.pkg, r.state]),
    )
    assert.deepEqual(byPkg, {
      srconly: 'missing', // loud at import time on its own — never reported stale
      distonly: 'no-dist-package',
      absent: 'no-dist-package',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ── formatStale (the original #1188 suite).

test('a fresh dist produces no message', () => {
  assert.equal(formatStale([{ pkg: 'signer', state: 'fresh', srcMs: 1, distMs: 2 }]), null)
})

test('a MISSING dist is not reported — it fails loudly at import on its own', () => {
  // The guard exists for the SILENT failure. A missing dist throws
  // "Cannot find module" the moment anything imports it, which needs no help.
  assert.equal(formatStale([{ pkg: 'signer', state: 'missing', srcMs: 1, distMs: null }]), null)
})

test('a stale dist names the package and the exact fix command', () => {
  const day = 86_400_000
  const msg = formatStale([{ pkg: 'signer', state: 'stale', srcMs: 30 * day, distMs: 2 * day }])
  assert.match(msg, /packages\/signer/)
  assert.match(msg, /28 day\(s\) behind/)
  // The message must carry the remedy: this fires while someone is debugging
  // something that looks like a protocol error, and "rebuild" is not obvious.
  assert.match(msg, /npm run build -w packages\/signer/)
})

test('several stale packages are listed together, with one combined fix', () => {
  const day = 86_400_000
  const msg = formatStale([
    { pkg: 'signer', state: 'stale', srcMs: 10 * day, distMs: 1 * day },
    { pkg: 'fresh-one', state: 'fresh', srcMs: 1, distMs: 2 },
    { pkg: 'mcp', state: 'stale', srcMs: 10 * day, distMs: 3 * day },
  ])
  assert.match(msg, /packages\/signer/)
  assert.match(msg, /packages\/mcp/)
  assert.doesNotMatch(msg, /fresh-one/)
  assert.match(msg, /npm run build -w packages\/signer && npm run build -w packages\/mcp/)
})

test('equal timestamps count as fresh — a rebuild that touched nothing is not stale', () => {
  assert.equal(formatStale([{ pkg: 'sdk', state: 'fresh', srcMs: 5, distMs: 5 }]), null)
})
