import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LOCKSTEP_LOCKFILE_PATHS,
  bumpLockfileText,
  lockfileDiffViolations,
} from './release-lockfile.mjs'
import {
  MANIFEST_ROWS,
  documentedVersions,
  manifestTableViolations,
  rewriteManifestTable,
} from './release-manifest-doc.mjs'
import {
  formatSnapshotVersion,
  isSnapshotVersion,
  snapshotModeViolation,
} from './release-snapshot-version.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const CUR = '0.1.28-alpha.0'
const NEXT = '0.1.29-alpha.0'

/** A miniature lockfile with every shape the substitution must handle. */
function fixture() {
  const packages = {
    '': { name: 'haven', version: '0.1.0' },
    // A third-party dependency that happens to sit at the SAME version the
    // workspace is leaving. This is why the substitution is structural: a
    // text-wide replace would silently rewrite this entry too.
    'node_modules/some-coincidence': { version: CUR, resolved: 'https://registry.example/x.tgz' },
    'node_modules/@haven_ai/sdk': { resolved: 'packages/sdk', link: true },
  }
  for (const path of LOCKSTEP_LOCKFILE_PATHS) {
    packages[path] = { name: `@haven_ai/${path.slice('packages/'.length)}`, version: CUR }
  }
  packages['packages/signer'].dependencies = { '@haven_ai/sdk': CUR, ethers: '^6.13.0' }
  packages['packages/connect'].dependencies = {
    '@haven_ai/sdk': CUR,
    '@haven_ai/mcp': CUR,
    '@haven_ai/signer': CUR,
  }
  // A private workspace consumer's "*" pin must never be rewritten to a
  // concrete version — that is the #1526 hazard in the other direction.
  packages['packages/mcp-server'].dependencies = { '@haven_ai/sdk': '*' }
  return JSON.stringify({ name: 'haven', version: '0.1.0', lockfileVersion: 3, packages }, null, 2) + '\n'
}

test('the substitution moves every lockstep version and internal pin, and nothing else', () => {
  const before = fixture()
  const after = bumpLockfileText(before, { currentVersion: CUR, newVersion: NEXT })
  const lock = JSON.parse(after)

  for (const path of LOCKSTEP_LOCKFILE_PATHS) {
    assert.equal(lock.packages[path].version, NEXT, path)
  }
  assert.equal(lock.packages['packages/connect'].dependencies['@haven_ai/mcp'], NEXT)
  // The whole diff is version lines — the property the release commit claims.
  assert.deepEqual(lockfileDiffViolations(before, after, { currentVersion: CUR, newVersion: NEXT }), [])
})

test('MUTATION PROOF: a third-party dep at the SAME version is left alone', () => {
  // This is the case that separates structural substitution from
  // `sed s/old/new/g`. Nothing stops an unrelated dependency from being at
  // 0.1.28 the day the workspace leaves 0.1.28.
  const after = bumpLockfileText(fixture(), { currentVersion: CUR, newVersion: NEXT })
  assert.equal(JSON.parse(after).packages['node_modules/some-coincidence'].version, CUR)
})

test('a private consumer\'s "*" pin survives the bump untouched (#1526)', () => {
  const after = bumpLockfileText(fixture(), { currentVersion: CUR, newVersion: NEXT })
  assert.equal(JSON.parse(after).packages['packages/mcp-server'].dependencies['@haven_ai/sdk'], '*')
})

test('refuses a lockfile whose entries disagree with the claimed current version', () => {
  // Drift a LOCKSTEP entry structurally — a text replace would hit the
  // third-party coincidence entry first, which is allowed to sit anywhere.
  const lock = JSON.parse(fixture())
  lock.packages['packages/sdk'].version = '0.0.1'
  const drifted = JSON.stringify(lock, null, 2) + '\n'
  // One workspace entry at the wrong version means package.json and the
  // lockfile disagree — substituting anyway would paper over real drift.
  assert.throws(
    () => bumpLockfileText(drifted, { currentVersion: CUR, newVersion: NEXT }),
    /disagree about the current version/,
  )
})

test('refuses a lockfile missing a lockstep entry', () => {
  const lock = JSON.parse(fixture())
  delete lock.packages['packages/cli']
  assert.throws(
    () => bumpLockfileText(JSON.stringify(lock, null, 2) + '\n', { currentVersion: CUR, newVersion: NEXT }),
    /no entry for packages\/cli/,
  )
})

test('refuses input that does not round-trip — a rewrite would reformat the whole file', () => {
  // 4-space indentation parses fine but would come back 2-spaced, burying the
  // version lines in whitespace churn across every line of the file.
  const fourSpaced = JSON.stringify(JSON.parse(fixture()), null, 4) + '\n'
  assert.throws(
    () => bumpLockfileText(fourSpaced, { currentVersion: CUR, newVersion: NEXT }),
    /round-trip/,
  )
})

test('MUTATION PROOF: the diff guard catches the exact 0.1.28 pollution shape', () => {
  // Reproduce what npm actually did on the #1662 cut: leave the version lines
  // alone and insert "dev": true on an unrelated entry. This is what step 7's
  // guard sees if the deterministic rewrite is ever removed — the AC's
  // "verify by reverting the normalisation and watching it fail".
  const before = fixture()
  const polluted = before.replace(
    '"resolved": "https://registry.example/x.tgz"',
    '"resolved": "https://registry.example/x.tgz",\n      "dev": true',
  )
  const violations = lockfileDiffViolations(before, polluted)
  assert.ok(violations.length > 0, 'pollution passed the guard')
  assert.match(violations.join('\n'), /"dev": true/)
})

test('the guard names an in-place non-version change too, with its line number', () => {
  const before = fixture()
  const tampered = before.replace('"link": true', '"link": false')
  const violations = lockfileDiffViolations(before, tampered)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /^line \d+: "link": true → "link": false$/)
})

test('a pure version-line diff has zero violations — including pin lines', () => {
  const before = fixture()
  const after = bumpLockfileText(before, { currentVersion: CUR, newVersion: NEXT })
  assert.deepEqual(lockfileDiffViolations(before, after, { currentVersion: CUR, newVersion: NEXT }), [])
  // And identical text is trivially clean.
  assert.deepEqual(lockfileDiffViolations(before, before, { currentVersion: CUR, newVersion: NEXT }), [])
})

test('the REAL lockfile round-trips and carries every lockstep entry the module expects', async () => {
  // The fixture proves the logic; this proves the assumptions hold against
  // the actual file the release will touch. If npm's serialization changes,
  // or a workspace is renamed, this fails HERE rather than mid-release.
  const real = await readFile(join(ROOT, 'package-lock.json'), 'utf8')
  const lock = JSON.parse(real)
  assert.equal(JSON.stringify(lock, null, 2) + '\n', real, 'npm serialization changed')
  const versions = new Set()
  for (const path of LOCKSTEP_LOCKFILE_PATHS) {
    assert.ok(lock.packages[path], `missing ${path}`)
    versions.add(lock.packages[path].version)
  }
  assert.equal(versions.size, 1, `lockstep versions diverged: ${[...versions].join(', ')}`)
})

test('MUTATION PROOF: a corrupted unrelated version cannot wear a version line as cover', () => {
  // The hardening the review asked for: the guard is the last line of defense
  // against a bug in bumpLockfileText ITSELF, so "some version line changed"
  // is not enough — it must be the right key moving exactly current → new.
  const before = fixture()
  // Same line count, valid version-line shape, but an unrelated dep's version
  // rewritten to garbage. A shape-only guard passes this; the exact one fails.
  const corrupted = bumpLockfileText(before, { currentVersion: CUR, newVersion: NEXT })
    .replace(`"version": "${CUR}",\n      "resolved"`, '"version": "9.9.9",\n      "resolved"')
  const violations = lockfileDiffViolations(before, corrupted, { currentVersion: CUR, newVersion: NEXT })
  assert.ok(violations.some((v) => v.includes('9.9.9')), `garbage version passed the guard: ${violations}`)
})

/**
 * #1788: the script used to sign off by printing `npm publish` invocations —
 * the one action CLAUDE.md and the release skill forbid in three separate
 * places. The rule was prose in three files and the tool contradicted it at
 * the moment of maximum trust, right after the bump had succeeded.
 *
 * Prose cannot guard a script. These tests do, scoped to the sign-off block so
 * the prohibition sentence itself (which necessarily contains the words
 * "npm publish") is not mistaken for an instruction to run it.
 */
async function doneBlock() {
  const source = await readFile(join(ROOT, 'scripts', 'release-bump.mjs'), 'utf8')
  const start = source.indexOf("header('Done')")
  assert.notEqual(start, -1, "release-bump.mjs no longer has a header('Done') sign-off block")
  const end = source.indexOf('\nmain().catch', start)
  assert.notEqual(end, -1, 'could not find the end of main() after the Done block')
  return source.slice(start, end)
}

/**
 * What the script PRINTS, not what its source says. The block carries a
 * comment explaining the #1788 defect — which necessarily names @haven_ai/cli
 * and the words "npm publish" — and a guard that read the raw source would
 * trip on the very explanation of why it exists.
 */
function emitted(block) {
  return block
    .split('\n')
    .filter((line) => line.trim().startsWith('log('))
    .join('\n')
}

test('MUTATION PROOF: the sign-off never emits an npm publish instruction (#1788)', async () => {
  const printed = emitted(await doneBlock())
  // Every legitimate mention is the backtick-quoted one inside the
  // prohibition sentence. Strip those, and NOTHING may remain — this catches
  // a bare `npm publish` with no flags, which an earlier flag-shaped regex
  // let through (review finding on #1788).
  const leftover = printed.replace(/`npm publish`/g, '').match(/npm publish/g)
  assert.equal(
    leftover,
    null,
    `release-bump.mjs must not instruct a manual publish; found ${leftover?.length} unquoted mention(s)`,
  )
})

test('the sign-off enumerates no packages, in flags or in prose (#1788)', async () => {
  const printed = emitted(await doneBlock())
  // Doc paths legitimately contain package-ish substrings
  // (mcp-runtime-compatibility.md), and they are not enumerations.
  const prose = printed.replace(/\S*\/\S*/g, '').replace(/publish\.yml/g, '')
  // The original defect listed four of the five published packages. Catch that
  // shape however it is written — `-w packages/sdk` or "sdk, signer, mcp,
  // connect and cli" — because the second form slipped past a flag-only regex.
  const named = prose.match(/\b(sdk|signer|mcp|connect|cli)\b/gi)
  assert.equal(
    named,
    null,
    `the sign-off must not name packages — the published set is derived, not restated; found: ${JSON.stringify(named)}`,
  )
})

test('the sign-off still tells the operator publishing is not theirs to do (#1788)', async () => {
  const block = await doneBlock()
  // Removing the defect must not also remove the guidance: silence would let
  // the next reader assume publishing is a manual step nobody wrote down.
  assert.match(block, /Never run `npm publish` by hand/)
  assert.match(block, /promotion/)
})

/**
 * #1791: the documented manual fallback in scripts/README.md claims to publish
 * "the same versions the workflow would have published" and published four of
 * five — @haven_ai/cli was missing from the dist-wipe, the builds and the
 * publish. It is the break-glass path, taken mid-incident under time pressure,
 * with no per-package summary to reveal the gap.
 *
 * The irony this guard exists to prevent recurring: the paragraph immediately
 * above that block narrates @haven_ai/cli being missed in the 2026-08-07
 * release (#1159) and staying invisible for six weeks.
 *
 * The set is DERIVED from each workspace's `private` flag — the same test
 * release-bump.mjs and workspace-pin-lint.mjs already apply — because a fifth
 * hand-maintained copy is the defect, not the fix.
 *
 * Note LOCKSTEP_LOCKFILE_PATHS is deliberately NOT reused here: it carries six
 * entries including mcp-server, whose version moves in lockstep but which is
 * private and must never be published.
 */
async function publishedPackageDirs() {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(join(ROOT, 'packages'))
  const published = []
  for (const dir of entries) {
    let manifest
    try {
      manifest = JSON.parse(await readFile(join(ROOT, 'packages', dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    if (manifest.private !== true) published.push(dir)
  }
  return published.sort()
}

async function manualFallbackBlock() {
  const readme = await readFile(join(ROOT, 'scripts', 'README.md'), 'utf8')
  const start = readme.indexOf('#### Manual fallback')
  assert.notEqual(start, -1, 'scripts/README.md no longer has a "Manual fallback" section')
  const end = readme.indexOf('\n### ', start)
  assert.notEqual(end, -1, 'could not find the end of the Manual fallback section')
  return readme.slice(start, end)
}

/**
 * The PROD-channel build step of `publish.yml`, and ONLY it (#2421).
 *
 * The three `#1791` guards below compare the emergency manual fallback in
 * `scripts/README.md` against "what publish.yml builds". That used to be the
 * whole file, because the file had one build step. Since #2421 it has two —
 * the prod step, and the dev-channel snapshot step, which builds `cli`
 * explicitly because `release-bump.mjs` wipes its dist and never rebuilds it.
 * A whole-file scan therefore reads `['cli', 'sdk', 'signer', 'mcp',
 * 'connect', 'cli']` and fails against a `scripts/README.md` that is not
 * wrong: the manual fallback is the break-glass substitute for the PROD
 * publish path, so the prod step is the only thing it can meaningfully
 * mirror.
 *
 * Narrowing a guard is how guards die, so the narrowing is pinned: this
 * asserts the step it selected really carries the prod `if:` condition. If
 * someone renames the step, drops the condition, or points the dev step at
 * this name, the helper fails loudly rather than silently returning the wrong
 * step's build list — or an empty one, which would make every assertion below
 * vacuously true.
 */
function prodBuildStep(workflow) {
  return workflowStep(workflow, 'Build published packages in dependency order', 'prod')
}

/** The dev-channel snapshot step, selected and pinned the same way. */
function devSnapshotStep(workflow) {
  return workflowStep(workflow, 'Bump the throwaway tree to a snapshot version and build', 'dev')
}

function workflowStep(workflow, name, channel) {
  // BRITTLE BY CONSTRUCTION, and deliberately so: this reads YAML structure
  // with string matching, because this suite has no third-party imports. The
  // `\n      - name:` sentinel below assumes the six-space step indentation
  // `publish.yml` uses today. An unrelated reformat of that file — a job
  // rename, a nesting change, a switch to flow style — would move it.
  //
  // That is acceptable ONLY because every failure here is a throw. If you are
  // editing this because it broke, the fix is to re-point the matcher at the
  // real structure, never to relax an assertion until it passes: these helpers
  // feed the guards for the production publish path, and a matcher that
  // silently selects nothing turns all of them green.
  const start = workflow.indexOf(`- name: ${name}`)
  assert.notEqual(start, -1, `publish.yml no longer has a step named "${name}"`)
  const rest = workflow.slice(start)
  const next = rest.indexOf('\n      - name:')
  const step = next === -1 ? rest : rest.slice(0, next)
  assert.match(
    step,
    new RegExp(`if: steps\\.channel\\.outputs\\.channel == '${channel}'`),
    `the step "${name}" is no longer the ${channel}-channel one — rescope this guard rather than deleting the assertion`,
  )
  return step
}

test('the manual fallback publishes every published package, and only those (#1791)', async () => {
  const block = await manualFallbackBlock()
  const expected = await publishedPackageDirs()
  // The publish loop is the authoritative list in that block.
  const loop = block.match(/for pkg in ([^;]+); do\s*\n\s*npm publish/)
  assert.ok(loop, 'the manual fallback no longer publishes via a "for pkg in ..." loop')
  const listed = loop[1].trim().split(/\s+/).sort()
  assert.deepEqual(
    listed,
    expected,
    'the manual fallback publish list has drifted from the packages whose package.json is not private',
  )
})

test('the manual fallback builds and wipes every package it publishes (#1791)', async () => {
  const block = await manualFallbackBlock()
  const expected = await publishedPackageDirs()
  const wipe = block.match(/rm -rf packages\/\{([^}]+)\}\/dist/)
  assert.ok(wipe, 'the manual fallback no longer wipes dist with a brace-expanded list')
  assert.deepEqual(
    wipe[1].split(',').map((s) => s.trim()).sort(),
    expected,
    'the dist-wipe list has drifted from the published set — a stale dist ships in the tarball',
  )
  for (const pkg of expected) {
    assert.match(
      block,
      new RegExp(`npm run build -w packages/${pkg}\\b`),
      `the manual fallback publishes ${pkg} but never builds it`,
    )
  }
})

test('the manual fallback builds in the order publish.yml builds in (#1791)', async () => {
  // Membership is not enough, and the block's own prose says why: connect's
  // tsup INLINES MCP_VERSION, so building connect before a fresh mcp bundles a
  // stale one. Review on #1791 proved the point — swapping the mcp and connect
  // build lines left every other guard here passing.
  const block = await manualFallbackBlock()
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8')
  const order = (text) =>
    [...text.matchAll(/npm run build -w packages\/(\S+)/g)].map((m) => m[1])

  const documented = order(block)
  // Scoped to the PROD step since #2421 — see prodBuildStep() for why, and for
  // what stops the scoping from quietly selecting nothing.
  const actual = order(prodBuildStep(workflow))
  assert.ok(actual.length > 0, 'publish.yml no longer builds packages with `npm run build -w`')
  assert.equal(
    actual.length,
    (await publishedPackageDirs()).length,
    'the prod build step no longer builds every published package — the scoping above may have selected the wrong step',
  )
  assert.deepEqual(
    documented,
    actual,
    'the manual fallback build ORDER has drifted from publish.yml — a stale dist gets bundled',
  )
})

test('the manual fallback tells the operator to verify on the registry (#1791)', async () => {
  const block = await manualFallbackBlock()
  // This path has no per-package summary and does not stop on a partial
  // failure, so "it printed no error" is not evidence anything published.
  assert.match(block, /npm view/)
  assert.match(block, /dist-tags/)
})

/**
 * #1795: scripts/README.md stated the published-package count twice, in the
 * same file, differently — "the four published packages" at the top and "all
 * five" further down. Both stale lines predated @haven_ai/cli becoming
 * published (`3f6e9959c`), and neither was wrong in a way any check could see.
 *
 * Third instance of one root cause in three days (#1159, #1526, #1791): the
 * published set is hand-written in several places and each copy drifts on its
 * own. So this guard, like #1791's above, DERIVES the set from each workspace's
 * `private` flag rather than adding a fifth hand-maintained copy.
 *
 * Scoped deliberately to the two enumerations that claim to BE the set. Prose
 * elsewhere in the file names packages for other reasons — the build order
 * (`sdk → signer → mcp → connect`, correct WITHOUT cli), the `private`-rule
 * table, the #1159 story about cli — and a file-wide "every package name must
 * appear" rule would fail on all of them and push the next author to weaken it.
 */
function namedPackages(text) {
  return [...text.matchAll(/`@haven_ai\/([a-z-]+)`/g)].map((m) => m[1]).sort()
}

async function readmeText() {
  return readFile(join(ROOT, 'scripts', 'README.md'), 'utf8')
}

test('the README\'s "problem it solves" names exactly the published set (#1795)', async () => {
  const readme = await readmeText()
  const sentence = readme.match(/^A version bump for the .*$/m)
  assert.ok(sentence, 'scripts/README.md no longer opens release-bump.mjs with "A version bump for the ..."')
  assert.deepEqual(
    namedPackages(sentence[0]),
    await publishedPackageDirs(),
    'the opening sentence enumerates a published set that has drifted from the non-private workspaces',
  )
})

test('the README\'s version-bump step names exactly the LOCKSTEP set (#1795)', async () => {
  // Not the same set as above, and the difference is the whole point: the
  // script bumps mcp-server's version too (VERSIONED_PACKAGES), for coherence
  // with HOSTED_SERVER_VERSION, while mcp-server stays private and unpublished.
  // Conflating the two is how ":105" came to say "four".
  const readme = await readmeText()
  const step = readme.match(/^4\. \*\*Update\*\* the `version` field.*$/m)
  assert.ok(step, 'scripts/README.md step 4 is no longer the version-field update step')
  const expected = [...(await publishedPackageDirs()), 'mcp-server'].sort()
  const named = [...step[0].matchAll(/`([a-z-]+)`/g)]
    .map((m) => m[1])
    .filter((n) => expected.includes(n))
    .sort()
  assert.deepEqual(
    [...new Set(named)],
    expected,
    'step 4 enumerates a lockstep set that has drifted from (non-private workspaces + mcp-server)',
  )
})

test('the sign-off names release shards by version, never by PR number (#1789)', async () => {
  // The reviewer pass on this change found this line still teaching the retired
  // convention after all three DOCS had been corrected — and it is the copy a
  // release-cutter actually reads, at the moment they are about to write the
  // shard. A PR-numbered name is unsatisfiable by construction: the coupling
  // gate blocks the PR until the shard exists, so the number does not exist
  // yet. Nothing validates a shard filename, so a wrong name never fails
  // anything; it just persists as a mislabelled compliance record.
  const printed = emitted(await doneBlock())
  const shardLine = printed.match(/^.*casp-changelog.*$/m)
  assert.ok(shardLine, 'the sign-off no longer tells the operator to write a CASP shard')
  assert.doesNotMatch(
    shardLine[0],
    /<pr>|<PR>/,
    'the sign-off names the shard after the PR number, which cannot be known when the shard must be written (#1789)',
  )
  // It interpolates the real version rather than a placeholder, so the operator
  // has nothing left to guess.
  assert.match(
    shardLine[0],
    /newVersion\}-release\.md/,
    'the sign-off should print the actual release version in the shard filename',
  )
})

test('no surviving prose calls the published set "four" (#1795)', async () => {
  const readme = await readmeText()
  // Whitespace-collapsed so a hand-rewrap that puts "four" and "packages" on
  // adjacent LINES cannot slip past (review nit). Still sentence-bounded: the
  // file legitimately says things like "four more source constants appeared".
  const stale = readme
    .replace(/\s+/g, ' ')
    .match(/\bfour\b[^.]*\bpackages?\b|\bpackages?\b[^.]*\bfour\b/gi)
  assert.equal(
    stale,
    null,
    `scripts/README.md still describes a package set as "four": ${JSON.stringify(stale)}`,
  )
})

/**
 * #1790: the Supported Runtime Manifest table in
 * docs/operations/mcp-runtime-compatibility.md re-pins four rows to the new
 * version on every release. It was written by hand, next to a script that
 * already knew the number, already wrote it into the source, and already
 * verified the built bundle against it.
 *
 * The bump now writes it. The hazard that creates is the one this repo has
 * produced a dozen times in two days: a script that writes a value and then
 * verifies its own write is a guard that cannot fail. So the verification never
 * receives the version the bump computed — `manifestTableViolations` reads each
 * row's OWN source constant and compares the doc against that.
 *
 * These tests therefore prove two different things:
 *   - the rewrite does what it claims (and refuses when the table shape moves);
 *   - the CHECK fails on a table the script did not just write — a hand-edited
 *     doc, or one that drifted because a constant moved without a re-pin. That
 *     is the property that makes it a guard rather than a receipt, and the last
 *     test runs it against the REAL repo files on every CI run.
 */

const MANIFEST_DOC = join(ROOT, 'docs', 'operations', 'mcp-runtime-compatibility.md')

/** A minimal table in the real doc's shape. */
function docFixture(versions = {}) {
  const v = {
    connect: CUR, mcp: CUR, sdk: CUR, signer: CUR, ...versions,
  }
  return [
    '## Supported Runtime Manifest',
    '',
    'Keep this table in sync with that file.',
    '',
    '| Component | Supported version |',
    '| --- | --- |',
    '| Node.js | >= 22.0.0 (`engines` floor) |',
    '| `@haven_ai/connect` | `' + v.connect + '` |',
    '| `@haven_ai/mcp` | `' + v.mcp + '` |',
    '| `@haven_ai/sdk` | `' + v.sdk + '` |',
    '| `@haven_ai/signer` | `' + v.signer + '` |',
    '| Claude Code | local stdio MCP |',
    '',
  ].join('\n')
}

function sourceFixture(versions = {}) {
  const v = { connect: CUR, mcp: CUR, sdk: CUR, signer: CUR, ...versions }
  return {
    'packages/connect/src/runtime.ts': `export const CONNECTOR_VERSION = '${v.connect}'\n`,
    'packages/mcp/src/server.ts': `export const MCP_VERSION = '${v.mcp}'\n`,
    'packages/connect/src/runtime-manifest.ts':
      `export const M = {\n  sdkVersion: '${v.sdk}',\n  signerVersion: '${v.signer}',\n}\n`,
  }
}

test('the rewrite re-pins every owned row and touches nothing else (#1790)', () => {
  const before = docFixture()
  const after = rewriteManifestTable(before, NEXT)
  assert.deepEqual(documentedVersions(after), {
    '@haven_ai/connect': NEXT,
    '@haven_ai/mcp': NEXT,
    '@haven_ai/sdk': NEXT,
    '@haven_ai/signer': NEXT,
  })
  // The Node.js and client rows are not version-pinned and must survive intact.
  assert.match(after, /\| Node\.js \| >= 22\.0\.0/)
  assert.match(after, /\| Claude Code \| local stdio MCP \|/)
  assert.equal(after.split('\n').length, before.split('\n').length)
})

test('the rewrite REFUSES a table whose shape moved, rather than no-oping (#1790)', () => {
  // A silent skip here is how a release ships a stale contract doc while every
  // check stays green — the table is the one thing the gate does not read.
  const withoutSigner = docFixture().replace(/^\| `@haven_ai\/signer`.*$\n/m, '')
  assert.throws(
    () => rewriteManifestTable(withoutSigner, NEXT),
    /no row for: @haven_ai\/signer/,
  )
})

test('a table matching its sources has no violations (#1790)', () => {
  assert.deepEqual(manifestTableViolations(docFixture(), sourceFixture()), [])
})

test('MUTATION PROOF: the check catches a HAND-EDITED table (#1790)', () => {
  // The defect class this guard exists for: the script did not write this
  // table, a human did, and got one row wrong. Nothing else in the repo reads
  // the table, so without this the doc simply lies from then on.
  const tampered = docFixture({ sdk: '0.1.27-alpha.0' })
  const violations = manifestTableViolations(tampered, sourceFixture())
  assert.equal(violations.length, 1)
  assert.match(violations[0], /@haven_ai\/sdk: table says '0\.1\.27-alpha\.0'/)
  assert.match(violations[0], /sdkVersion in packages\/connect\/src\/runtime-manifest\.ts is '0\.1\.28-alpha\.0'/)
})

test('MUTATION PROOF: the check catches a DRIFTED source, doc untouched (#1790)', () => {
  // The other direction, and the one a release-time-only check would miss: the
  // doc is exactly what the last release wrote, but a constant moved since.
  const violations = manifestTableViolations(docFixture(), sourceFixture({ mcp: NEXT }))
  assert.equal(violations.length, 1)
  assert.match(violations[0], /@haven_ai\/mcp: table says/)
})

test('MUTATION PROOF: the check does not accept its own writer as evidence (#1790)', () => {
  // The heart of #1790. Rewriting the doc to a version NO SOURCE carries must
  // still fail — if the check took the bump's word for the version, this would
  // pass and the guard would be a receipt for its own write.
  const written = rewriteManifestTable(docFixture(), '9.9.9-invented.0')
  const violations = manifestTableViolations(written, sourceFixture())
  assert.equal(violations.length, 4, 'every row must be reported, not just the first')
  for (const v of violations) assert.match(v, /9\.9\.9-invented\.0/)
})

test('a renamed source constant FAILS rather than passing quietly (#1790)', () => {
  const renamed = sourceFixture()
  renamed['packages/mcp/src/server.ts'] = "export const MCP_SERVER_VERSION = '0.1.28-alpha.0'\n"
  const violations = manifestTableViolations(docFixture(), renamed)
  assert.equal(violations.length, 1)
  assert.match(violations[0], /MCP_VERSION not found/)
})

test('a missing table row FAILS rather than passing quietly (#1790)', () => {
  const withoutConnect = docFixture().replace(/^\| `@haven_ai\/connect`.*$\n/m, '')
  const violations = manifestTableViolations(withoutConnect, sourceFixture())
  assert.equal(violations.length, 1)
  assert.match(violations[0], /has no `@haven_ai\/connect` row/)
})

test('the bump verifies the table WITHOUT being told what it just wrote (#1790)', async () => {
  // The property everything else here rests on, pinned structurally so a later
  // "tidy-up" cannot quietly undo it. The moment `verifyManifestDoc` is handed
  // the version this run computed, it stops being able to disagree with the
  // write that preceded it — a guard that confirms its own output, which is the
  // defect class this repo has produced repeatedly.
  const source = await readFile(join(ROOT, 'scripts', 'release-bump.mjs'), 'utf8')

  const declaration = source.match(/async function verifyManifestDoc\(([^)]*)\)/)
  assert.ok(declaration, 'release-bump.mjs no longer declares verifyManifestDoc')
  assert.equal(
    declaration[1].trim(),
    '',
    'verifyManifestDoc must take NO arguments — it compares the doc against the source constants on disk, never against the version this run computed',
  )

  const calls = [...source.matchAll(/await verifyManifestDoc\(([^)]*)\)/g)]
  assert.equal(calls.length, 1, 'expected exactly one verifyManifestDoc() call in the release path')
  assert.equal(calls[0][1].trim(), '', 'verifyManifestDoc must be called with no arguments')

  // And it must actually run after the write, not instead of it.
  assert.ok(
    source.indexOf('await updateManifestDoc(') < source.indexOf('await verifyManifestDoc()'),
    'the manifest doc must be written before it is verified',
  )
})

test('the REAL manifest table agrees with the REAL source constants (#1790)', async () => {
  // This is the one that runs on every pull request (ci.yml → "Release-bump
  // lockfile self-test", an unconditional job). It is what makes the check a
  // drift guard rather than a release-time formality: a hand-edited or drifted
  // table fails here, with no release in sight.
  const doc = await readFile(MANIFEST_DOC, 'utf8')
  const sources = {}
  for (const spec of MANIFEST_ROWS) {
    sources[spec.file] = await readFile(join(ROOT, spec.file), 'utf8')
  }
  assert.deepEqual(
    manifestTableViolations(doc, sources),
    [],
    'the Supported Runtime Manifest table has drifted from the version constants it mirrors',
  )
})

/* ────────────────────────────────────────────────────────────────────────────
 * Dev-channel snapshots (#2421, epic #2420)
 *
 * `.github/workflows/publish.yml` publishes a snapshot of every published
 * package on each package-touching push to `dev`, under the `dev` dist-tag.
 * The version shape and the mode check live in release-snapshot-version.mjs
 * because two consumers must agree about them: the workflow PRODUCES the
 * version, this script VALIDATES it.
 *
 * The invariant these cases exist for: a snapshot must never be able to land
 * on `alpha` or `latest`, and the `main` path must never publish a
 * 0.0.0-dev.* version. publish.yml holds the first two enforcement points;
 * this file holds the third, and it is the one that matters when a HUMAN is
 * at the keyboard — a snapshot version committed to a release branch would
 * ride the dev → main promotion straight onto the production channel.
 * ──────────────────────────────────────────────────────────────────────────── */

const SNAP = '0.0.0-dev.202609021905.abc1234'

test('the snapshot version has the documented shape (#2421)', () => {
  assert.equal(
    formatSnapshotVersion({ timestamp: '202609021905', sha: 'abc1234' }),
    SNAP,
  )
  assert.ok(isSnapshotVersion(SNAP))
  // Longer short-shas are legal — `git rev-parse --short` lengthens as a
  // repository grows, and a version that stops validating on a busy Tuesday
  // is a guard that fails for the wrong reason.
  assert.ok(isSnapshotVersion(formatSnapshotVersion({ timestamp: '202609021905', sha: 'abc1234def90' })))
  // An uppercase sha is normalised rather than refused.
  assert.equal(formatSnapshotVersion({ timestamp: '202609021905', sha: 'ABC1234' }), SNAP)
})

test('a malformed timestamp or sha is refused, not silently normalised (#2421)', () => {
  assert.throws(() => formatSnapshotVersion({ timestamp: '2026090219', sha: 'abc1234' }), /12 digits/)
  assert.throws(() => formatSnapshotVersion({ timestamp: '202609021905', sha: 'abcd' }), /7-40 hex/)
  assert.throws(() => formatSnapshotVersion({ timestamp: '202609021905', sha: 'zzzzzzz' }), /7-40 hex/)
})

test('an all-digit short sha with a leading zero is refused — semver rejects it (#2421)', () => {
  // Not a hypothetical and not cosmetic: semver forbids a leading zero in a
  // NUMERIC prerelease identifier, so `0.0.0-dev.<ts>.0123456` is not a valid
  // version at all. Verified against the workspace semver: it returns null for
  // that string and a version for `…​.1234567`. Roughly 1 commit in 268 —
  // first character '0' (1/16), remaining six all digits ((10/16)^6). Refused
  // here, where the message can say what to do,
  // rather than 90 seconds later inside the bump with "not a valid semver
  // string".
  assert.throws(() => formatSnapshotVersion({ timestamp: '202609021905', sha: '0123456' }), /leading zero/)
  // All digits WITHOUT a leading zero is a legal numeric identifier and must
  // still be accepted — refusing it too would be the over-broad guard.
  assert.equal(
    formatSnapshotVersion({ timestamp: '202609021905', sha: '1234567' }),
    '0.0.0-dev.202609021905.1234567',
  )
})

test('MUTATION PROOF: the mode check refuses a snapshot version WITHOUT --snapshot (#2421)', () => {
  // The direction that protects production. A 0.0.0-dev.* version reaching a
  // release branch is not caught by anything else in the repository: the
  // lockfile guard, the manifest-table check and the bundle verifier are all
  // happy with it, and publish.yml would then see it on the `main` ref.
  const violation = snapshotModeViolation(SNAP, { snapshot: false })
  assert.match(String(violation), /alpha\/latest|alpha or latest/)
  // And it is the SNAPSHOT-ness that trips it, not the string's novelty:
  // ordinary release versions pass the same call unchanged.
  for (const ok of ['0.1.29-alpha.0', '0.2.0', '1.0.0-beta.3']) {
    assert.equal(snapshotModeViolation(ok, { snapshot: false }), null, ok)
  }
})

test('MUTATION PROOF: the mode check refuses a real version WITH --snapshot (#2421)', () => {
  // The other direction, which protects the dev channel rather than prod: a
  // snapshot run that somehow carried a real version would publish that real
  // version out of an unreviewed `dev` commit.
  assert.match(String(snapshotModeViolation('0.1.29-alpha.0', { snapshot: true })), /--snapshot requires/)
  // A version that merely LOOKS snapshot-ish is not good enough either — the
  // prefix is not the shape.
  assert.match(String(snapshotModeViolation('0.0.0-dev.abc', { snapshot: true })), /--snapshot requires/)
  assert.equal(snapshotModeViolation(SNAP, { snapshot: true }), null)
})

test('the bump wires the mode check in BEFORE it writes anything (#2421)', async () => {
  // A check that runs after the first write leaves a half-bumped tree behind
  // on refusal, and — worse for the invariant — proves nothing about a run
  // that was going to fail anyway. Assert on the ORDER in the source, because
  // no unit test of a pure function can see it.
  const source = await readFile(join(ROOT, 'scripts', 'release-bump.mjs'), 'utf8')
  const check = source.indexOf('snapshotModeViolation(')
  const firstWrite = source.indexOf('await updatePackageVersion(')
  assert.ok(check !== -1, 'release-bump.mjs no longer calls snapshotModeViolation')
  assert.ok(firstWrite !== -1, 'could not find the first package.json write')
  assert.ok(
    check < firstWrite,
    'release-bump.mjs checks snapshot mode AFTER it starts writing — a refusal would leave a half-bumped tree',
  )
  // The flag is read from argv, not inferred from the version. Inferring it
  // would make the check tautological: every 0.0.0-dev.* version would define
  // itself as an intentional snapshot.
  assert.match(source, /process\.argv\.includes\('--snapshot'\)/)
})

test('the snapshot sign-off does not print the release checklist (#2421)', async () => {
  // The release sign-off tells the operator to write a CASP shard, run the
  // coupling gate and open a PR from a release branch. In a snapshot run there
  // is no branch and no commit — the CI tree is discarded — so printing it
  // would be an instruction nobody can follow, in the logs of a job that has
  // already done everything asked of it.
  const block = await doneBlock()
  const snapshotBranch = block.slice(block.indexOf('if (snapshot) {'), block.indexOf('log(`\\n  Released:'))
  assert.ok(snapshotBranch.length > 100, 'the sign-off no longer has a snapshot branch')
  const printed = emitted(snapshotBranch)
  for (const forbidden of ['casp-changelog', 'release branch', 'docs:coupling']) {
    assert.ok(!printed.includes(forbidden), `the snapshot sign-off must not mention "${forbidden}"`)
  }
  // It must still say the thing that is true and non-obvious.
  assert.match(printed, /THROWAWAY/)
})

test('the dev-channel snapshot BUILDS every package it publishes (#2421)', async () => {
  // The defect this exists for, found by hand during #2421 and nearly shipped:
  // `release-bump.mjs` wipes ALL five dists (`wipeAllDists()` iterates
  // `PACKAGES`) but deliberately does not rebuild `cli` — its builds exist to
  // verify the connect bundle, and `cli` inlines nothing that check reads.
  // On the PROD channel that is harmless, because publish.yml's own build step
  // rebuilds every published package from a clean checkout. On the DEV channel
  // the bump IS the build, so `@haven_ai/cli` would have been published with an
  // empty `dist` — its `files` ships `dist` and its `main` points into it, so
  // the tarball would install and then fail to run.
  //
  // Nothing else in the repository can see this: the wipe list and the build
  // list live in different files, and both are individually correct.
  const expected = await publishedPackageDirs()
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8')
  const bump = await readFile(join(ROOT, 'scripts', 'release-bump.mjs'), 'utf8')

  // Both derivations below read CALL STYLE, not behaviour, and are therefore
  // coupled to how release-bump.mjs happens to spell its builds today:
  // `run('npm', ['run', 'build', '-w', 'packages/sdk'])`. Rewriting those calls
  // — a helper, a loop over PACKAGES, a template literal — would stop matching
  // without changing what is built. The explicit non-empty assertions below
  // exist for exactly that: a zero-match must fail as a zero-match, and not be
  // rescued by the accident that "no package is built" also happens to trip the
  // missing-packages assertion at the end. Guaranteed, not incidental.
  const builtByBump = [...bump.matchAll(/'build', '-w', 'packages\/([\w-]+)'/g)].map((m) => m[1])
  assert.ok(
    builtByBump.length > 0,
    'read no builds out of release-bump.mjs — its build calls were reworded and this ' +
      'derivation is now blind. Re-point the matcher; do not relax the assertion.',
  )
  // connect is built by invoking tsup in its directory rather than through the
  // workspace script — see the build-order comment in release-bump.mjs.
  if (/join\(ROOT, 'packages', 'connect'\)/.test(bump)) builtByBump.push('connect')

  const builtByStep = [...devSnapshotStep(workflow).matchAll(/npm run build -w packages\/(\S+)/g)]
    .map((m) => m[1])
  assert.ok(
    builtByStep.length > 0,
    'read no builds out of the dev snapshot step — the step exists (devSnapshotStep asserted ' +
      'that) but this matcher found nothing in it. Re-point the matcher.',
  )

  const built = new Set([...builtByBump, ...builtByStep])
  assert.deepEqual(
    expected.filter((pkg) => !built.has(pkg)),
    [],
    'the dev-channel snapshot publishes a package it never builds. release-bump.mjs wipes every ' +
      'dist; anything it does not rebuild must be built explicitly in the snapshot step, or the ' +
      'published tarball ships an empty dist.',
  )
})
/* ── The publish.yml shell guards, pinned (#2421) ─────────────────────────────
 *
 * Enforcement points 1 and 2 for the invariant "a snapshot must never be able
 * to land on `alpha` or `latest`, and the `main` path must never publish a
 * `0.0.0-dev.*` version" live in bash inside `.github/workflows/publish.yml`.
 * The third (`snapshotModeViolation`) is pinned above by ordinary unit tests.
 *
 * These two were originally proven by hand, once. A review on this PR called
 * that out and was right: a guard proven once by hand and not pinned in CI
 * regresses silently on the next PR that touches the file it lives in — and
 * this file is the production publish path. So the real shell is EXTRACTED
 * from the workflow and EXECUTED here.
 *
 * Extracted, never copied. A second copy of the guard in this file would drift
 * from the workflow and then pass while production failed — the exact defect
 * `.github/money-path-globs.json` exists to prevent one directory over. If the
 * extraction stops finding the step or the function, these tests fail loudly
 * rather than silently testing nothing.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A step's `run: |` block, dedented, without a YAML dependency.
 *
 * Deliberately not `yaml`-parsed: this suite has no third-party imports and
 * runs as a bare `node --test` in CI (`.github/workflows/ci.yml`). The block
 * shape is fixed, and every failure mode here is a throw, not a silent empty
 * string.
 */
function stepRunScript(workflow, name) {
  const lines = workflow.split('\n')
  const startIdx = lines.findIndex((l) => l.includes(`- name: ${name}`))
  assert.notEqual(startIdx, -1, `publish.yml has no step named "${name}"`)

  let runIdx = -1
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*- name: /.test(lines[i])) break
    if (/^\s*run: \|\s*$/.test(lines[i])) { runIdx = i; break }
  }
  assert.notEqual(runIdx, -1, `the step "${name}" has no block-scalar \`run: |\``)

  // KNOWN LIMIT: the loop below ends the block at the first line indented no
  // further than `run:`. A line inside the script that happens to look like
  // `- name:` at that indent would truncate the body EARLY and silently —
  // returning a short script rather than throwing, which is the one failure
  // mode this design set out to avoid. No such line exists in publish.yml
  // today and the shell there is indented well past it. If you add one, this
  // reads less than it should; the tests that EXECUTE the extracted script
  // would fail on the truncation, which is the backstop.
  const runIndent = lines[runIdx].match(/^\s*/)[0].length
  const body = []
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') { body.push(''); continue }
    if (line.match(/^\s*/)[0].length <= runIndent) break
    body.push(line)
  }
  while (body.length && body[body.length - 1] === '') body.pop()
  assert.ok(body.length > 0, `the step "${name}" has an empty run block`)
  const dedent = Math.min(...body.filter((l) => l !== '').map((l) => l.match(/^\s*/)[0].length))
  return body.map((l) => (l === '' ? '' : l.slice(dedent))).join('\n') + '\n'
}

/** Run a script under bash and return its exit code and combined output. */
function runBash(script, { env = {}, args = [] } = {}) {
  const file = join(tmpdir(), `haven-2421-${randomUUID()}.sh`)
  writeFileSync(file, script)
  try {
    const r = spawnSync('bash', [file, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    rmSync(file, { force: true })
  }
}

async function publishWorkflow() {
  return readFile(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8')
}

/** The channel-resolution guard, run for real. */
function resolveChannel(script, REF_NAME, REQUESTED) {
  const outFile = join(tmpdir(), `haven-2421-out-${randomUUID()}`)
  writeFileSync(outFile, '')
  try {
    const r = runBash(script, { env: { REF_NAME, REQUESTED, GITHUB_OUTPUT: outFile } })
    return { ...r, output: readFileSync(outFile, 'utf8').trim() }
  } finally {
    rmSync(outFile, { force: true })
  }
}

/** `assert_publish_allowed()` lifted out of the publish step and invoked. */
function assertPublishAllowedScript(workflow) {
  const step = stepRunScript(workflow, 'Publish packages whose version is not yet on npm')
  const start = step.indexOf('assert_publish_allowed() {')
  assert.notEqual(start, -1, 'the publish step no longer defines assert_publish_allowed()')
  const rest = step.slice(start).split('\n')
  const collected = []
  let depth = 0
  for (const line of rest) {
    collected.push(line)
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (depth === 0 && collected.length > 1) break
  }
  assert.equal(depth, 0, 'could not find the end of assert_publish_allowed()')
  return `set -euo pipefail\n${collected.join('\n')}\nassert_publish_allowed "$1" "$2" "$3"\n`
}

const SNAPSHOT_V = '0.0.0-dev.202609021905.abc1234'
const REAL_V = '0.1.29-alpha.0'

test('GUARD 1/3: the ref decides the channel, and a mismatch is refused (#2421)', async () => {
  // The ONLY route by which `dev`-branch code could reach `alpha`: a
  // workflow_dispatch of channel=prod on the `dev` ref skips the snapshot bump
  // and publishes the committed release version under its own prerelease tag.
  // Nothing downstream can see it, because by then the version and the tag both
  // look entirely ordinary.
  const script = stepRunScript(await publishWorkflow(), 'Resolve the publish channel')

  const refused = [
    ['dev', 'prod'],       // ← the alpha case
    ['main', 'dev'],
    ['feature/x', 'auto'],
    ['release/0.1.29', 'auto'],
  ]
  for (const [ref, requested] of refused) {
    const { code, out } = resolveChannel(script, ref, requested)
    assert.notEqual(code, 0, `ref=${ref} channel=${requested} must be REFUSED, got exit ${code}`)
    assert.match(out, /GUARD:/, `the refusal for ref=${ref} channel=${requested} must say why`)
  }

  // The control half. A guard that refuses everything protects nothing, and
  // these are the four combinations the workflow must actually run on.
  for (const [ref, requested, expected] of [
    ['dev', 'auto', 'dev'],
    ['dev', 'dev', 'dev'],
    ['main', 'auto', 'prod'],
    ['main', 'prod', 'prod'],
  ]) {
    const { code, output } = resolveChannel(script, ref, requested)
    assert.equal(code, 0, `ref=${ref} channel=${requested} must be ALLOWED`)
    assert.equal(output, `channel=${expected}`, `ref=${ref} must resolve to ${expected}`)
  }
})

test('GUARD 2/3: no (channel, version, tag) triple reaches npm unchecked (#2421)', async () => {
  const script = assertPublishAllowedScript(await publishWorkflow())
  const run = (channel, version, tag) => runBash(script, { args: [channel, version, tag] })

  // THE INVARIANT, both directions. Each of these is a real defect, not
  // symmetry: a snapshot on alpha/latest is a throwaway build on the channel
  // users install from, and a real version on `dev` is an unreviewed `dev`
  // commit published under a version people can pin.
  const refused = [
    ['prod', SNAPSHOT_V, 'alpha'],   // ← the alpha case
    ['prod', SNAPSHOT_V, 'latest'],  // ← the latest case
    ['prod', SNAPSHOT_V, 'dev'],
    ['prod', REAL_V, 'dev'],
    ['dev', REAL_V, 'alpha'],
    ['dev', REAL_V, 'dev'],
    ['dev', SNAPSHOT_V, 'alpha'],
    ['dev', SNAPSHOT_V, 'latest'],
    ['staging', REAL_V, 'alpha'],    // an unknown channel fails closed
  ]
  for (const [channel, version, tag] of refused) {
    const { code, out } = run(channel, version, tag)
    assert.notEqual(code, 0, `(${channel}, ${version}, ${tag}) must be REFUSED, got exit ${code}`)
    assert.match(out, /GUARD:/, `(${channel}, ${version}, ${tag}) must say why it was refused`)
  }

  // The control half again — the two shapes production actually publishes, and
  // the one the dev channel does.
  for (const [channel, version, tag] of [
    ['prod', REAL_V, 'alpha'],
    ['prod', '0.2.0', 'latest'],
    ['dev', SNAPSHOT_V, 'dev'],
  ]) {
    const { code, out } = run(channel, version, tag)
    assert.equal(code, 0, `(${channel}, ${version}, ${tag}) must be ALLOWED, got exit ${code}: ${out}`)
  }
})

test('the guard is called before every publish, and outside the failure isolation (#2421)', async () => {
  // Executing the function proves what it decides; it cannot prove it is
  // WIRED IN. A guard defined and never called is the failure mode that looks
  // most like success. Two structural facts carry that, and both are cheap
  // literal checks over a file with no other legitimate use of these strings.
  const step = stepRunScript(await publishWorkflow(), 'Publish packages whose version is not yet on npm')

  const call = step.indexOf('assert_publish_allowed "$channel" "$version" "$tag"')
  assert.notEqual(call, -1, 'the publish loop no longer CALLS assert_publish_allowed')

  // Before the skip check: a version that should never have been built must
  // fail the job loudly, not be reported as "already on npm" because someone
  // got there first.
  const skip = step.indexOf('npm view "$name@$version"')
  assert.notEqual(skip, -1, 'the publish loop no longer has the already-on-npm skip')
  assert.ok(call < skip, 'assert_publish_allowed must run BEFORE the already-on-npm skip')

  // And before the publish itself.
  const publish = step.indexOf('npm publish -w')
  assert.notEqual(publish, -1, 'the publish loop no longer publishes')
  assert.ok(call < publish, 'assert_publish_allowed must run BEFORE npm publish')

  // Deliberately NOT wrapped in the per-package `if ... ; then` isolation that
  // `npm publish` gets (#1159): a package failing to publish is an incident, a
  // triple that should be impossible is a defect in this file, and continuing
  // the loop would publish four more of them.
  // WHAT THIS TEST DOES NOT PROVE, stated because it previously pretended to.
  //
  // An earlier version asserted here that the call is UNCONDITIONAL, by
  // checking the call line for `if` / `||` / `&&`. Review defeated it twice
  // over: wrapping the call in a `case "$channel" in dev) : ;; *) …` skips the
  // guard for the dev channel while `indexOf` still finds the call and the
  // line contains none of those tokens; and appending `&` makes it
  // fire-and-forget, so `set -e` never sees the failure. Both mutations
  // published five packages while this file reported zero failures.
  //
  // A regex over source text can only answer "does this string appear". The
  // question that matters is "is the guard reached on every path", which is
  // behavioural — so it is answered by executing the loop, in the test below.
  // Do not re-add a textual unconditionality check here; widening the pattern
  // is what produced two false green results.
})

/**
 * Run the REAL publish loop, with `npm` stubbed, and report what it published.
 *
 * This is the behavioural answer to "is the guard reached on every path" —
 * the question two successive TEXTUAL assertions got wrong (see the note in
 * the structural test above). It builds a throwaway tree with five
 * package.json files at the version under test, puts a recording `npm` stub
 * on PATH whose `view` always exits non-zero (nothing is on the registry, so
 * the loop always proceeds to the publish it is being tested on), executes
 * the step's own shell, and returns every publish that actually happened.
 *
 * A guard that is skipped, backgrounded, or deleted shows up here as
 * PUBLISHES THAT SHOULD NOT EXIST, whatever the source text looks like.
 */
function runPublishLoop(workflow, { channel, version, tag }) {
  const dir = join(tmpdir(), `haven-2421-loop-${randomUUID()}`)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  for (const p of ['sdk', 'signer', 'mcp', 'connect', 'cli']) {
    mkdirSync(join(dir, 'packages', p), { recursive: true })
    writeFileSync(
      join(dir, 'packages', p, 'package.json'),
      JSON.stringify({ name: `@haven_ai/${p}`, version }),
    )
  }
  const log = join(dir, 'npm.log')
  writeFileSync(log, '')
  writeFileSync(
    join(dir, 'bin', 'npm'),
    `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in\n  view) exit 1 ;;\n  *) exit 0 ;;\nesac\n`,
  )
  spawnSync('chmod', ['+x', join(dir, 'bin', 'npm')])
  const summary = join(dir, 'summary.md')
  writeFileSync(summary, '')

  const file = join(dir, 'step.sh')
  writeFileSync(file, stepRunScript(workflow, 'Publish packages whose version is not yet on npm'))

  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    HAVEN_PUBLISH_CHANNEL: channel,
    GITHUB_STEP_SUMMARY: summary,
  }
  if (tag) env.HAVEN_PUBLISH_TAG = tag
  else delete env.HAVEN_PUBLISH_TAG

  const r = spawnSync('bash', [file], { cwd: dir, encoding: 'utf8', env })
  const published = readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('publish'))
  rmSync(dir, { recursive: true, force: true })
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, published }
}

test('GUARD 2/3 (behavioural): a forbidden combination PUBLISHES NOTHING (#2421)', async () => {
  // The invariant, proven by execution rather than by reading. Each row is a
  // real way the wrong artifact could reach the wrong channel; every one must
  // end with a failed job and an EMPTY publish list.
  const workflow = await publishWorkflow()

  for (const [label, args] of [
    ['prod channel sees a snapshot version', { channel: 'prod', version: SNAPSHOT_V, tag: null }],
    ['dev channel forced to the alpha tag', { channel: 'dev', version: SNAPSHOT_V, tag: 'alpha' }],
    ['dev channel forced to latest', { channel: 'dev', version: SNAPSHOT_V, tag: 'latest' }],
    ['dev channel sees a real version', { channel: 'dev', version: REAL_V, tag: 'dev' }],
    ['an unknown channel', { channel: 'staging', version: REAL_V, tag: null }],
  ]) {
    const { code, published } = runPublishLoop(workflow, args)
    assert.notEqual(code, 0, `${label}: the job must FAIL, got exit ${code}`)
    assert.deepEqual(
      published,
      [],
      `${label}: the guard was bypassed — ${published.length} package(s) were published. ` +
        'This is the failure a textual "is the call unconditional" assertion cannot see.',
    )
  }
})

test('GUARD 2/3 (behavioural): the permitted combinations still publish all five (#2421)', async () => {
  // The control half, and it is not a formality: a guard that refuses
  // everything protects nothing, and this suite would still be green.
  const workflow = await publishWorkflow()

  for (const [label, args] of [
    ['prod publishes a real prerelease', { channel: 'prod', version: REAL_V, tag: null }],
    ['prod publishes a stable release', { channel: 'prod', version: '0.2.0', tag: null }],
    ['dev publishes a snapshot', { channel: 'dev', version: SNAPSHOT_V, tag: 'dev' }],
  ]) {
    const { code, published, out } = runPublishLoop(workflow, args)
    assert.equal(code, 0, `${label}: the job must SUCCEED, got exit ${code}: ${out}`)
    assert.equal(published.length, 5, `${label}: expected 5 publishes, got ${published.length}`)
  }
})
