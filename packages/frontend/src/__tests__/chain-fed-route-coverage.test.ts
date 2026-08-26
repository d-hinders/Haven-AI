/**
 * `CHAIN_FED_ROUTES` is checked against the APP, not against a second list
 * (#1971, review finding 2).
 *
 * The first version of this guard pinned `CHAIN_FED_ROUTES.length` against an
 * array of route strings typed by hand in the test file — two hand-maintained
 * lists edited by the same author in the same commit. It proved they agreed
 * with each other, which is not the property anyone wants: a genuinely new
 * chain-reading route added six months from now would sail past it, and the
 * docstring's claim that "a miss is a failing test" was simply not true.
 *
 * It also could not catch the mistake that was actually in the list. `/dashboard`
 * was in `CHAIN_FED_ROUTES`, justified as "useAgentPanelState + ApprovalQueue",
 * and neither was mounted there — `AgentPanel` is on `/agents`, `ApprovalQueue`
 * was on `/approvals` (both that component and that route are deleted by #1989,
 * epic #1440; the point about the guard's old shape stands). Scenarios pass
 * through `/dashboard` on their way to a
 * modal, so that one wrong entry would have made
 * `npm run screenshot -- --scenario=all` fail on unchanged `dev`: an alarm that
 * is always on, which this repo has learned twice over is an alarm nobody reads.
 *
 * So this walks the real import graph from every authenticated route entry and
 * asks whether `useOnChainAllowances` — the app's only RENDER-time chain read —
 * is reachable. Both directions are asserted, and the second is the one the old
 * shape could not do:
 *
 *   • every route that reaches the hook is covered by a pattern, and
 *   • every pattern covers at least one route that reaches the hook.
 *
 * Why that hook and not `usePublicClient`: calling `usePublicClient` issues no
 * request. `EditAgentModal` calls it to GATE a control, and a resting capture
 * of that screen legitimately makes no chain request. (`ApprovalQueue`,
 * `ManageApprovers` and `useSendTransaction` were the original three examples;
 * #1989 deleted all three.) Only a read that runs at render
 * can be missing from a PNG, which is the entire subject of the guard.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script
import { CHAIN_FED_ROUTES } from '../../scripts/screenshot.mjs'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const srcRoot = path.join(frontendRoot, 'src')
const appRoot = path.join(srcRoot, 'app', '(authenticated)')

/** The one hook that reads the chain while a screen is rendering. */
const RENDER_TIME_CHAIN_READ = 'useOnChainAllowances'

const EXTS = ['.tsx', '.ts', '/index.tsx', '/index.ts']

function resolveImport(spec: string, fromFile: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(srcRoot, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null // node_modules — not app source
  for (const ext of EXTS) {
    const candidate = base + ext
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* keep trying */
    }
  }
  return null
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g

/** Does the module graph rooted at `entry` reach the render-time chain read? */
function reachesChainRead(entry: string): boolean {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    // The hook's own definition file does not make its importers render-fed;
    // a call site does.
    if (!file.endsWith(`hooks/${RENDER_TIME_CHAIN_READ}.ts`) && source.includes(`${RENDER_TIME_CHAIN_READ}(`)) {
      return true
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveImport(match[1]!, file)
      if (resolved) queue.push(resolved)
    }
  }
  return false
}

/** Every authenticated route, as Next resolves `page.tsx` under `app/(authenticated)`. */
function routeEntries(): { route: string; file: string }[] {
  const out: { route: string; file: string }[] = []
  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, [...segments, entry.name])
      else if (entry.name === 'page.tsx') out.push({ route: `/${segments.join('/')}`, file: full })
    }
  }
  walk(appRoot, [])
  return out
}

const ROUTES = routeEntries()
const chainFed = ROUTES.filter((r) => reachesChainRead(r.file))

describe('CHAIN_FED_ROUTES matches the app', () => {
  it('the scan is looking at a real population', () => {
    // Without this, an import resolver that silently returned null for
    // everything would make the whole file green about nothing.
    expect(ROUTES.length).toBeGreaterThan(5)
    expect(chainFed.length).toBeGreaterThan(0)
    expect(chainFed.length).toBeLessThan(ROUTES.length)
    expect(chainFed.map((r) => r.route).sort()).toContain('/agents')
  })

  it('every route that reads the chain at render is covered by a pattern', () => {
    const uncovered = chainFed
      .filter((r) => !CHAIN_FED_ROUTES.some((c: { pattern: RegExp }) => c.pattern.test(r.route)))
      .map((r) => `${r.route}  (${path.relative(frontendRoot, r.file)})`)
    expect(
      uncovered,
      `these routes reach ${RENDER_TIME_CHAIN_READ} at render but are not in CHAIN_FED_ROUTES, ` +
        'so a capture of them that silently got no chain data would pass the guard',
    ).toEqual([])
  })

  it('every pattern covers at least one route that really reads the chain', () => {
    // The direction the old length-pin could not check, and the one that caught
    // `/dashboard`. An over-broad list is not harmless: five scenarios pass
    // through a route on their way to a modal, so one wrong entry makes the
    // documented full-suite run red on unchanged `dev`.
    const spurious = CHAIN_FED_ROUTES.filter(
      (c: { pattern: RegExp }) => !chainFed.some((r) => c.pattern.test(r.route)),
    ).map((c: { pattern: RegExp; reads: string }) => `${c.pattern} — claims: ${c.reads}`)
    expect(
      spurious,
      `no authenticated route matching these patterns reaches ${RENDER_TIME_CHAIN_READ} at ` +
        'render, so every capture that passes through one would be reported as silently broken',
    ).toEqual([])
  })
})
