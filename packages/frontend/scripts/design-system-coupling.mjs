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
// Two postures, one detector. Both run in CI on every PR (#1023) — the
// `coupling` job explains, the `strict` job blocks:
//   - default (explain): writes a sticky-comment body to --out and appends
//     `has_findings=…` to $GITHUB_OUTPUT; ALWAYS exits 0 — it only informs.
//   - --strict (block): exits 1 when findings exist, and also when the diff is
//     uncomputable — a gate must not pass on something it could not read.
// Before #1023 --strict ran only under ship-next, which made the canonical
// workflow stricter than opening a PR by hand.
//
// Usage:
//   npm run design:coupling:strict -w packages/frontend     # what CI decides
//   node scripts/design-system-coupling.mjs                 # advisory, same scope
//   node scripts/design-system-coupling.mjs --changed-diff=<file>   # a diff on disk
//   BASE_SHA=… HEAD_SHA=… node scripts/design-system-coupling.mjs   # CI
//
// #2826: the local run reads the WORKING TREE, not just committed work. It
// used to diff `origin/dev...HEAD` alone, so a primitive that had been written
// but not yet committed produced "no undocumented primitives added" — and
// ship-next runs this during review, BEFORE the commit. Every run now prints
// the range it compared, because a gate whose scope depends on unset
// environment variables must not be silent about which question it answered.
// This is the same false green the docs coupling gate hit (#1076) and fixed
// (#1077); scripts/docs/coupling-gate.mjs has carried the union since.
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs'
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
  if (/\.stories\.tsx?$/.test(file)) return false // stories showcase, not a primitive
  if (/\/index\.tsx?$/.test(file)) return false // the barrel re-exports, not the source
  return true
}

// A PascalCase identifier, optionally aliased (`Foo as Bar` → the alias is the
// export). `type`-prefixed members are not components.
function pascalMember(part) {
  part = part.trim()
  if (!part || part.startsWith('type ')) return null
  const name = part.split(/\s+as\s+/).pop().trim()
  return /^[A-Z][A-Za-z0-9]*$/.test(name) ? name : null
}

/**
 * Extract exported COMPONENT symbols from a single line of CODE (comments must
 * already be stripped — see codeOf). Components are PascalCase; `type`-only
 * re-exports and lowercase helper exports (e.g. entityCardStyles) are ignored.
 *
 * The `export` keyword is ANCHORED to the start of the (trimmed) line so a
 * `export const …` sitting inside a string literal or mid-line never counts —
 * only a real top-level export declaration does. Handles:
 *   export const Foo = …            export function Foo(…)     export class Foo
 *   export default function Foo     export default Foo
 *   export default () => …          (anonymous — caller falls back to filename)
 *   export { Foo, Bar as Baz }      (single-line re-export lists)
 *   export { Foo,                   (opening line of a multi-line list — its
 *                                    members ARE collected; the rest via
 *                                    addedExportsFromDiff's brace state)
 * For `export default`, six existing ui/ primitives use that style (Input,
 * Row, Skeleton, PageHeader, Toast, Tooltip), so it MUST be matched — an
 * anonymous default (`export default () => …`) yields the sentinel
 * DEFAULT_EXPORT and the diff parser substitutes the file's basename.
 */
export const DEFAULT_EXPORT = Symbol('default-export')
export function exportedComponentsInLine(line) {
  const names = new Set()
  const decl = line.match(/^\s*export\s+(?:const|function|class)\s+([A-Z][A-Za-z0-9]*)/)
  if (decl) names.add(decl[1])
  const dflt = line.match(/^\s*export\s+default\b\s*(?:function\s+)?([A-Z][A-Za-z0-9]*)?/)
  if (dflt) names.add(dflt[1] ?? DEFAULT_EXPORT)
  // Single-line list — or the OPENING line of a multi-line one: members on the
  // opening line must be collected here (brace state only covers later lines).
  const list = line.match(/^\s*export\s*\{([^}]*)(\}|$)/)
  if (list) {
    for (const part of list[1].split(',')) {
      const name = pascalMember(part)
      if (name) names.add(name)
    }
  }
  return [...names]
}

// Strip a trailing line comment and a JSDoc/block gutter so `export …` text
// living in a comment is never read as code. Returns '' for a pure comment
// line (leading `//` or `*` gutter), which yields no exports.
function codeOf(line) {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
  return line.replace(/\/\/.*$/, '')
}

// The exempt opt-out must be a real trailing comment marker, not any substring
// mention of the token elsewhere on the line.
const EXEMPT_RE = new RegExp(`//[^\\n]*\\b${EXEMPT_MARK}:`)

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
 * Collect exports from a run of CONSECUTIVE lines belonging to one file.
 * Shared by the diff parser and the untracked-file scanner so both read a
 * multi-line `export { … }` list the same way. `inBrace` state is scoped to
 * the run, which is what makes a run boundary a hard reset.
 */
function collectExports(file, lines) {
  const out = []
  let inBrace = false
  for (const line of lines) {
    const exempt = EXEMPT_RE.test(line)
    const code = codeOf(line)

    if (inBrace) {
      for (const part of code.split(',')) {
        const name = pascalMember(part)
        if (name) out.push({ file, symbol: name, exempt })
      }
      if (code.includes('}')) inBrace = false
      continue
    }

    for (const symbol of exportedComponentsInLine(code)) {
      // Anonymous `export default` → the primitive IS the file; use its
      // basename (ui/haven files are named after their component).
      const resolved =
        symbol === DEFAULT_EXPORT ? path.basename(file).replace(/\.tsx?$/, '') : symbol
      out.push({ file, symbol: resolved, exempt })
    }
    // Enter brace mode on an opening `export {` with no closing `}` on the line.
    if (/^\s*export\s*\{/.test(code) && !code.includes('}')) inBrace = true
  }
  return out
}

/**
 * Parse a unified diff into added component exports. Tracks the current +++
 * target file across hunks; only added lines (`+`, not `+++`) in primitive
 * files are considered. Comment text is stripped before matching (so an
 * `export …` inside a comment or string never counts), the exempt opt-out must
 * be a real trailing `// design-system-exempt:` marker, and a multi-line
 * `export { … }` list is collected across its added member lines via brace
 * state — reset whenever the diff run breaks (a non-added line or a new file).
 */
export function addedExportsFromDiff(diff) {
  const added = []
  let file = null
  let run = [] // consecutive added lines in the current file
  const flush = () => {
    if (file && run.length && isPrimitiveFile(file)) added.push(...collectExports(file, run))
    run = []
  }
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      flush()
      const p = raw.slice(4).replace(/^b\//, '').trim()
      file = p === '/dev/null' ? null : pkgRelative(p)
      continue
    }
    // Any line that isn't a content addition breaks a multi-line export run.
    if (!raw.startsWith('+') || raw.startsWith('+++')) {
      flush()
      continue
    }
    run.push(raw.slice(1))
  }
  flush()
  return added
}

const LOCAL_BASE = 'origin/dev'

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function gitDiff(revs) {
  return git(['diff', '--unified=0', ...revs, '--', ...PRIMITIVE_DIRS])
}

/**
 * Exported component symbols in a whole untracked file.
 *
 * An untracked file is the shape this gate exists to catch — a brand-new
 * primitive — and it is invisible to every `git diff` form, `git diff HEAD`
 * included. It is scanned DIRECTLY rather than rendered into diff text and fed
 * back through addedExportsFromDiff, because that round trip is fail-open: the
 * parser treats any line starting with `+++ ` as a file header, and prefixing
 * every content line with `+` turns a source line beginning `++ ` into one.
 * That re-points the parser at another path and silently drops the exports
 * after it — a gate reporting green because of what a file happened to
 * contain. Contrived in TSX, but this path carries WHOLE file contents rather
 * than changed lines, and a gate must not have that shape at all.
 */
export function addedExportsInFile(file, contents) {
  const rel = pkgRelative(file)
  if (!isPrimitiveFile(rel)) return []
  return collectExports(rel, contents.split('\n'))
}

/**
 * Compute the diff, and say which range it is. Always THREE-DOT (merge-base) —
 * a two-dot diff against a moving base branch shows base-side drift as phantom
 * `+` lines, so a stale PR would be blamed for exports it never touched.
 * Returns null when git fails: the caller decides — fatal under --strict (a
 * hard gate must not silently pass on an unreadable diff), warn-and-exit-0 in
 * advisory mode.
 *
 * Two scopes, and the difference is #2826's defect:
 *   - CI sets BASE_SHA/HEAD_SHA and gets exactly the pull request's range.
 *   - A local run has no such range, and a committed-only `origin/dev...HEAD`
 *     answers a DIFFERENT question than CI will — it reports a clean bill on
 *     work that is written but not committed, which is when ship-next runs it.
 *     So the local scope is the union a reviewer would look at: committed
 *     branch work, staged and unstaged tracked changes, and untracked files.
 * The union can only ever be WIDER than CI's range, never narrower, so it
 * cannot produce a green that CI turns red — the direction that matters.
 */
function getDiff() {
  const fromFile = arg('changed-diff')
  if (fromFile) return { diff: readFileSync(fromFile, 'utf8'), untracked: [], range: fromFile }

  const base = process.env.BASE_SHA
  if (base) {
    const range = `${base}...${process.env.HEAD_SHA || 'HEAD'}`
    try {
      return { diff: gitDiff([range]), untracked: [], range }
    } catch (err) {
      console.error(`design-system coupling: could not compute the diff (${range}):`, err.message)
      return null
    }
  }

  const range = `${LOCAL_BASE}...HEAD + working tree`
  try {
    const untracked = git([
      'ls-files',
      '--others',
      '--exclude-standard',
      '--full-name',
      '--',
      ...PRIMITIVE_DIRS,
    ])
      .split('\n')
      .filter(Boolean)
    const repoRoot = git(['rev-parse', '--show-toplevel']).trim()
    return {
      // Oldest first — dedupe() resolves a repeated export to its LAST entry.
      diff: gitDiff([`${LOCAL_BASE}...HEAD`]) + gitDiff(['HEAD']), // committed, then staged + unstaged
      // Untracked files are scanned directly (see addedExportsInFile), and
      // filtered BEFORE being read: an unreadable file this gate would never
      // look at — a dangling symlink, an editor artifact, a stray asset — must
      // not take the whole run down and report the base as the cause.
      untracked: untracked
        .filter((f) => isPrimitiveFile(pkgRelative(f)))
        .map((f) => ({ file: f, contents: readFileSync(path.join(repoRoot, f), 'utf8') })),
      range,
    }
  } catch (err) {
    console.error(`design-system coupling: could not read the local change (${range}):`, err.message)
    return null
  }
}

/**
 * One entry per file+symbol, resolved to its NEWEST state.
 *
 * The union can see the same export twice — committed on the branch, and again
 * in the working tree. The two can disagree about the `// design-system-exempt:`
 * marker, and the working tree is the newest state, so the LAST occurrence
 * wins. Callers must therefore build the union oldest-first: committed, then
 * tracked working-tree changes, then untracked files.
 *
 * OR-ing the two instead was a fail-open, in the one direction this gate must
 * not have: exempt-then-unexempted — commit the marker, then delete it in the
 * working tree, the ordinary "a reviewer said that is not internal" move, made
 * before the commit, which is the window this whole change exists to cover —
 * resolved to exempt, so the local run printed `no undocumented primitives
 * added` and exited 0 on a tree CI reddens.
 */
export function dedupe(added) {
  const byKey = new Map()
  for (const entry of added) {
    // Replace rather than merge: a later occurrence is a newer state of the
    // same export, and it is authoritative in BOTH directions.
    byKey.set(`${entry.file}::${entry.symbol}`, { ...entry })
  }
  return [...byKey.values()]
}

function main() {
  const strict = process.argv.includes('--strict')
  const outPath = arg('out') || 'design-system-coupling-comment.md'
  const pageSource = readFileSync(path.join(ROOT, PAGE), 'utf8')

  const computed = getDiff()
  if (computed === null) {
    if (strict) {
      console.error(
        '--strict: refusing to pass on a diff it could not read. See the cause above.',
      )
      process.exit(1)
    }
    console.log('design-system coupling: skipped (diff unavailable; advisory mode).')
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, 'has_findings=false\n')
    }
    return
  }

  // Say what was compared. A gate that silently changes scope on whether two
  // environment variables happen to be set is exactly what made #2826's false
  // green invisible: the run looked identical either way (#2826).
  console.log(`design-system coupling: comparing ${computed.range}`)

  const added = dedupe([
    ...addedExportsFromDiff(computed.diff),
    // Last, so an untracked file's state wins over any earlier occurrence.
    ...computed.untracked.flatMap((u) => addedExportsInFile(u.file, u.contents)),
  ])
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
      `\n_This comment explains the finding; the **Design-system coupling ` +
      `(strict)** check blocks on it. Reference page: \`${PAGE}\`._\n`
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

// Resolve symlinks, falling back to the raw path. The fallback matters: this
// runs at module load, OUTSIDE the try/catch below, so a throw here would
// crash the advisory run that promises exit 0.
const resolved = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Run as CLI only when invoked directly, not when imported by tests.
//
// Both sides are realpath-resolved before comparing. `import.meta.url` is
// already resolved by the module loader but `process.argv[1]` is not, so a
// path reaching this file through a symlink made the comparison false — main()
// never ran, and the process exited 0 in SILENCE. Under --strict that is a
// fail-OPEN: the gate passes a diff it never read. Not reachable from a runner
// workspace, but a gate must not have that shape at all.
if (process.argv[1] && resolved(fileURLToPath(import.meta.url)) === resolved(process.argv[1])) {
  try {
    main()
  } catch (err) {
    // Advisory by default: never block on an internal error unless --strict.
    console.error('design-system-coupling error (non-fatal):', err)
    process.exit(process.argv.includes('--strict') ? 1 : 0)
  }
}
