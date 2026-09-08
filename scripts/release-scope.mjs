#!/usr/bin/env node
// Measure what a dev -> main promotion will actually publish.
//
// WHY THIS EXISTS (#2724). The release record — the CASP changelog shard and the
// Supported Runtime Manifest note — is written at BUMP time, on a release/* branch.
// The tarballs are built from `main`'s tree at PROMOTION time. Anything merged to
// `dev` in between ships inside the release without appearing in its record.
//
// On 0.1.36-alpha.0 that shard was amended four times in eighteen hours, and the
// scope was hand-counted wrongly three separate ways: the baseline was taken from
// the bump commit rather than from main..dev; 219 lines of test files that never
// ship were counted; and packages/cli/README.md, which does ship, was omitted.
// Counting a diff by hand is the defect. This script is the instrument.
//
// WHAT "SHIPS" MEANS HERE, AND WHY IT IS MEASURED RATHER THAN ASSUMED.
// All five published packages build with tsup, which BUNDLES from a declared entry
// point. So `src/foo.ts -> dist/foo.js` is false: dist/index.js is one bundle, and a
// source file reaches it only by being imported from an entry. A rule like "src
// files ship, test files do not" would be an approximation of that, and an
// approximation in the under-inclusive direction is how a regulatory record ends up
// missing something it published.
//
// tsup runs with `sourcemap: true`, so each dist bundle has a .map beside it whose
// `sources` array is the build's OWN record of every source file it consumed. That
// is the authority this script reads. It cannot drift from the build, because it is
// an output of the build — and the .map files are themselves inside the tarball.
//
// The literal half — README.md, and packages/sdk/examples/** — comes from each
// package's `files` field, which is what npm itself packs. Nothing here is a
// hand-maintained list of what ships.
//
// REFUSALS. A measurement instrument that reports "nothing ships" when it simply
// could not look is worse than no instrument, because an empty result is what tells
// a release author to skip the amendment. So this script refuses rather than
// under-reports: on a shallow clone, on a package whose dist is missing or carries
// no sourcemaps, and on a changed source file it cannot resolve to either bucket.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

const DEFAULT_BASE = 'origin/main'
const DEFAULT_HEAD = 'origin/dev'

class Refusal extends Error {}

function git(args, { cwd = REPO_ROOT } = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trimEnd()
}

function parseArgs(argv) {
  const opts = { base: DEFAULT_BASE, head: DEFAULT_HEAD, json: false }
  for (const arg of argv) {
    if (arg === '--json') opts.json = true
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length)
    else if (arg.startsWith('--head=')) opts.head = arg.slice('--head='.length)
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Refusal(`unknown argument: ${arg}`)
  }
  return opts
}

const USAGE = `Usage: node scripts/release-scope.mjs [--base=<ref>] [--head=<ref>] [--json]

Measures what a promotion of <head> onto <base> will publish to npm.
Defaults: --base=${DEFAULT_BASE} --head=${DEFAULT_HEAD}

Run it when the promotion PR is opened, not when the bump is cut: the tarballs
are built from the base branch's tree at promotion time (#2724).`

// --- the published set -------------------------------------------------------
//
// Derived from `private: true`, never hardcoded. That is the same dividing line
// `lint:workspace-pins` uses, and it is the reason mcp-server (Docker-deployed,
// workspace-private) is correctly absent while cli is present.

function publishedPackages() {
  const names = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const published = []
  for (const name of names) {
    const manifestPath = join(PACKAGES_DIR, name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.private === true) continue
    published.push({ dir: name, name: manifest.name, files: manifest.files ?? [], version: manifest.version })
  }

  if (published.length === 0) {
    throw new Refusal('found no publishable packages under packages/ — refusing to report an empty release scope')
  }
  return published
}

// --- what each package actually ships ---------------------------------------

// Every source path recorded by the build itself, read out of the shipped
// sourcemaps. Refuses a package whose dist is absent or carries no .map files,
// because "no sourcemaps" and "this package ships nothing" are indistinguishable
// from the empty set that would otherwise be returned.
function bundledSources(pkg) {
  const distDir = join(PACKAGES_DIR, pkg.dir, 'dist')
  if (!existsSync(distDir)) {
    throw new Refusal(
      `${pkg.name}: packages/${pkg.dir}/dist does not exist. The shipped source set is read from the ` +
        `build's own sourcemaps, so an unbuilt package cannot be measured. Run \`npm run build -w ${pkg.name}\` ` +
        `(or \`npm run build\`) and re-run.`,
    )
  }

  const maps = readdirSync(distDir).filter((f) => f.endsWith('.map'))
  if (maps.length === 0) {
    throw new Refusal(
      `${pkg.name}: packages/${pkg.dir}/dist exists but holds no .map files. This script reads the shipped ` +
        `source set from sourcemaps (tsup \`sourcemap: true\`); without them it would report an empty set, ` +
        `which reads identically to "nothing shipped". Rebuild with sourcemaps enabled.`,
    )
  }

  const sources = new Set()
  for (const map of maps) {
    const parsed = JSON.parse(readFileSync(join(distDir, map), 'utf8'))
    for (const source of parsed.sources ?? []) {
      // Sourcemap sources are relative to dist/. Normalise to repo-relative.
      const abs = resolve(distDir, source)
      if (!abs.startsWith(REPO_ROOT)) continue // out-of-tree (node_modules) — not our source
      sources.add(relative(REPO_ROOT, abs).split('\\').join('/'))
    }

    // THE ENTRY POINT IS NOT ALWAYS IN ITS OWN SOURCEMAP, and the exception is
    // the dangerous one. `sources` lists files that contributed MAPPED OUTPUT, so
    // an entry that is a pure re-export barrel — `export * from './x'`, emitting
    // no code of its own — is absent. Measured on this repo: sdk, signer, mcp and
    // cli all omit their src/index.ts; connect includes it, because that one has
    // real code in it. Relying on `sources` alone would therefore classify a
    // change to @haven_ai/sdk's public export surface as unshipped, which is the
    // single most release-relevant file in the package.
    //
    // tsup writes one bundle per entry, named for it, so dist/<name>.js.map pairs
    // with src/<name>.ts. Add that back explicitly. `existsSync` keeps this from
    // inventing a source for a bundle whose entry is named differently.
    const bundle = map.replace(/\.(c?js)\.map$/, '')
    if (bundle !== map) {
      const entry = `packages/${pkg.dir}/src/${bundle}.ts`
      if (existsSync(join(REPO_ROOT, entry))) sources.add(entry)
    }
  }
  return sources
}

// The non-compiled half of the tarball: whatever the `files` field names, plus
// package.json, which npm always packs whether or not it is listed.
function literalMembers(pkg, changedFiles) {
  const prefix = `packages/${pkg.dir}/`
  const members = new Set()

  for (const file of changedFiles) {
    if (!file.startsWith(prefix)) continue
    const rel = file.slice(prefix.length)

    if (rel === 'package.json') {
      members.add(file)
      continue
    }
    for (const entry of pkg.files) {
      const normalised = entry.replace(/^\.\//, '').replace(/\/$/, '')
      if (rel === normalised || rel.startsWith(`${normalised}/`)) {
        members.add(file)
        break
      }
    }
  }
  return members
}

// --- classification ----------------------------------------------------------

function classify(changedFiles, packages) {
  const ships = []
  const excluded = []
  const unresolved = []

  const byPackage = new Map()
  for (const pkg of packages) {
    byPackage.set(pkg.dir, { pkg, bundled: bundledSources(pkg), literals: literalMembers(pkg, changedFiles) })
  }

  for (const file of changedFiles) {
    const match = /^packages\/([^/]+)\//.exec(file)
    const entry = match ? byPackage.get(match[1]) : undefined

    if (!entry) {
      excluded.push({ file, reason: 'not in a published package' })
      continue
    }
    const { pkg, bundled, literals } = entry

    if (literals.has(file)) {
      ships.push({ file, pkg: pkg.name, via: 'tarball member (files field / package.json)' })
      continue
    }
    if (bundled.has(file)) {
      ships.push({ file, pkg: pkg.name, via: 'bundled (recorded in dist sourcemap)' })
      continue
    }

    // In a published package but neither packed literally nor bundled. Two very
    // different causes with the same shape, so this is neither bucket: a test or
    // config file (correctly excluded), or a source file the local build has not
    // seen yet (a stale dist — an UNDER-report, the dangerous direction).
    const isSource = /^packages\/[^/]+\/src\//.test(file)
    const isTest = /(\.test\.[cm]?[jt]sx?$)|(^|\/)__tests__\//.test(file)

    if (isSource && !isTest) {
      unresolved.push({
        file,
        pkg: pkg.name,
        reason: 'under src/ but absent from every dist sourcemap — either unreachable from an entry point (dead code) or a stale build',
      })
    } else {
      excluded.push({ file, reason: isTest ? 'test file — not reachable from any bundle entry' : 'in the package but outside the tarball' })
    }
  }

  return { ships, excluded, unresolved }
}

// --- git range ---------------------------------------------------------------

function assertUsableCheckout() {
  if (git(['rev-parse', '--is-shallow-repository']) !== 'false') {
    throw new Refusal(
      'this is a shallow clone. Ancestry and range questions return confidently wrong answers here — ' +
        'run `git fetch --unshallow` before measuring a release.',
    )
  }
}

function resolveRef(ref) {
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`])
  } catch {
    throw new Refusal(`cannot resolve ref "${ref}". Fetch it first (\`git fetch origin\`) or pass --base/--head.`)
  }
}

function commitsInRange(base, head) {
  const raw = git(['log', '--no-merges', '--format=%H%x1f%s', `${base}..${head}`])
  if (raw === '') return []
  return raw.split('\n').map((line) => {
    const [sha, subject] = line.split('\u001f')
    return { sha: sha.slice(0, 8), subject }
  })
}

function issuesReferenced(commits) {
  const issues = new Set()
  for (const { subject } of commits) {
    for (const match of subject.matchAll(/#(\d+)/g)) issues.add(Number(match[1]))
  }
  return [...issues].sort((a, b) => a - b)
}

function changedFilesInRange(base, head) {
  const raw = git(['diff', '--name-only', `${base}...${head}`])
  return raw === '' ? [] : raw.split('\n')
}

function lineStats(base, head, files) {
  if (files.length === 0) return { added: 0, removed: 0 }
  const raw = git(['diff', '--numstat', `${base}...${head}`, '--', ...files])
  let added = 0
  let removed = 0
  for (const line of raw === '' ? [] : raw.split('\n')) {
    const [a, r] = line.split('\t')
    if (a === '-' || r === '-') continue // binary
    added += Number(a)
    removed += Number(r)
  }
  return { added, removed }
}

// --- report ------------------------------------------------------------------

function buildReport(opts) {
  assertUsableCheckout()
  const baseSha = resolveRef(opts.base)
  const headSha = resolveRef(opts.head)

  const packages = publishedPackages()
  const commits = commitsInRange(baseSha, headSha)
  const changedFiles = changedFilesInRange(baseSha, headSha)
  const { ships, excluded, unresolved } = classify(changedFiles, packages)

  const shippedFiles = ships.map((s) => s.file)
  const stats = lineStats(baseSha, headSha, shippedFiles)

  const affected = [...new Set(ships.map((s) => s.pkg))].sort()

  return {
    range: { base: opts.base, baseSha, head: opts.head, headSha },
    commits,
    issues: issuesReferenced(commits),
    packages: packages.map((p) => ({ name: p.name, version: p.version })),
    affectedPackages: affected,
    shipped: { files: ships, count: ships.length, ...stats },
    excluded,
    unresolved,
  }
}

function render(report) {
  const out = []
  const { range } = report

  out.push('Release scope')
  out.push(`  range     ${range.base} (${range.baseSha.slice(0, 8)}) .. ${range.head} (${range.headSha.slice(0, 8)})`)
  out.push(`  commits   ${report.commits.length}`)
  out.push(`  issues    ${report.issues.length ? report.issues.map((i) => `#${i}`).join(' ') : '(none referenced)'}`)
  out.push('')

  out.push(`Publishes to npm: ${report.affectedPackages.length ? report.affectedPackages.join(', ') : '(no published package is affected)'}`)
  out.push('')

  out.push(`Shipped delta: ${report.shipped.count} files, +${report.shipped.added}/-${report.shipped.removed}`)
  for (const entry of report.shipped.files) {
    out.push(`  ${entry.file}`)
    out.push(`      ${entry.pkg} — ${entry.via}`)
  }
  if (report.shipped.count === 0) out.push('  (nothing in this range reaches a tarball)')
  out.push('')

  // Stated, never silent: an exclusion nobody can see is indistinguishable from a
  // file the instrument failed to notice.
  out.push(`Excluded from the shipped delta: ${report.excluded.length} files`)
  const grouped = new Map()
  for (const { reason } of report.excluded) grouped.set(reason, (grouped.get(reason) ?? 0) + 1)
  for (const [reason, count] of [...grouped].sort((a, b) => b[1] - a[1])) {
    out.push(`  ${String(count).padStart(4)}  ${reason}`)
  }

  if (report.unresolved.length > 0) {
    out.push('')
    out.push(`UNRESOLVED: ${report.unresolved.length} source files could not be classified`)
    for (const entry of report.unresolved) {
      out.push(`  ${entry.file}`)
      out.push(`      ${entry.reason}`)
    }
    out.push('')
    out.push('  These are under src/ in a published package but absent from every dist sourcemap.')
    out.push('  Either they are unreachable from an entry point, or the local build predates them.')
    out.push('  Rebuild (`npm run build`) and re-run before trusting the shipped delta: a stale')
    out.push('  build under-reports, which is the direction that loses a record.')
  }

  return out.join('\n')
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`release-scope: ${err.message}\n\n${USAGE}`)
    process.exit(2)
  }

  if (opts.help) {
    console.log(USAGE)
    return
  }

  let report
  try {
    report = buildReport(opts)
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(`release-scope: REFUSING TO REPORT — ${err.message}`)
      process.exit(2)
    }
    throw err
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(render(report))
  }

  // An unresolved file means the shipped delta may be an under-count, so the exit
  // code says so rather than leaving a green run to be quoted as a clean measure.
  process.exit(report.unresolved.length > 0 ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}

export { buildReport, classify, publishedPackages, bundledSources, literalMembers, Refusal }
