#!/usr/bin/env node
/**
 * Score-1 REACHABILITY for the cold-agent onboarding scenario (#2538).
 *
 * The scenario's score 1 asks how an agent reached `/for-agents.md`: from the
 * landing HTML alone (3), via `robots.txt`/`sitemap.xml` (2), by guessing a
 * path (1), or not at all (0). Whether a given agent finds it is a fact about
 * that agent. What this script measures is the CEILING — the best band any
 * agent could reach, given what the deployment actually advertises.
 *
 * That is the half worth automating, and it is the half the deliberate-
 * regression criterion is about: removing a hook cannot lower one agent's
 * score reliably (agents vary), but it lowers the ceiling deterministically.
 *
 * It reads the SOURCE of the three advertisers rather than a built artifact,
 * for the reason #2537 learned the hard way: a test that reads `dist/` can
 * validate bytes the repository no longer contains.
 *
 * What it does NOT measure, stated so nobody reads more into a 3 than is
 * there: whether the hook is followable in practice (a link that 404s counts
 * here), and whether an agent notices it. A ceiling is an upper bound.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const TARGET = '/for-agents.md'

const layout = read('packages/frontend/src/app/layout.tsx')
const surfaces = read('packages/frontend/src/lib/discovery-surfaces.ts')
const landing = read('packages/frontend/src/app/page.tsx')
const footer = read('packages/frontend/src/components/marketing/SiteFooter.tsx')

/**
 * Every route the LANDING HTML advertises — all three hooks, not just the
 * `<link>`. They are collected together because, measured, they turn out to
 * point at the same place: see the note this script prints.
 */
// Deduped HERE, not downstream. The two patterns overlap: with two adjacent
// <link rel="alternate"> tags, the first tag's href is also "within 200 chars
// BEFORE a rel=alternate" — the second tag's. That double-counted /llms.txt,
// and while `uniqueAlternates` fixed it for the band computation, the raw
// array was still used for the printed hook COUNT, which therefore said 5
// when there are 4. It said so in the shipped run report too (haven-reviewer,
// #2538). An instrument that is right about its verdict and wrong about its
// arithmetic is still an instrument that lied.
const alternates = [...new Set(
  [...layout.matchAll(/rel="alternate"[\s\S]{0,200}?href="([^"]+)"/g)].map((m) => m[1])
    .concat([...layout.matchAll(/href="([^"]+)"[\s\S]{0,200}?rel="alternate"/g)].map((m) => m[1])),
)]
const sentence = [...landing.matchAll(/If you are an AI agent[\s\S]{0,300}?href="([^"]+)"/g)].map((m) => m[1])
const footerLinks = [...footer.matchAll(/'For agents',\s*href: '([^']+)'/g)].map((m) => m[1])
const uniqueAlternates = [...new Set([...alternates, ...sentence, ...footerLinks])]

/** Which of those, followed one hop, names the target? */
const hops = []
for (const href of uniqueAlternates) {
  if (href === TARGET) { hops.push({ via: href, hop: 1 }); continue }
  if (!href.startsWith('/') || href.startsWith('/api/')) continue
  let body
  try { body = read(join('packages/frontend/public', href)) } catch { continue }
  if (body.includes(TARGET)) hops.push({ via: href, hop: 2 })
}

// `#   /for-agents.md` — WITH the slash. This read `TARGET.slice(1)` and so
// could never match; the `||` fallback covered for it, which is how a dead
// assertion survives (haven-reviewer, #2538).
const inRobots = surfaces.includes(`#   ${TARGET}`)
const inSitemap = /PUBLIC_SURFACES[\s\S]*?'\/for-agents\.md'/.test(surfaces)

const band = hops.length > 0 ? 3 : inRobots || inSitemap ? 2 : 1
const why = hops.length > 0
  ? `landing <link rel="alternate"> → ${hops.map((h) => `${h.via} (${h.hop} hop${h.hop > 1 ? 's' : ''})`).join(', ')}`
  : inRobots || inSitemap
    ? `no landing-HTML route; advertised by ${[inRobots && 'robots.txt', inSitemap && 'sitemap.xml'].filter(Boolean).join(' and ')}`
    : 'advertised nowhere — only reachable by guessing the path'

console.log(`score-1 ceiling: ${band}`)
console.log(`  target:      ${TARGET}`)
console.log(`  alternates:  ${uniqueAlternates.join(', ') || '(none)'}`)
console.log(`  robots.txt:  ${inRobots ? 'names it' : 'does NOT name it'}`)
console.log(`  sitemap.xml: ${inSitemap ? 'lists it' : 'does NOT list it'}`)
console.log(`  why:         ${why}`)

// The concentration risk, printed every run because it is the thing a reader
// of a green 3 would otherwise not know. All three landing hooks — the
// <link rel="alternate">, the "If you are an AI agent" sentence and the
// footer's "For agents" — point at the SAME file, so the whole band-3 route
// hangs on one line inside it. Removing that line drops the ceiling to 2 with
// every existing hook test still green, which is why the chain has its own
// assertion in discovery-surfaces.test.ts (#2538).
const hooks = [...alternates, ...sentence, ...footerLinks]
const agentFacing = [...new Set(hooks)].filter((h) => h.startsWith('/') && !h.startsWith('/api/'))
if (agentFacing.length === 1 && band === 3) {
  const n = hooks.filter((h) => h === agentFacing[0]).length
  console.log(`  NOTE:        ${n} of the ${hooks.length} landing hooks point at ${agentFacing[0]}, and no other agent-facing route exists — band 3 depends on ONE link inside it`)
}
