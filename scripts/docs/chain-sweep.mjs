// Repo-wide sweep for PRE-EXISTING `last-verified` chain breaks (#1876).
//
// `scripts/docs/chain-integrity.mjs` is DIFF-SCOPED: it only compares docs a
// change touched, so a break already sitting on `dev` is examined by nothing.
// This replays the same exported containment rule over every doc's own history
// and reports the drops whose references are STILL missing today.
//
//   node scripts/docs/chain-sweep.mjs [--since=YYYY-MM-DD]
//
// --since defaults to the day the chaining convention took hold (#1496).
// Before it, REPLACING the note was the convention, so every doc reads as
// broken and the signal is zero — the same retroactivity limit
// chain-integrity-backtest.mjs records.
import { execFileSync } from 'node:child_process'
import { lastVerifiedLine, issueRefs, checkChain } from './chain-integrity.mjs'
import { REPO_ROOT, ROOT_DOCS } from './validate-frontmatter.mjs'

const arg = (n, d) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || `=${d}`).split('=').pop()
const since = arg('since', '2026-08-15')
const g = (a) => { try { return execFileSync('git', a, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return null } }

const docs = g(['ls-tree', '-r', '--name-only', 'origin/dev']).split('\n')
  .filter((p) => p.endsWith('.md') && (p.startsWith('docs/') || ROOT_DOCS.includes(p)))

let brokenDocs = 0
let scanned = 0
for (const rel of docs) {
  const nowLine = lastVerifiedLine(g(['show', `origin/dev:${rel}`]) || '')
  if (!nowLine) continue
  scanned++
  const revs = (g(['log', '--format=%H %ad', '--date=short', `--since=${since}`, 'origin/dev', '--', rel]) || '')
    .trim().split('\n').filter(Boolean).map((l) => l.split(' '))
  const hits = []
  for (let i = 0; i < revs.length; i++) {
    const [rev, date] = revs[i]
    const nextLine = lastVerifiedLine(g(['show', `${rev}:${rel}`]) || '')
    const prevRaw = g(['show', `${rev}^:${rel}`])
    const prevLine = prevRaw && lastVerifiedLine(prevRaw)
    if (!prevLine || !nextLine || prevLine === nextLine) continue
    const r = checkChain(prevLine, nextLine)
    if (r.status !== 'broken') continue
    // Only report what is STILL lost — a later commit may have restored it.
    // Compare against parsed refs, never `nowLine.includes(ref)`: a raw
    // substring test lets `#1447` on the line vouch for a dropped `#144`, so
    // a genuinely lost short ref would be silently omitted from the report.
    const nowRefs = issueRefs(nowLine)
    const stillLost = r.dropped.filter((ref) => !nowRefs.includes(ref))
    if (stillLost.length) hits.push({ rev: rev.slice(0, 8), date, stillLost })
  }
  if (hits.length) {
    brokenDocs++
    console.log(`\n✗ ${rel}`)
    for (const h of hits) console.log(`    dropped ${h.stillLost.join(', ')} at ${h.rev} (${h.date}) — still missing`)
  }
}
console.log(`\n${brokenDocs} doc(s) carry an unrestored chain break since ${since}, of ${scanned} with a last-verified line.`)
