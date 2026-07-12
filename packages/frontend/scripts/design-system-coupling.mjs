#!/usr/bin/env node
// Design-system coupling gate (#898, epic #904).
//
// "Add a new primitive to /design-system in the same PR" was enforced only by
// prose — you could add an export to components/ui/** or components/haven/**
// and never touch the reference page. This mirrors the docs↔code coupling gate
// (scripts/docs/coupling-gate.mjs): when a PR ADDS or RENAMES an exported
// component symbol in ui/ or haven/ whose name never appears in
// app/(authenticated)/design-system/page.tsx, it names the undocumented
// primitive so the author adds a showcase entry.
//
// Diff-scoped by design: only exports on ADDED diff lines are considered, so
// pre-existing undocumented exports never nag an unrelated PR (same posture as
// docs-coupling). A genuinely internal export opts out with a trailing
// `// design-system-exempt: <reason>` on the export line.
//
// Two postures, one detector:
//   - CI (advisory): writes a sticky-comment body to --out and appends
//     `has_findings=…` to $GITHUB_OUTPUT; ALWAYS exits 0 — it only informs.
//   - ship-next (hard gate): run with --strict to exit 1 when findings exist,
//     so the autonomous path cannot merge an undocumented primitive.
//
// Usage:
//   node scripts/design-system-coupling.mjs                 # diff origin/dev...HEAD
//   node scripts/design-system-coupling.mjs --changed-diff=<file>   # a diff on disk
//   node scripts/design-system-coupling.mjs --strict        # exit 1 on findings
//   BASE_SHA=… HEAD_SHA=… node scripts/design-system-coupling.mjs   # CI
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = 'src/app/(authenticated)/design-system/page.tsx'
// Only these two directories hold the shared, showcase-worthy primitives.
const PRIMITIVE_DIRS = ['src/components/ui/', 'src/components/haven/']
// `git diff` run from the package cwd still prints repo-root-relative paths
// (packages/frontend/src/…). Strip that prefix so paths are package-relative
// and match PRIMITIVE_DIRS / PAGE.
const PKG_PREFIX = 'packages/frontend/'
const EXEMPT_MARK = 'design-system-exempt'

function pkgRelative(file) {
  return file.startsWith(PKG_PREFIX) ? file.slice(PKG_PREFIX.length) : file
}

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

function isPrimitiveFile(file) {
  if (!PRIMITIVE_DIRS.some((d) => file.startsWith(d))) return false
  if (!/\.tsx?$/.test(file)) return false
  if (/\.test\.tsx?$/.test(file)) return false
  if (file.endsWith('/index.ts')) return false // the barrel re-exports, not the source
  return true
}

/**
 * Extract exported COMPONENT symbols from a single added source line.
 * Components are PascalCase; `type`-only re-exports and lowercase helper
 * exports (e.g. entityCardStyles) are ignored. Handles:
 *   export const Foo = …            export function Foo(…)     export class Foo
 *   export { Foo, Bar as Baz }      (re-export lists; `as` alias is the export)
 * Scoped to NAMED exports by repo convention — ui/ and haven/ primitives are
 * always named (the barrel re-exports them, the page imports them by name); a
 * `export default` primitive would be off-convention and is intentionally not
 * matched.
 */
export function exportedComponentsInLine(line) {
  const names = new Set()
  const decl = line.match(/export\s+(?:const|function|class)\s+([A-Z][A-Za-z0-9]*)/)
  if (decl) names.add(decl[1])
  const list = line.match(/export\s*\{([^}]*)\}/)
  if (list) {
    for (let part of list[1].split(',')) {
      part = part.trim()
      if (!part || part.startsWith('type ')) continue
      const name = part.split(/\s+as\s+/).pop().trim()
      if (/^[A-Z][A-Za-z0-9]*$/.test(name)) names.add(name)
    }
  }
  return [...names]
}

/**
 * Pure core: given the ADDED exports discovered in the diff (each
 * {file, symbol, exempt}) and the current design-system page source, return
 * the findings — added primitives whose symbol never appears in the page and
 * that are not exempt. Testable without git.
 */
export function undocumentedPrimitives(addedExports, pageSource) {
  const findings = []
  const seen = new Set()
  for (const { file, symbol, exempt } of addedExports) {
    if (exempt) continue
    const key = `${file}::${symbol}`
    if (seen.has(key)) continue
    seen.add(key)
    // Whole-word appearance anywhere in the page counts as documented
    // (import, JSX usage, or prose reference).
    if (new RegExp(`\\b${symbol}\\b`).test(pageSource)) continue
    findings.push({ file, symbol })
  }
  return findings
}

/**
 * Parse a unified diff into added component exports. Tracks the current +++
 * target file across hunks; only added lines (`+`, not `+++`) in primitive
 * files are considered. An export line carrying the exempt marker opts out.
 */
export function addedExportsFromDiff(diff) {
  const added = []
  let file = null
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim()
      file = p === '/dev/null' ? null : pkgRelative(p)
      continue
    }
    if (!file || !raw.startsWith('+') || raw.startsWith('+++')) continue
    if (!isPrimitiveFile(file)) continue
    const line = raw.slice(1)
    const exempt = line.includes(EXEMPT_MARK)
    for (const symbol of exportedComponentsInLine(line)) {
      added.push({ file, symbol, exempt })
    }
  }
  return added
}

function getDiff() {
  const fromFile = arg('changed-diff')
  if (fromFile) return readFileSync(fromFile, 'utf8')
  const base = process.env.BASE_SHA
  const head = process.env.HEAD_SHA || 'HEAD'
  const range = base ? [`${base}`, `${head}`] : ['origin/dev...HEAD']
  try {
    return execFileSync('git', ['diff', '--unified=0', ...range, '--', ...PRIMITIVE_DIRS], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
  } catch {
    return ''
  }
}

function main() {
  const strict = process.argv.includes('--strict')
  const outPath = arg('out') || 'design-system-coupling-comment.md'
  const pageSource = readFileSync(path.join(ROOT, PAGE), 'utf8')

  const added = addedExportsFromDiff(getDiff())
  const findings = undocumentedPrimitives(added, pageSource)
  const hasFindings = findings.length > 0

  if (hasFindings) {
    let body = '<!-- design-system-coupling-gate -->\n'
    body += '### 🎨 New primitives missing from `/design-system`\n\n'
    body +=
      'This PR adds shared primitive export(s) that never appear on the design-system ' +
      'reference page. Add a showcase entry (usage + variants) in the same PR so the ' +
      'page stays the single source of truth — or, for a genuinely internal export, ' +
      'mark the export line `// design-system-exempt: <reason>`.\n\n'
    for (const f of findings) body += `- \`${f.symbol}\` — \`${f.file}\`\n`
    body +=
      `\n_Advisory here; a hard definition-of-done step under ship-next. ` +
      `Reference page: \`${PAGE}\`._\n`
    writeFileSync(outPath, body, 'utf8')
    console.error(`design-system coupling: ${findings.length} undocumented primitive(s).`)
    for (const f of findings) console.error(`  - ${f.symbol} (${f.file})`)
  } else {
    console.log('design-system coupling: no undocumented primitives added.')
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `has_findings=${hasFindings}\n`)
  }

  if (strict && hasFindings) {
    console.error(
      `\nAdd each primitive to ${PAGE} (or mark it // ${EXEMPT_MARK}: <reason>) before merging.`,
    )
    process.exit(1)
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main()
  } catch (err) {
    // Advisory by default: never block on an internal error unless --strict.
    console.error('design-system-coupling error (non-fatal):', err)
    process.exit(process.argv.includes('--strict') ? 1 : 0)
  }
}
