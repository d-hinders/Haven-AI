#!/usr/bin/env node
// Docs staleness audit (Phase 4 of the docs-quality system, #646).
//
// For every non-archived doc with `covers:` front-matter, counts the commits
// that touched its covered paths SINCE the doc's `last-verified` date. A doc
// with many covered-code commits and an old verification date is the one most
// likely to be lying to its reader.
//
// Usage:
//   node scripts/docs/audit-staleness.mjs             # human-readable report
//   node scripts/docs/audit-staleness.mjs --json      # JSON to stdout
//   node scripts/docs/audit-staleness.mjs --top=10    # limit rows
//
// Always exits 0 — it reports, the humans (or the cron issue) prioritize.
// Run weekly by .github/workflows/docs-audit.yml, which upserts the report
// into a tracking issue.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { REPO_ROOT, ROOT_DOCS, walk, parseFrontMatter } from './validate-frontmatter.mjs'

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

/** A covers entry → git pathspec (globs need the :(glob) magic prefix). */
export function toPathspec(cover) {
  return /[*?]/.test(cover) ? `:(glob)${cover}` : cover
}

/** Commits touching `covers` since `sinceDate` (YYYY-MM-DD). */
function commitsSince(covers, sinceDate) {
  const pathspecs = covers.map(toPathspec)
  try {
    const out = execFileSync(
      'git',
      ['log', '--pretty=format:%h %ad %s', '--date=short', `--since=${sinceDate} 00:00`, '--', ...pathspecs],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    ).trim()
    return out ? out.split('\n') : []
  } catch {
    return []
  }
}

/** Pure ranking: most covered-code commits first, oldest verification breaking ties. */
export function rankFindings(findings) {
  return [...findings].sort(
    (a, b) => b.commits - a.commits || String(a.lastVerified).localeCompare(String(b.lastVerified)),
  )
}

async function main() {
  const asJson = process.argv.includes('--json')
  const top = Number(arg('top') ?? 25)

  const docFiles = (await walk(join(REPO_ROOT, 'docs'))).filter((p) => p.endsWith('.md'))
  for (const r of ROOT_DOCS) docFiles.push(r)

  const findings = []
  for (const rel of docFiles.sort()) {
    const parsed = parseFrontMatter(await readFile(join(REPO_ROOT, rel), 'utf8'))
    if (!parsed.ok) continue
    const { status, covers, 'last-verified': lastVerified } = parsed.data
    if (status === 'archived' || !covers?.length || !lastVerified) continue
    const commits = commitsSince(covers, lastVerified)
    if (commits.length === 0) continue
    findings.push({
      doc: rel,
      lastVerified,
      contract: parsed.data.contract === 'true',
      commits: commits.length,
      latest: commits[0],
    })
  }

  const ranked = rankFindings(findings).slice(0, top)

  if (asJson) {
    console.log(JSON.stringify({ generated: new Date().toISOString().slice(0, 10), findings: ranked }, null, 2))
    return
  }

  if (ranked.length === 0) {
    console.log('Docs audit: every covered doc is verified at or after its covered code\'s last change. ✨')
    return
  }
  console.log(`Docs audit: ${ranked.length} doc(s) whose covered code changed after last-verified:\n`)
  for (const f of ranked) {
    const mark = f.contract ? ' [contract]' : ''
    console.log(`  ${String(f.commits).padStart(3)} commit(s)  ${f.doc}${mark}  (last verified ${f.lastVerified})`)
    console.log(`               latest: ${f.latest}`)
  }
  console.log('\nFor each: re-verify the doc against the code and bump `last-verified`, or update it.')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('audit-staleness error (non-fatal):', err)
    process.exit(0)
  })
}
