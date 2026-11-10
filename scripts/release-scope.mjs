#!/usr/bin/env node
// Measure what a dev -> main promotion will actually publish.
//
// WHY THIS EXISTS (#2724). The release record — the CASP changelog shard and the
// Supported Runtime Manifest note — is written at BUMP time, on a release/* branch.
// The tarballs are built from `main`'s tree at PROMOTION time. Anything merged to
// `dev` in between ships inside the release without appearing in its record.
//
// On 0.1.36-alpha.0 that shard was amended repeatedly before promotion (the dated
// shard owns the count), and the scope was hand-counted wrongly four separate
// ways: the baseline was taken from the bump commit rather than from main..dev;
// 219 lines of test files that never ship were counted; packages/cli/README.md,
// which does ship, was omitted; and three of the five package.json files were
// left out while the other two were included.
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
// THE OTHER PATH (#4770). A change that is not in a published package reaches an
// installed agent when the service that builds it deploys, and a pull request
// should say which of the two paths it takes. So the files this script reports as
// "not in a published package" are attributed to the deploy surfaces the tree
// says build them — read from the workspace list and each package's own
// package.json, never from a list kept here — and the report ends with the
// `Release lever:` line the pull request carries. That line is advisory: nothing
// reads it, and it gates nothing.
//
// REFUSALS. A measurement instrument that reports "nothing ships" when it simply
// could not look is worse than no instrument, because an empty result is what tells
// a release author to skip the amendment. So this script refuses rather than
// under-reports: on a shallow clone; on a package whose dist is missing, carries no
// sourcemaps, or lacks one of the bundles its own package.json resolves to; and on
// a `files` entry that is a glob, which the literal prefix match would silently
// match nothing against. A source file it can place in neither bucket is reported
// in an `unresolved` list and exits 1 — measured, but not measured completely.

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
    // Required bundles come from what npm consumers actually RESOLVE — main,
    // module and bin all point at concrete dist/<name>.{js,cjs} paths — not from
    // a filename convention over src/. Deriving them from /^(index|cli)\.ts$/
    // was both a false-refusal risk (an ordinary internal module named
    // src/cli.ts hard-stopped @haven_ai/sdk at exit 2, which no rebuild could
    // clear, because sdk's only entry is src/index.ts) and a false-pass risk (a
    // future entry named src/server.ts would not be required at all, reopening
    // the partial-dist hole). A bundle missing from these fields is definitionally
    // a broken tarball.
    // #3173: `exports` subpaths are entries too — `@haven_ai/sdk/edge` resolves
    // dist/edge.{js,cjs}, which main/module/bin never name. Walk the conditions
    // map to its string leaves.
    const exportLeaves = (node) =>
      typeof node === 'string' ? [node] : node && typeof node === 'object' ? Object.values(node).flatMap(exportLeaves) : []
    const entryRefs = [manifest.main, manifest.module, ...Object.values(manifest.bin ?? {}), ...exportLeaves(manifest.exports)].filter(
      (v) => typeof v === 'string',
    )
    const requiredBundles = [
      ...new Set(
        entryRefs
          .map((ref) => /(?:^|\/)dist\/([^/]+)\.(?:c?js)$/.exec(ref)?.[1])
          .filter((b) => typeof b === 'string'),
      ),
    ]
    published.push({
      dir: name,
      name: manifest.name,
      files: manifest.files ?? [],
      version: manifest.version,
      requiredBundles,
    })
  }

  if (published.length === 0) {
    throw new Refusal('found no publishable packages under packages/ — refusing to report an empty release scope')
  }
  return published
}

// --- the deploy surfaces -----------------------------------------------------
//
// A change that is not in a published package reaches an installed agent by the
// other path: it ships when the service that builds it deploys. Which services
// those are is read from the tree, never from a list kept here — a hand-kept
// list of package names is the defect this script exists to stop, one bucket
// over.
//
// Two facts, both from each package's own package.json:
//
//   - a package that declares a `start` script is a SERVICE. That is the tree's
//     only statement of "this runs somewhere" that covers every deployed
//     package: backend, frontend and mcp-server carry a Dockerfile, frontend and
//     ops a vercel.json, and demo-merchant-mcp carries neither — Railway builds
//     it from the repo root (docs/operations/railway-services.md) — while all
//     five declare `start`. A Dockerfile-or-vercel.json rule would silently drop
//     the demo merchant.
//   - a package that is not a service reaches a service through the workspace
//     dependency graph: core is built into backend, frontend and ops, and ui into
//     frontend and ops, so a change to either deploys those services. The graph is
//     read from each package.json's dependency fields, by workspace package NAME.
//
// So the deploy surfaces of a package are itself when it is a service, and
// otherwise the surfaces of every workspace package that depends on it,
// transitively. A package nothing depends on and that declares no `start` script
// (qa-agent) has no deploy surface: it is a test harness, not a service.
//
// The rule is over-inclusive in the safe direction — a README edit inside a
// service package names that service, though the image's behaviour is unchanged.
// Under-reporting is the direction that loses a line from a release record, so
// the coarse answer is the one to give. Test files are the exception: they are
// not built into anything, so they name no surface.

// `devDependencies` is deliberately absent: a dev dependency is not installed in
// the deployed image, so it does not make a service build the package. mcp-server
// lists @haven_ai/core there for its tests, and counting it would name the hosted
// MCP as a surface for a core change that never reaches its bundle.
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']

// Every workspace package, published or not. The set is the expansion of the
// root package.json's only workspace glob, `packages/*` — the same directory
// listing publishedPackages() walks, read once here with the two facts the
// deploy-surface rule needs.
function workspacePackages() {
  const names = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  const packages = []
  for (const dir of names) {
    const manifestPath = join(PACKAGES_DIR, dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const deps = new Set()
    for (const field of DEPENDENCY_FIELDS) {
      for (const dep of Object.keys(manifest[field] ?? {})) deps.add(dep)
    }
    packages.push({
      dir,
      name: manifest.name,
      private: manifest.private === true,
      service: typeof manifest.scripts?.start === 'string',
      deps,
    })
  }
  return packages
}

// dir -> { pkg, surfaces }. `surfaces` is the sorted list of service package
// directories that build this package, itself included when it is a service.
function deploySurfaces(packages) {
  const byName = new Map(packages.map((p) => [p.name, p]))
  const dependents = new Map(packages.map((p) => [p.name, []]))
  for (const p of packages) {
    for (const dep of p.deps) {
      if (byName.has(dep)) dependents.get(dep).push(p.name)
    }
  }

  const byDir = new Map()
  for (const p of packages) {
    // Breadth-first over the dependents graph. `seen` makes a dependency cycle
    // terminate instead of recursing forever; a cycle adds no surface of its own.
    const seen = new Set([p.name])
    const queue = [p.name]
    const found = new Set()
    while (queue.length > 0) {
      const name = queue.shift()
      const pkg = byName.get(name)
      if (pkg.service) found.add(pkg.dir)
      for (const dependent of dependents.get(name) ?? []) {
        if (seen.has(dependent)) continue
        seen.add(dependent)
        queue.push(dependent)
      }
    }
    byDir.set(p.dir, { pkg: p, surfaces: [...found].sort() })
  }
  return byDir
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

  // A dist holding cli.js.map but no index.js.map passes a bare length check and
  // then silently under-reports everything the missing bundle carried. Require a
  // .map for every entry the package declares through its own bin/exports shape:
  // each src/<name>.ts that tsup would emit as dist/<name>.js.
  const bundleNames = new Set(maps.map((m) => m.replace(/\.(c?js)\.map$/, '')))
  const missingBundles = pkg.requiredBundles.filter((e) => !bundleNames.has(e))
  if (missingBundles.length > 0) {
    throw new Refusal(
      `${pkg.name}: packages/${pkg.dir}/dist has sourcemaps but none for ${missingBundles
        .map((b) => `${b}.js`)
        .join(', ')}, though package.json's main/module/bin/exports resolve to it. A partial dist under-reports whatever the ` +
        `missing bundle carried, silently. Rebuild the package.`,
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

  // The prefix match below is faithful to npm ONLY for literal entries. Measured
  // against `npm pack --dry-run` on a fixture: `files: ["dist/*.js"]` packs
  // dist/a.js and NOT dist/b.map — a glob filters within the directory, where a
  // prefix rule would match the whole of it. Worse, a prefix rule matches nothing
  // at all against the literal string `dist/*.js`, so every dist file would be
  // dropped in silence. No Haven package uses a glob entry today; refuse rather
  // than wait for one, because silence is the failure this script exists to stop.
  for (const entry of pkg.files) {
    if (/[*?![\]{}]/.test(entry)) {
      throw new Refusal(
        `${pkg.name}: the "files" entry ${JSON.stringify(entry)} is a glob, and this script only matches literal ` +
          `paths faithfully. Teach literalMembers to expand it (npm filters WITHIN a directory for a glob) rather ` +
          `than letting it match nothing and drop the package's tarball members silently.`,
      )
    }
  }

  for (const file of changedFiles) {
    if (!file.startsWith(prefix)) continue
    const rel = file.slice(prefix.length)

    // npm packs these whatever `files` says. Measured with `npm pack --dry-run`:
    // package.json and LICENSE are included when present, CHANGELOG.md is not.
    if (rel === 'package.json' || /^LICEN[CS]E(\.[^/]*)?$/i.test(rel)) {
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

// Test-support modules are not tarball content. `test-helpers.ts` is not
// `.test.ts`, so without this a MODIFIED one landed in `unresolved` while a
// DELETED one was counted as shipped — the same file, opposite answers,
// decided only by change status (review finding D).
//
// This is a naming heuristic, and the limit is worth stating precisely
// because an earlier version of this comment overstated it. On the MODIFIED
// path it is safe by construction: `bundled.has(file)` is checked first, so
// it only ever routes a file the build already says it did not consume. On
// the DELETED path there is no such protection — a deleted file cannot be in
// the head tree's sourcemaps either way, so here the name is the sole
// decider, and a genuinely bundled module named `test-helpers.ts` would be
// dropped. Implausible, not impossible.
//
// Directory forms carry a trailing slash, matching how `__tests__/` is
// handled above; without it `__mocks__` could never fire, since it is
// essentially always a directory.
function isTestFile(file) {
  return (
    /(\.test\.[cm]?[jt]sx?$)|(^|\/)__tests__\//.test(file) ||
    /(^|\/)(test-helpers?|test-support|__mocks__)(\.[cm]?[jt]sx?)?$/.test(file) ||
    /(^|\/)(test-helpers?|test-support|__mocks__)\//.test(file)
  )
}

function classify(changedFiles, packages, workspace) {
  const ships = []
  const excluded = []
  const unresolved = []

  const paths = changedFiles.map((c) => c.path)
  const byPackage = new Map()
  for (const pkg of packages) {
    byPackage.set(pkg.dir, { pkg, bundled: bundledSources(pkg), literals: literalMembers(pkg, paths) })
  }

  for (const { path: file, status } of changedFiles) {
    const match = /^packages\/([^/]+)\//.exec(file)
    const entry = match ? byPackage.get(match[1]) : undefined

    if (!entry) {
      // Not in a published package. Attribute it to the deploy surfaces the tree
      // says build it, so the "deploy only" answer comes from this same run. A
      // test file is built into nothing and names no surface; a file outside
      // packages/ (docs, scripts, workflows) belongs to no workspace package.
      const ws = match ? workspace.get(match[1]) : undefined
      const surfaces = ws && !isTestFile(file) ? ws.surfaces : []
      excluded.push({
        file,
        reason: 'not in a published package',
        ...(ws ? { package: ws.pkg.name } : {}),
        ...(surfaces.length > 0 ? { deploySurfaces: surfaces } : {}),
      })
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

    const isSource = /^packages\/[^/]+\/src\//.test(file)
    const isTest = isTestFile(file)

    // A DELETED source cannot be in head's sourcemaps, because it does not exist
    // at head. Absence carries no information here, so the sourcemap evidence
    // simply does not apply — and the removal of a bundled module is a real
    // change to the tarball that a record must name. Counted as shipped, which is
    // also the safe direction: over-inclusive never loses a line from a record.
    if (status === 'D' && isSource && !isTest) {
      ships.push({ file, pkg: pkg.name, via: 'deleted from src/ — its removal changes the bundle' })
      continue
    }

    if (isSource && !isTest) {
      unresolved.push({
        file,
        pkg: pkg.name,
        reason:
          'under src/ but absent from every dist sourcemap — it emits no mapped output (a barrel or type-only module), ' +
          'or nothing imports it from an entry point (dead code, test-support), or the build predates it (stale dist)',
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

// Every #N in the range's subjects. Named `references`, NOT `issues`: a squash
// subject ends in its own PR number, so #2695 came out of the 0.1.36-alpha.0
// range as a PR, not an issue. A release-cutter pasting these into a CASP shard
// under the heading "issues" records PR numbers as issues, and the shard is a
// regulatory record. Distinguishing the two needs the closing-keyword graph,
// which this script does not read — so it reports what it actually measured.
function referencesIn(commits) {
  const refs = new Set()
  for (const { subject } of commits) {
    for (const match of subject.matchAll(/#(\d+)/g)) refs.add(Number(match[1]))
  }
  return [...refs].sort((a, b) => a - b)
}

// Status matters, not just the path. A file DELETED in the range cannot appear in
// head's sourcemaps — it does not exist at head — so status-blind classification
// sends every removed module to `unresolved` with a cause that is provably wrong.
// Its removal is a real change to the tarball and belongs in the record.
function changedFilesInRange(base, head) {
  const raw = git(['diff', '--name-status', `${base}...${head}`])
  if (raw === '') return []
  return raw.split('\n').map((line) => {
    const parts = line.split('\t')
    const status = parts[0][0] // R100 -> R; take the letter only
    // R (rename) and C (copy) both report old and new; the new path is what
    // exists at head. Copies need `diff.renames = copies`, unset here, so this is
    // dormant — but reading parts[1] for a C would name the SOURCE file, which is
    // not the file that changed.
    const path = status === 'R' || status === 'C' ? parts[2] : parts[1]
    return { path, status }
  })
}

// Parse the WHOLE range once and filter by path afterwards. Passing a pathspec
// to `git diff --numstat` applies it BEFORE rename detection, so the old path is
// filtered out, the rename becomes undetectable, and a renamed file is counted as
// a pure add: measured on ba7c46f5, a real +3/-5 rename reported +107/-0 under a
// pathspec, and `--name-status` with the same pathspec called it `A` while the
// unfiltered form called it `R`. Two of the script's own git calls contradicting
// each other is how a wrong number reaches the artifact this script exists to
// produce. Filtering after the parse also removes the `{old => new}` path-form
// hazard, since the path column is never re-read.
function lineStats(base, head, files) {
  if (files.length === 0) return { added: 0, removed: 0, binary: [] }
  const wanted = new Set(files)
  const raw = git(['diff', '--numstat', `${base}...${head}`])
  let added = 0
  let removed = 0
  const binary = []
  for (const line of raw === '' ? [] : raw.split('\n')) {
    const [a, r, pathField] = line.split('\t')
    // A rename renders as `old => new` or `dir/{old => new}/file`; resolve to the
    // new path, which is what the classifier keyed on.
    const path = pathField.includes('=>')
      ? pathField.replace(/\{([^{}]*) => ([^{}]*)\}/, '$2').replace(/^.* => /, '').trim()
      : pathField
    if (!wanted.has(path)) continue
    if (a === '-' || r === '-') {
      binary.push(path) // counted as a file, never as lines — and said so, not silent
      continue
    }
    added += Number(a)
    removed += Number(r)
  }
  return { added, removed, binary }
}

// --- report ------------------------------------------------------------------

// The PR-time statement (#4770). Advisory: it is a line in the pull request, and
// nothing reads it. The three answers are the template's three answers, and the
// train wins when both paths are affected — the published change is the one that
// waits for a release, so it is the one the line has to name.
function releaseLever(packages, surfaces) {
  if (packages.length > 0) {
    return {
      answer: 'next release train',
      line: `next release train — ${packages.join(', ')}${
        surfaces.length > 0 ? ` (also deploys: ${surfaces.join(', ')})` : ''
      }`,
    }
  }
  if (surfaces.length > 0) return { answer: 'deploy only', line: `deploy only — ${surfaces.join(', ')}` }
  return { answer: 'none', line: 'none — nothing published, nothing deployed' }
}

function buildReport(opts) {
  assertUsableCheckout()
  const baseSha = resolveRef(opts.base)
  const headSha = resolveRef(opts.head)

  const packages = publishedPackages()
  const workspace = deploySurfaces(workspacePackages())
  const commits = commitsInRange(baseSha, headSha)
  const changedFiles = changedFilesInRange(baseSha, headSha)
  const { ships, excluded, unresolved } = classify(changedFiles, packages, workspace)

  const shippedFiles = ships.map((s) => s.file)
  const stats = lineStats(baseSha, headSha, shippedFiles)

  // A deleted source is ATTRIBUTED to the tarball, not measured into it: nothing
  // in the head tree can confirm it was bundled, so its lines are inference. Kept
  // as its own sub-total rather than merged into the headline, so a shard author
  // can see how much of the delta rests on that inference.
  const inferredFiles = ships.filter((s) => s.via.startsWith('deleted')).map((s) => s.file)
  const inferred = lineStats(baseSha, headSha, inferredFiles)

  const affected = [...new Set(ships.map((s) => s.pkg))].sort()
  const surfaces = [...new Set(excluded.flatMap((e) => e.deploySurfaces ?? []))].sort()

  return {
    range: { base: opts.base, baseSha, head: opts.head, headSha },
    commits,
    references: referencesIn(commits),
    packages: packages.map((p) => ({ name: p.name, version: p.version })),
    affectedPackages: affected,
    deploySurfaces: surfaces,
    releaseLever: releaseLever(affected, surfaces),
    shipped: {
      files: ships,
      count: ships.length,
      ...stats,
      inferred: { count: inferredFiles.length, added: inferred.added, removed: inferred.removed },
    },
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
  out.push(
    `  refs      ${report.references.length ? report.references.map((i) => `#${i}`).join(' ') : '(none referenced)'}` +
      '   (issue AND pull-request numbers — a squash subject carries its own PR number)',
  )
  out.push('')

  // NOT "publishes to npm": publish.yml is VERSION-gated and skips any version
  // already on the registry, so a promotion carrying no bump publishes nothing
  // however many packages appear here. Saying "publishes" would contradict
  // branch-and-release-flow.md, and this output gets pasted into shards.
  out.push(
    `Published packages affected: ${report.affectedPackages.length ? report.affectedPackages.join(', ') : '(none)'}`,
  )
  out.push('  (the publish skips any version already on the registry, so an unbumped range publishes nothing')
  out.push('   unless a previous publish of that same version failed)')
  out.push('')

  out.push(`Shipped delta: ${report.shipped.count} files, +${report.shipped.added}/-${report.shipped.removed}`)
  if (report.shipped.inferred.count > 0) {
    out.push(
      `  of which attributed, not measured: ${report.shipped.inferred.count} deleted source file(s), ` +
        `+${report.shipped.inferred.added}/-${report.shipped.inferred.removed} — nothing in the head tree can ` +
        `confirm a deleted module was bundled`,
    )
  }
  if (report.shipped.binary.length > 0) {
    out.push(`  ${report.shipped.binary.length} binary file(s) counted as files but not as lines`)
  }
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

  // The other path to an installed agent. Named from the same run as the shipped
  // delta, so the PR-time statement is one command rather than a hand count.
  out.push('')
  out.push(`Deploy surfaces affected: ${report.deploySurfaces.length ? report.deploySurfaces.join(', ') : '(none)'}`)
  out.push('  (unpublished workspace packages that declare a start script, plus the packages they build)')

  if (report.unresolved.length > 0) {
    out.push('')
    out.push(`UNRESOLVED: ${report.unresolved.length} source files could not be classified`)
    for (const entry of report.unresolved) {
      out.push(`  ${entry.file}`)
      out.push(`      ${entry.reason}`)
    }
    out.push('')
    out.push('  These are under src/ in a published package but absent from every dist sourcemap.')
    out.push('  THREE causes, and only the third is a staleness problem:')
    out.push('    1. the file emits no mapped output (a barrel, or a type-only module);')
    out.push('    2. nothing imports it from an entry point (dead code, test support);')
    out.push('    3. the build predates it (a stale dist, which UNDER-reports).')
    out.push('  1 and 2 are benign and a rebuild will not change them, so do not read this list')
    out.push('  as automatically a rebuild instruction. Check which cause applies before deciding')
    out.push('  whether the file belongs in the record. The delta above is measured but not')
    out.push('  complete, which is why this run exits 1 rather than 0.')
  }

  // The line the pull request carries (#4770). Last, so it is the thing left on
  // screen after a long report, and prefixed so it can be copied whole.
  out.push('')
  out.push(`Release lever: ${report.releaseLever.line}`)
  out.push("  (advisory — paste it into the pull request's Release lever line; it gates nothing)")

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

// True only when this file is the process's entry point, so importing it (a
// self-test, a build config) never runs the CLI. Both paths are resolved
// first: Node resolves symlinks for a module's own URL and leaves
// `process.argv[1]` as typed, so an unresolved comparison answered "not the
// entry point" through any symlink, and the script exited 0 without running
// (#4776).
function isEntryPoint() {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntryPoint()) {
  main()
}

export {
  buildReport,
  classify,
  publishedPackages,
  workspacePackages,
  deploySurfaces,
  releaseLever,
  bundledSources,
  literalMembers,
  isTestFile,
  Refusal,
}
