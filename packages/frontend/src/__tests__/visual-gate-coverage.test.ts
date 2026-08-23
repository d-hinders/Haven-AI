/**
 * Every `*.visual.spec.ts` is actually RUN by the visual gate (#1863).
 *
 * `test:visual` is the single entry point for both halves of the pixel gate:
 * the blocking *Design visual regression* CI job runs it, and the **Update
 * visual baselines** workflow runs it with `--update-snapshots=all`. Until
 * #1863 it named ONE file explicitly:
 *
 *   playwright test e2e/design-system.visual.spec.ts --project=chromium-desktop
 *
 * So a second visual spec would have been collected by neither — the file would
 * exist, its baselines would exist, and no job would ever compare them. That is
 * this issue's own defect one layer up: **a capture that nothing runs is
 * indistinguishable from a capture that always passes.** Worse than a scope
 * gap, because the file's presence reads as coverage.
 *
 * The pattern is now a shared regex (`.visual.spec.ts`, matched by Playwright
 * against the file path), and this test is what stops it silently narrowing
 * back to one filename. It reads the REAL script out of `package.json` rather
 * than restating it, so a change to the script is what this test sees.
 *
 * Deliberately NOT asserted here: that the pattern is spelled some particular
 * way. Any pattern that selects every visual spec on disk passes. The contract
 * is coverage, not spelling.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const e2eDir = path.join(frontendRoot, 'e2e')

function visualSpecPaths(): string[] {
  // `e2e/live/**` is excluded from the fast suite by `SUITE_IGNORE`, but it
  // holds no visual spec; walk one level deep so a future one is still seen.
  const out: string[] = []
  for (const entry of readdirSync(e2eDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.visual.spec.ts')) {
      out.push(`e2e/${entry.name}`)
    } else if (entry.isDirectory() && entry.name !== '__screenshots__') {
      for (const nested of readdirSync(path.join(e2eDir, entry.name), { withFileTypes: true })) {
        if (nested.isFile() && nested.name.endsWith('.visual.spec.ts')) {
          out.push(`e2e/${entry.name}/${nested.name}`)
        }
      }
    }
  }
  return out.sort()
}

/**
 * Playwright's positional filters are REGEXES tested against the full file
 * path, not globs — so this mirrors what `playwright test <arg>` does with the
 * argument, rather than approximating it with `String.includes`.
 */
function playwrightFilters(script: string): RegExp[] {
  const args = script
    .replace(/^\s*(\w+=\S+\s+)*/, '') // strip leading env assignments
    .split(/\s+/)
    .slice(2) // drop `playwright test`
    .filter((a) => a && !a.startsWith('-'))
  return args.map((a) => new RegExp(a))
}

describe('the visual gate runs every visual spec (#1863)', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(frontendRoot, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }
  const script = pkg.scripts['test:visual']

  it('has a test:visual script that opts into the Linux-baseline mode', () => {
    expect(script, 'package.json lost its `test:visual` script').toBeTruthy()
    expect(script).toContain('VISUAL_REGRESSION=1')
    // The baselines are captured at deviceScaleFactor 1 with the viewport set
    // inside the spec. Under `chromium-mobile` (Pixel 5, DSF 2.75) the same
    // spec would compare 2.75x captures against 1x baselines and fail for a
    // reason unrelated to any defect — see playwright.config.ts.
    expect(script).toContain('--project=chromium-desktop')
  })

  it('selects EVERY e2e/**/*.visual.spec.ts on disk', () => {
    const specs = visualSpecPaths()
    // Anti-vacuity: if the walk finds nothing, the assertion below is trivially
    // true and this whole test becomes decorative.
    expect(specs.length, 'found no visual specs at all — the walk is broken').toBeGreaterThanOrEqual(2)

    const filters = playwrightFilters(script)
    expect(filters.length, '`test:visual` passes no file filter at all').toBeGreaterThan(0)

    const unselected = specs.filter((spec) => !filters.some((re) => re.test(spec)))
    expect(
      unselected,
      `these visual specs are NOT run by \`test:visual\` (${script}) — their baselines ` +
        `would never be compared by the blocking CI job, and never refreshed by the ` +
        `Update visual baselines workflow`,
    ).toEqual([])
  })
})
