// The evidence viewports — SINGLE source for both the screenshot script
// (#896 reviewer evidence) and the visual-regression spec (#897 pixel gate),
// so reviewers approve layouts at exactly the widths CI renders.
// Dependency-free on purpose: the spec imports this at collection time.
export const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
]

/**
 * ── Looking at a width that is NOT in the committed set (#2006) ──────────────
 *
 * `VIEWPORTS` above is not a list of widths, it is the input to four
 * consumers: `design-system.visual.spec.ts` (blocking full-page + TopBar
 * baselines), `capture-integrity.spec.ts`, `focus-visible.visual.spec.ts` and
 * `scripts/screenshot.mjs`. Adding a width there mints blocking baselines and
 * a PNG of every route in every evidence run, forever — which is why #1944
 * declined to add 320 and #2006 exists instead.
 *
 * What #1944 did NOT close is *seeing* 320. #1803's 320px evidence came from a
 * temporary spec deliberately kept out of the diff, because there was no other
 * way to point the harness at a width. `resolveCaptureViewports` is that way:
 * an opt-in, per-run override read ONLY by `scripts/screenshot.mjs`.
 *
 * The rule that keeps the two apart, and it is the whole safety argument:
 * **the gates import `VIEWPORTS`, never this function.** An override changes
 * what one capture run shoots and nothing that is ever compared, so no
 * baseline can move.
 *
 *   npm run screenshot -w packages/frontend -- --viewport=320x568 /dashboard
 *   SCREENSHOT_VIEWPORTS=320x568,1280x800 npm run screenshot -w packages/frontend
 *
 * An overridden viewport is NAMED after its own dimensions (`320x568`), so the
 * PNG filename and the manifest both state the width they show. That is
 * #1800's rule applied to widths: a 320 capture that is silently a 390 one is
 * worse than no capture, because it gets reviewed anyway. It also means the
 * override cannot fail silently — a run that requested 320 and shot the
 * committed set writes `-desktop.png` / `-mobile.png`, which is visibly not
 * what was asked for.
 */

/** Height used when a spec gives a width only (`--viewport=320`). */
export const DEFAULT_OVERRIDE_HEIGHT = 800

/** Sanity bounds. Outside these a "viewport" is a typo, not a phone. */
const MIN_DIMENSION_PX = 200
const MAX_DIMENSION_PX = 4096

const VIEWPORT_FLAG = '--viewport='
const VIEWPORT_ENV = 'SCREENSHOT_VIEWPORTS'

/**
 * Parse one `W` or `WxH` spec into a viewport. Throws — naming the offending
 * token — rather than skipping it: a mistyped width that silently degrades to
 * the committed set is exactly the "green about nothing" capture this whole
 * file argues against.
 */
export function parseViewportSpec(spec) {
  const raw = String(spec).trim()
  const match = /^(\d+)(?:[xX](\d+))?$/.exec(raw)
  if (!match) {
    throw new Error(
      `Invalid ${VIEWPORT_FLAG}/${VIEWPORT_ENV} value "${spec}" — expected WIDTH or WIDTHxHEIGHT (e.g. 320x568 or 320).`,
    )
  }
  const width = Number(match[1])
  const height = match[2] === undefined ? DEFAULT_OVERRIDE_HEIGHT : Number(match[2])
  for (const [label, value] of [
    ['width', width],
    ['height', height],
  ]) {
    if (value < MIN_DIMENSION_PX || value > MAX_DIMENSION_PX) {
      throw new Error(
        `Invalid ${VIEWPORT_FLAG}/${VIEWPORT_ENV} value "${spec}" — ${label} ${value} is outside ${MIN_DIMENSION_PX}..${MAX_DIMENSION_PX}px.`,
      )
    }
  }
  // Named after the dimensions on purpose — see the header.
  return { name: `${width}x${height}`, width, height }
}

/**
 * The viewports ONE capture run shoots.
 *
 * With neither `--viewport=` nor `SCREENSHOT_VIEWPORTS`, this is the committed
 * set itself — `source: 'committed'`, byte-identical entries, so the default
 * run is unchanged including its `-desktop` / `-mobile` filenames.
 *
 * A flag beats the environment variable, so a shell that exports one width can
 * still be overridden per run. Both accept a comma-separated list and the flag
 * may be repeated.
 */
export function resolveCaptureViewports(argv = [], env = {}) {
  const flagSpecs = argv
    .filter((a) => typeof a === 'string' && a.startsWith(VIEWPORT_FLAG))
    .flatMap((a) => a.slice(VIEWPORT_FLAG.length).split(','))
    .map((s) => s.trim())
    .filter(Boolean)
  const envSpecs = String(env[VIEWPORT_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const specs = flagSpecs.length > 0 ? flagSpecs : envSpecs
  if (specs.length === 0) {
    return { viewports: VIEWPORTS, source: 'committed', specs: [] }
  }

  const viewports = []
  for (const spec of specs) {
    const vp = parseViewportSpec(spec)
    // De-duplicate by resolved dimensions: two identical specs would otherwise
    // shoot the same PNG path twice, the second overwriting the first.
    if (!viewports.some((v) => v.name === vp.name)) viewports.push(vp)
  }
  return {
    viewports,
    source: flagSpecs.length > 0 ? VIEWPORT_FLAG.slice(0, -1) : VIEWPORT_ENV,
    specs,
  }
}
