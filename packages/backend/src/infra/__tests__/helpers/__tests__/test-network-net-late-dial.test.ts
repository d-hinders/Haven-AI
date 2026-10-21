/**
 * The net's FILE-level red (#4217): a dial that lands after its test ended
 * fails the file, in the `afterAll` that `vitest.setup.ts` registers.
 *
 * That is a property of a whole test file's run, so no assertion inside an
 * ordinary `it` can show it: the file must actually fail. As
 * `db-harness-schema-guard.test.ts` does for its own afterAll guard, this
 * drives a REAL child vitest over disposable fixtures. The child loads
 * `vitest.setup.ts` and so runs under the net. The assertions here read the
 * child's JSON report.
 *
 * - Three fixtures each end their only test having scheduled a dial for
 *   later: `setTimeout(0)`, `setImmediate`, `setTimeout(30)`. Every one must
 *   FAIL its file, name its own host, and say the dial happened outside any
 *   test, so the record is not blamed on the test that already finished.
 *   Until the afterAll yielded on every run, all three stayed green whenever
 *   `DO_NOT_TRACK=1` was set, which every suite run has (#4216's
 *   `kit-analytics-off`, loaded first by `vitest.setup.ts`).
 * - One fixture leaves `vi.useFakeTimers()` on and dials nothing. It must
 *   PASS. If the afterAll waited on the global `setTimeout`, the fake clock
 *   would freeze it until `hookTimeout` and this test would time out.
 *
 * The child's dials are refused by its own net, so no packet leaves.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** Excluded from ordinary runs by `vitest.config.ts`; `vitest.fixture.config.ts` lifts that. */
const FIXTURE_DIR = path.join(PACKAGE_ROOT, '.tmp-fixtures')

const LATE_DIALS = {
  'timeout-0': `setTimeout(() => void fetch('https://late-timeout0-4217.example.com/').catch(() => undefined), 0)`,
  immediate: `setImmediate(() => void fetch('https://late-immediate-4217.example.com/').catch(() => undefined))`,
  'timeout-30': `setTimeout(() => void fetch('https://late-timeout30-4217.example.com/').catch(() => undefined), 30)`,
} as const

const HOST_OF: Record<keyof typeof LATE_DIALS, string> = {
  'timeout-0': 'late-timeout0-4217.example.com:443',
  immediate: 'late-immediate-4217.example.com:443',
  'timeout-30': 'late-timeout30-4217.example.com:443',
}

interface JsonReport {
  testResults: Array<{ name: string; status: string; message: string }>
}

describe('a dial that lands after its test ended fails the file (#4217)', () => {
  it(
    'fails each late-dial fixture in afterAll, and does not hang on leftover fake timers',
    () => {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true })
      const stem = `net-4217.${process.pid}`
      const files: Record<string, string> = {}
      for (const [kind, dial] of Object.entries(LATE_DIALS)) {
        files[kind] = path.join(FIXTURE_DIR, `${stem}.late-${kind}.test.ts`)
        fs.writeFileSync(
          files[kind],
          `import { it } from 'vitest'\nit('ends having scheduled a dial', () => {\n  ${dial}\n})\n`,
        )
      }
      files['fake-timers'] = path.join(FIXTURE_DIR, `${stem}.fake-timers.test.ts`)
      fs.writeFileSync(
        files['fake-timers'],
        `import { it, vi } from 'vitest'\nit('leaves fake timers on', () => {\n  vi.useFakeTimers()\n})\n`,
      )
      const reportPath = path.join(FIXTURE_DIR, `${stem}.report.json`)

      try {
        const result = spawnSync(
          'npx',
          [
            'vitest',
            'run',
            ...Object.values(files),
            '--config',
            'vitest.fixture.config.ts',
            '--reporter=json',
            `--outputFile=${reportPath}`,
          ],
          // spawnSync blocks this worker's event loop, so the vitest timeout below
          // cannot fire: bound the child here instead.
          { cwd: PACKAGE_ROOT, encoding: 'utf-8', timeout: 80_000 },
        )
        expect(fs.existsSync(reportPath), `child vitest wrote no report:\n${result.stdout}\n${result.stderr}`).toBe(true)
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as JsonReport
        const byFile = new Map(report.testResults.map((r) => [r.name, r]))

        for (const kind of Object.keys(LATE_DIALS) as Array<keyof typeof LATE_DIALS>) {
          const entry = byFile.get(files[kind])
          expect(entry?.status, `${kind}: ${entry?.message}`).toBe('failed')
          expect(entry?.message).toContain('a dial landed after its test ended')
          expect(entry?.message).toContain(`${HOST_OF[kind]} via connect`)
          expect(entry?.message).toContain('outside any test')
        }
        const fake = byFile.get(files['fake-timers'])
        expect(fake?.status, fake?.message).toBe('passed')
        expect(result.status).not.toBe(0)
      } finally {
        for (const file of Object.values(files)) fs.rmSync(file, { force: true })
        fs.rmSync(reportPath, { force: true })
      }
    },
    90_000,
  )
})
