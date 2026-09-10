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
// This is the same false green the docs coupling gate fixed under #1076;
// scripts/docs/coupling-gate.mjs has carried the union since.
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
  let inBrace = false // mid multi-line `export { … }` for the current file
  const breakRun = () => {
    inBrace = false
  }
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '').trim()
      file = p === '/dev/null' ? null : pkgRelative(p)
      breakRun()
      continue
    }
    // Any line that isn't a content addition breaks a multi-line export run.
    if (!raw.startsWith('+') || raw.startsWith('+++')) {
      breakRun()
      continue
    }
    if (!file || !isPrimitiveFile(file)) {
      breakRun()
      continue
    }
    const line = raw.slice(1)
    const exempt = EXEMPT_RE.test(line)
    const code = codeOf(line)

    if (inBrace) {
      for (const part of code.split(',')) {
        const name = pascalMember(part)
        if (name) added.push({ file, symbol: name, exempt })
      }
      if (code.includes('}')) inBrace = false
      continue
    }

    for (const symbol of exportedComponentsInLine(code)) {
      // Anonymous `export default` → the primitive IS the file; use its
      // basename (ui/haven files are named after their component).
      const resolved =
        symbol === DEFAULT_EXPORT ? path.basename(file).replace(/\.tsx?$/, '') : symbol
      added.push({ file, symbol: resolved, exempt })
    }
    // Enter brace mode on an opening `export {` with no closing `}` on the line.
    if (/^\s*export\s*\{/.test(code) && !code.includes('}')) inBrace = true
  }
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
 * Render an untracked file as a unified diff of pure additions, so the one
 * parser reads tracked and untracked work identically.
 *
 * An untracked file is the shape this gate exists to catch — a brand-new
 * primitive — and it is invisible to every `git diff` form, including
 * `git diff HEAD`. Synthesized rather than shelled out to `git diff --no-index`
 * so it stays a pure function the suite can assert on directly.
 *
 * The path is emitted repo-root-relative on the `+++ b/` line, matching what
 * `git diff` prints from this package's cwd; addedExportsFromDiff strips the
 * package prefix itself.
 */
export function untrackedFileDiff(file, contents) {
  const lines = contents.split('\n')
  // A trailing newline yields a final empty element that is not a line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return (
    `diff --git a/${file} b/${file}\n` +
    'new file mode 100644\n' +
    '--- /dev/null\n' +
    `+++ b/${file}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => `+${l}`).join('\n') +
    (lines.length ? '\n' : '')
  )
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
  if (fromFile) return { diff: readFileSync(fromFile, 'utf8'), range: fromFile }

  const base = process.env.BASE_SHA
  if (base) {
    const range = `${base}...${process.env.HEAD_SHA || 'HEAD'}`
    try {
      return { diff: gitDiff([range]), range }
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
      diff:
        gitDiff([`${LOCAL_BASE}...HEAD`]) +
        gitDiff(['HEAD']) + // staged + unstaged tracked
        untracked
          .map((f) => untrackedFileDiff(f, readFileSync(path.join(repoRoot, f), 'utf8')))
          .join(''),
      range,
    }
  } catch (err) {
    console.error(`design-system coupling: could not compute the diff (${range}):`, err.message)
    return null
  }
}

/**
 * One entry per file+symbol. The union scope can see the same export twice —
 * committed on the branch AND modified in the working tree. An occurrence
 * marked `// design-system-exempt:` anywhere wins, because the working tree is
 * the newest state and is what will be pushed: exempting a primitive without
 * committing yet must not still read as a finding.
 */
export function dedupe(added) {
  const byKey = new Map()
  for (const entry of added) {
    const key = `${entry.file}::${entry.symbol}`
    const seen = byKey.get(key)
    if (seen) seen.exempt = seen.exempt || entry.exempt
    else byKey.set(key, { ...entry })
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
      console.error('--strict: refusing to pass on an uncomputable diff — fetch the base and retry.')
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

  const added = dedupe(addedExportsFromDiff(computed.diff))
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
