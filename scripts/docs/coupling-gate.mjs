#!/usr/bin/env node
// Doc↔code coupling gate (Phase 2 of the docs-quality system, epic #642).
//
// When a PR changes code that a doc describes (via the doc's `covers:`
// front-matter) WITHOUT touching that doc, this emits an advisory comment
// naming the doc and how stale it is, so the author can confirm-or-update it.
// It NEVER fails the build — it only informs.
//
// Usage:
//   node scripts/docs/coupling-gate.mjs                 # diff origin/dev...HEAD
//   node scripts/docs/coupling-gate.mjs --changed a,b   # explicit file list
//   BASE_SHA=… HEAD_SHA=… node scripts/docs/coupling-gate.mjs   # CI
//
// Writes the comment body to --out (default coupling-comment.md) only when
// there are findings, and appends `has_findings=true|false` to $GITHUB_OUTPUT.

import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  REPO_ROOT,
  ROOT_DOCS,
  walk,
  parseFrontMatter,
  globToRegExp,
} from './validate-frontmatter.mjs'

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

function changedFiles() {
  const explicit = arg('changed')
  if (explicit !== undefined) {
    return explicit.split(',').map((s) => s.trim()).filter(Boolean)
  }
  const base = process.env.BASE_SHA
  const head = process.env.HEAD_SHA || 'HEAD'
  const range = base ? [`${base}`, `${head}`] : ['origin/dev...HEAD']
  try {
    const out = execFileSync('git', ['diff', '--name-only', ...range], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export function ageDays(lastVerified, now = Date.now()) {
  const then = Date.parse(lastVerified)
  if (Number.isNaN(then)) return null
  return Math.floor((now - then) / 86_400_000)
}

/**
 * Pure core: given changed files and the docs (each with its `covers` globs),
 * return the docs implicated by the change. A doc is implicated when a changed
 * file matches one of its globs AND the doc itself was not changed.
 */
export function implicatedDocs(changed, docs) {
  const changedSet = new Set(changed)
  const findings = []
  for (const { doc, covers, lastVerified } of docs) {
    if (changedSet.has(doc)) continue
    if (!covers || covers.length === 0) continue
    const matched = new Set()
    for (const glob of covers) {
      const re = globToRegExp(glob)
      for (const f of changed) if (re.test(f)) matched.add(f)
    }
    if (matched.size > 0) findings.push({ doc, lastVerified, matched: [...matched].sort() })
  }
  return findings
}

async function main() {
  const outPath = arg('out') || 'coupling-comment.md'
  const changed = changedFiles()

  const docFiles = (await walk(join(REPO_ROOT, 'docs'))).filter((p) => p.endsWith('.md'))
  for (const r of ROOT_DOCS) docFiles.push(r)

  const docs = []
  for (const docRel of docFiles.sort()) {
    const raw = await readFile(join(REPO_ROOT, docRel), 'utf8')
    const parsed = parseFrontMatter(raw)
    if (!parsed.ok) continue
    docs.push({
      doc: docRel,
      covers: parsed.data.covers || [],
      lastVerified: parsed.data['last-verified'],
    })
  }

  const findings = implicatedDocs(changed, docs)
  const hasFindings = findings.length > 0

  if (hasFindings) {
    let body = '<!-- docs-coupling-gate -->\n'
    body += '### 📝 Docs that may need updating\n\n'
    body +=
      'This PR changes code that the docs below describe (via their `covers:` ' +
      'front-matter), but those docs were not touched. Please confirm each is ' +
      'still accurate — or update it and bump `last-verified`. ' +
      '_Advisory only: this never blocks the merge._\n\n'
    for (const f of findings) {
      const age = ageDays(f.lastVerified)
      const ageStr = age === null ? 'unknown' : `${age}d ago`
      body += `- \`${f.doc}\` (last verified ${f.lastVerified}, ${ageStr})\n`
      for (const m of f.matched) body += `  - matched \`${m}\`\n`
    }
    await writeFile(outPath, body, 'utf8')
    console.log(`Coupling gate: ${findings.length} doc(s) may need updating.`)
    for (const f of findings) console.log(`  - ${f.doc}`)
  } else {
    console.log('Coupling gate: no covered docs implicated by the changed files.')
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `has_findings=${hasFindings}\n`)
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // Advisory tool: log and exit 0 so it can never block a PR.
    console.error('coupling-gate error (non-fatal):', err)
    process.exit(0)
  })
}
