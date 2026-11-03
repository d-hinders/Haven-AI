#!/usr/bin/env node
// Docs staleness audit (Phase 4 of the docs-quality system, #646).
//
// For every doc with `covers:` front-matter that is not `archived`, `research` or
// `record`, counts the commits
// that touched its covered paths SINCE the doc's `last-verified` date. A doc
// with many covered-code commits and an old verification date is the one most
// likely to be lying to its reader.
//
// Usage:
//   node scripts/docs/audit-staleness.mjs             # human-readable report
//   node scripts/docs/audit-staleness.mjs --json      # JSON to stdout
//   node scripts/docs/audit-staleness.mjs --top=10    # limit rows
//   node scripts/docs/audit-staleness.mjs --figures-report figures.txt
//
// `--figures-report` appends the doc-figure section `scan-remeasure.mjs
// --doc-figures-only --out` wrote, under the ranking (#4631). The audit's run
// step has no `GH_TOKEN`, so it does not read the runner's standing issue: the
// same job runs the runner first and hands it the file, which keeps the
// figures at the same SHA as the ranking instead of six days behind it.
// Without the flag the audit prints one line saying the report was not
// supplied — a true statement, distinguishable from a failed read.
//
// Always exits 0 — it reports, the humans (or the cron issue) prioritize.
// Run weekly by .github/workflows/docs-audit.yml, which upserts the report
// into a tracking issue.

import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { REPO_ROOT, ROOT_DOCS, walk, parseFrontMatter } from './validate-frontmatter.mjs'
import { GOVERNED_PACKAGE_DOCS } from './package-docs.mjs'

/** `--name=value` or `--name value`; undefined when absent. */
function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.slice(name.length + 3)
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  return undefined
}

/** The doc-figure section, or the one line that says it was not supplied. */
export function figuresSection(reportPath) {
  if (!reportPath) return 'doc-figure report not supplied (run scan-remeasure.mjs --doc-figures-only)'
  try {
    const text = readFileSync(reportPath, 'utf8').trimEnd()
    return text === '' ? `doc-figure report is empty: ${reportPath}` : text
  } catch (err) {
    return `doc-figure report unreadable: ${reportPath} — ${err.message}`
  }
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
    // #2638: `research` leaves the audited set alongside `archived`. A spike or
    // pilot report is a dated record of what was true when it ran; ranking it
    // as stale asks for a re-verification that would destroy what makes it
    // useful. #4459: `record` (a dated bug report, QA run or retrospective)
    // leaves it for the same reason. Here the audit and the coupling gate's
    // isGoverned() deliberately differ: a `record` doc stays governed there
    // (its `covers:` still route it on a PR), it is only never ranked stale.
    if (status === 'archived' || status === 'research' || status === 'record' || !covers?.length || !lastVerified) continue
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

  // #2088: governed `packages/**` READMEs rank alongside `docs/**`. Their
  // metadata comes from the manifest rather than front-matter, but the staleness
  // question is identical — how much covered code moved since the last
  // verification — and excluding them is what let a package README describe
  // three impossible QA legs for weeks (#1992).
  for (const entry of GOVERNED_PACKAGE_DOCS) {
    if (entry.status === 'archived' || entry.status === 'research' || entry.status === 'record') continue
    const lastVerified = entry['last-verified']
    if (!entry.covers?.length || !lastVerified) continue
    const commits = commitsSince(entry.covers, lastVerified)
    if (commits.length === 0) continue
    findings.push({
      doc: entry.doc,
      lastVerified,
      contract: false,
      commits: commits.length,
      latest: commits[0],
    })
  }

  const ranked = rankFindings(findings).slice(0, top)

  if (asJson) {
    console.log(JSON.stringify({ generated: new Date().toISOString().slice(0, 10), findings: ranked }, null, 2))
    return
  }

  const lines = []
  if (ranked.length === 0) {
    lines.push("Docs audit: every covered doc is verified at or after its covered code's last change. ✨")
  } else {
    lines.push(`Docs audit: ${ranked.length} doc(s) whose covered code changed after last-verified:\n`)
    for (const f of ranked) {
      const mark = f.contract ? ' [contract]' : ''
      lines.push(`  ${String(f.commits).padStart(3)} commit(s)  ${f.doc}${mark}  (last verified ${f.lastVerified})`)
      lines.push(`               latest: ${f.latest}`)
    }
    lines.push('\nFor each: re-verify the doc against the code and bump `last-verified`, or update it.')
  }
  // #4631: the doc-figure section sits under the ranking, at the same SHA.
  lines.push('')
  lines.push(figuresSection(arg('figures-report')))
  console.log(lines.join('\n'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('audit-staleness error (non-fatal):', err)
    process.exit(0)
  })
}
