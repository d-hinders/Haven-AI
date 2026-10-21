import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * #4216 — the proof that the kit-analytics opt-out actually works, and that it
 * is not vacuous.
 *
 * `@metamask/smart-accounts-kit` posts usage analytics to
 * `https://mm-sdk-analytics.api.cx.metamask.io/` from the first of its tracked
 * functions that runs, unless one of its four opt-out inputs (CI,
 * DO_NOT_TRACK, navigator.doNotTrack, window.doNotTrack) is set when it
 * LATCHES — once, in module state. Each measurement therefore runs in a fresh
 * child process (`helpers/kit-analytics-probe.ts` via tsx): a fresh process is
 * the only way to re-arm the latch, since vitest cannot re-evaluate an
 * externalized node_modules package (`vi.resetModules()` leaves it cached —
 * measured: the in-process variant's positive control recorded 0).
 *
 * With fetch stubbed, nothing leaves the process in either case.
 */

const here = dirname(fileURLToPath(import.meta.url))
const backendRoot = join(here, '..', '..', '..') // packages/backend
const probePath = join(here, 'helpers', 'kit-analytics-probe.ts')

// tsx ships a plain node CLI: process.execPath + the resolved cli script — no
// shell, no npx. dist/cli.mjs is not an exports subpath, so resolve the
// package root (its package.json IS exported) and join from there.
const require = createRequire(import.meta.url)
const tsxCli = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs')

interface ProbeResult {
  analyticsPosts: number
  totalPosts: number
}

function runProbe(mode: 'mechanism' | 'bare'): ProbeResult {
  const env = { ...process.env }
  // Belt and braces: the probe deletes these itself, but the caller's env is
  // the thing GitHub Actions' CI=true rides in on.
  delete env.CI
  delete env.DO_NOT_TRACK
  const stdout = execFileSync(process.execPath, [tsxCli, probePath, mode], {
    cwd: backendRoot,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  })
  const lastLine = stdout.trim().split('\n').pop() ?? ''
  return JSON.parse(lastLine) as ProbeResult
}

describe('kit-analytics-off (#4216)', () => {
  it('records 0 analytics posts with the mechanism and ≥1 without it', { timeout: 120_000 }, async () => {
    const withMechanism = runProbe('mechanism')
    expect(
      withMechanism.analyticsPosts,
      'the kit posted analytics with kit-analytics-off.ts loaded — the mechanism is broken',
    ).toBe(0)

    // Positive control: the same probe without the mechanism must see the post,
    // or this file would pass with the mechanism removed (i.e. prove nothing).
    const bare = runProbe('bare')
    expect(
      bare.analyticsPosts,
      'the positive control recorded 0 posts — this proof would pass with the mechanism removed',
    ).toBeGreaterThanOrEqual(1)
  })
})
