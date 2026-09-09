/**
 * The installed-shell metadata check (#2735, epic #2736).
 *
 * `npm run screenshot` is the artifact future PRs read for the installed-app
 * shell state (#2729/#2765). The check has two halves, and only the PARSE and
 * VERDICT halves are testable without a dev server — the fetch wiring in
 * `screenshot.mjs` main() is exercised by the real run this change shipped
 * with. What the tests pin:
 *
 * - the served manifest is judged against an EXPECTED object, key by key,
 *   with the offending key named (a green run must be able to say WHY);
 * - the iOS meta tags and the viewport are read out of the root document and
 *   the ones that are load-bearing for install/standalone are asserted;
 * - the environment inversion (title "Haven <Env>" → env name) round-trips;
 * - a manifest that is absent, unparseable, or silently WRONG fails — the
 *   three ways a phone ends up unable to install while the PNGs look perfect.
 */
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, the capture harness
import {
  installedShellProblems,
  observeInstalledShell,
} from '../../scripts/screenshot.mjs'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs, the source-derived expectation loader
import { loadInstalledAppExpectations } from '../../scripts/installed-app-source.mjs'

/** The shape `observeInstalledShell` returns; the .mjs is untyped, so the test declares it. */
interface ObservedShell {
  manifest_present: boolean
  manifest_parse_error: boolean
  manifest: Record<string, unknown> | null
  environment: string | null
  meta: Record<string, string | null> | null
}

const observe = (input: { manifestBody: string | null; html: string | null }): ObservedShell =>
  observeInstalledShell(input) as ObservedShell

// The expectations the harness itself derives from src/lib/installed-app.ts.
// Every fixture below is BUILT from these rather than hand-written, so the
// suite judges the verdict logic against the REAL identity: a drifted app
// source reddens the exact test that owns the drift instead of letting a
// stale fixture copy pass behind it.
const EXPECTATIONS = await loadInstalledAppExpectations()

/** The full manifest body `buildWebManifest` must serve for this environment. */
const MANIFEST_BODY = JSON.stringify(EXPECTATIONS.expectedManifest)

const HTML_BODY = [
  '<!doctype html><html><head>',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  `<meta name="apple-mobile-web-app-title" content="${EXPECTATIONS.expectedTitle}">`,
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '</head><body></body></html>',
].join('\n')

describe('observeInstalledShell', () => {
  it('parses the manifest and the iOS meta out of the served responses', () => {
    const observed = observe({ manifestBody: MANIFEST_BODY, html: HTML_BODY })

    expect(observed.manifest_present).toBe(true)
    expect(observed.manifest_parse_error).toBe(false)
    expect(observed.manifest?.id).toBe('haven')
    expect(observed.manifest?.display).toBe('standalone')
    expect(observed.meta?.['apple-mobile-web-app-capable']).toBe('yes')
    expect(observed.meta?.['apple-mobile-web-app-status-bar-style']).toBe('default')
    expect(observed.meta?.viewport).toMatch(/viewport-fit=cover/)
  })

  it('keeps an absent response distinct from an unparseable one', () => {
    // A 404 on the manifest route and a route that serves garbage are two
    // different defects with two different owners; folding them into one
    // boolean would send the next reader to the wrong file.
    const absent = observe({ manifestBody: null, html: HTML_BODY })
    const garbage = observe({ manifestBody: '<html>404</html>', html: HTML_BODY })

    expect(absent.manifest_present).toBe(false)
    expect(absent.manifest_parse_error).toBe(false)
    expect(garbage.manifest_present).toBe(true)
    expect(garbage.manifest_parse_error).toBe(true)
  })

  it('inverts the apple title into the environment name', () => {
    const prod = observe({
      manifestBody: MANIFEST_BODY,
      html: HTML_BODY,
    })
    const dev = observe({
      manifestBody: MANIFEST_BODY,
      html: HTML_BODY.replace('content="Haven"', 'content="Haven Dev"'),
    })

    expect(prod.environment).toBe('production')
    expect(dev.environment).toBe('dev')
  })

  it('reports a document with no meta tags as all-null rather than crashing', () => {
    const observed = observe({ manifestBody: MANIFEST_BODY, html: '<html><body>x</body></html>' })

    expect(observed.meta?.['apple-mobile-web-app-capable']).toBeNull()
    expect(observed.meta?.viewport).toBeNull()
  })
})

describe('installedShellProblems', () => {
  it('passes the served state through untouched', () => {
    const observed = observe({ manifestBody: MANIFEST_BODY, html: HTML_BODY })
    expect(installedShellProblems(observed, EXPECTATIONS)).toEqual([])
  })

  it('names the manifest key that drifted', () => {
    const drifted = MANIFEST_BODY.replace('"display":"standalone"', '"display":"browser"')
    const observed = observe({ manifestBody: drifted, html: HTML_BODY })
    const problems = installedShellProblems(observed, EXPECTATIONS)

    expect(problems.length).toBeGreaterThanOrEqual(1)
    expect(problems.join('\n')).toMatch(/manifest\.display/)
    // The message names the file that owns the identity — the record says
    // WHERE to look, same shape as the deletion report.
    expect(problems.join('\n')).toMatch(/installed-app\.ts/)
  })

  it('fails a missing manifest route and an unparseable body, each with its own cause', () => {
    const absent = installedShellProblems(
      observe({ manifestBody: null, html: HTML_BODY }),
      EXPECTATIONS,
    )
    const garbage = installedShellProblems(
      observe({ manifestBody: 'not json', html: HTML_BODY }),
      EXPECTATIONS,
    )

    expect(absent.join('\n')).toMatch(/manifest\.webmanifest did not answer/)
    expect(garbage.join('\n')).toMatch(/is not JSON/)
  })

  it('fails each load-bearing iOS meta tag by name', () => {
    const noCapable = HTML_BODY.replace(
      '<meta name="apple-mobile-web-app-capable" content="yes">',
      '',
    )
    const observed = observe({ manifestBody: MANIFEST_BODY, html: noCapable })
    const problems = installedShellProblems(observed, EXPECTATIONS)

    expect(problems.join('\n')).toMatch(/apple-mobile-web-app-capable/)
  })

  it('fails a viewport that lost viewport-fit=cover (#2730)', () => {
    const noCover = HTML_BODY.replace(
      'viewport-fit=cover',
      'viewport-fit=contain',
    )
    const observed = observe({ manifestBody: MANIFEST_BODY, html: noCover })
    const problems = installedShellProblems(observed, EXPECTATIONS)

    expect(problems.join('\n')).toMatch(/viewport-fit=cover/)
  })

  it('fails when the apple title no longer names this environment', () => {
    const wrongEnv = HTML_BODY.replace('content="Haven"', 'content="Haven Production"')
    const observed = observe({ manifestBody: MANIFEST_BODY, html: wrongEnv })
    const problems = installedShellProblems(observed, EXPECTATIONS)

    expect(problems.join('\n')).toMatch(/apple-mobile-web-app-title|environment/)
  })

  it('fails when the root document could not be read at all', () => {
    const observed = observe({ manifestBody: MANIFEST_BODY, html: null })
    const problems = installedShellProblems(observed, EXPECTATIONS)

    expect(problems.join('\n')).toMatch(/root document could not be read/)
  })
})

describe('loadInstalledAppExpectations', () => {
  it('derives the expectation from the app source, not a hand copy', async () => {
    // The whole point of the loader: the expected identity must be THE
    // identity the manifest route serves, which means buildWebManifest()
    // called with havenEnvironment()'s reading of an unset build —
    // production by convention (lib/env.ts).
    const { environment, expectedManifest, expectedTitle } = await loadInstalledAppExpectations()

    expect(environment).toBe('production')
    expect(expectedManifest.id).toBe('haven')
    expect(expectedManifest.display).toBe('standalone')
    expect(expectedManifest.start_url).toBe('/dashboard')
    expect(expectedTitle).toBe('Haven')
  })
})
