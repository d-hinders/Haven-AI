#!/usr/bin/env node
/**
 * Fail when a workspace package's built `dist/` is older than its `src/`.
 *
 * The failure this prevents is not "dist missing" — that one is loud. It is
 * dist STALE: the import resolves, the module loads, and the mismatch surfaces
 * as a protocol-shaped error (`signX402FundingTypedData is not a function`, a
 * Zod rejection of a field the current source added) that reads like version
 * skew or a bad credential. #1154 lost real time to a `packages/signer/dist`
 * built four weeks before its source.
 *
 * WHERE THE GAP ACTUALLY IS. CI is already safe, and so is anyone using the
 * npm scripts: `packages/mcp-server`'s `test`/`typecheck` run
 * `npm --prefix ../signer run build` first, and `dist/` is gitignored so a
 * fresh checkout has no stale copy to find. The hole is the BYPASS — running
 * `npx vitest run --root packages/mcp-server` directly, which is what anyone
 * iterating on one test file does. That path never rebuilds anything, and it
 * is exactly how the #1154 dist went unnoticed. So this check is wired as a
 * vitest `globalSetup`: it runs however the tests were started.
 *
 *   node scripts/check-dist-freshness.mjs [pkg…]   (default: every dependency
 *                                                   with a dist/ directory)
 */
import { readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Newest mtime under `dir`, or null when the directory does not exist. */
async function newestMtime(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  let newest = 0
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      const inner = await newestMtime(full)
      if (inner !== null && inner > newest) newest = inner
    } else {
      const { mtimeMs } = await stat(full)
      if (mtimeMs > newest) newest = mtimeMs
    }
  }
  return newest
}

/**
 * @returns {Promise<{pkg: string, state: 'fresh'|'stale'|'missing'|'no-dist-package', srcMs: number|null, distMs: number|null}[]>}
 */
export async function checkPackages(pkgs) {
  const results = []
  for (const pkg of pkgs) {
    const base = join(REPO_ROOT, 'packages', pkg)
    const srcMs = await newestMtime(join(base, 'src'))
    const distMs = await newestMtime(join(base, 'dist'))
    if (srcMs === null) {
      results.push({ pkg, state: 'no-dist-package', srcMs, distMs })
    } else if (distMs === null) {
      // Absent dist fails loudly on its own at import time; not this check's job.
      results.push({ pkg, state: 'missing', srcMs, distMs })
    } else {
      results.push({ pkg, state: distMs >= srcMs ? 'fresh' : 'stale', srcMs, distMs })
    }
  }
  return results
}

export function formatStale(results) {
  const stale = results.filter((r) => r.state === 'stale')
  if (stale.length === 0) return null
  const lines = [
    '',
    '✗ A built dist/ is older than its src/ — tests would run against stale code.',
    '',
  ]
  for (const r of stale) {
    const age = Math.round((r.srcMs - r.distMs) / 86_400_000)
    lines.push(
      `  packages/${r.pkg}: dist is ${age >= 1 ? `${age} day(s)` : 'minutes'} behind src`,
    )
  }
  lines.push('', '  Fix: ' + stale.map((r) => `npm run build -w packages/${r.pkg}`).join(' && '), '')
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pkgs = process.argv.slice(2)
  if (pkgs.length === 0) {
    console.error('usage: node scripts/check-dist-freshness.mjs <package…>')
    process.exit(2)
  }
  const results = await checkPackages(pkgs)
  const message = formatStale(results)
  if (message) {
    console.error(message)
    process.exit(1)
  }
  console.log(`✓ dist is current for: ${pkgs.join(', ')}`)
}
