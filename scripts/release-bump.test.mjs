import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
  CONNECTOR_CHANNEL_CONSTANT,
  CONNECTOR_CHANNEL_FILE,
  channelForVersion,
  publishWorkflowChannelScript,
  readConnectorChannel,
  rewriteConnectorChannel,
} from './release-channel.mjs'
import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Any `@haven_ai/connect@<tag>` literal — the shape #2423 removed from the
 * published packages' source. Deliberately matches ANY tag, not just `alpha`:
 * a hard-coded `@dev` would be the same defect pointing the other way.
 */
const HARD_CODED_CHANNEL = /@haven_ai\/connect@[a-z][a-z0-9-]*/

/** Every file under `dir`, recursively. */
async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

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
  const actual = order(workflow)
  assert.ok(actual.length > 0, 'publish.yml no longer builds packages with `npm run build -w`')
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

// ─────────────────────────────────────────────────────────────────────────────
// Connector channel (#2423, slice 3 of epic #2420)
//
// The published packages' "re-run `npx @haven_ai/connect@<tag>`" hints render
// from one build-time constant. Two things can go wrong and they fail
// differently, so they are guarded separately:
//
//   1. the bump script's rule for choosing the channel drifts away from
//      publish.yml's rule for choosing the `npm publish --tag` — the packages
//      would then tell a user to install from a channel they were not
//      published under;
//   2. the bump stops writing the constant at all — the constant would sit at
//      the previous release's channel, which is right until the first release
//      that changes channel and silently wrong from then on.
// ─────────────────────────────────────────────────────────────────────────────

test('channelForVersion implements the documented rule', () => {
  assert.equal(channelForVersion('0.1.34-alpha.0'), 'alpha')
  assert.equal(channelForVersion('0.0.0-dev.202609021200.abc1234'), 'dev')
  assert.equal(channelForVersion('0.2.0'), 'latest')
  assert.equal(channelForVersion('1.0.0-beta.2'), 'beta')
  // A prerelease label with no trailing dot segment is still the whole label.
  assert.equal(channelForVersion('0.1.0-alpha'), 'alpha')
  assert.throws(() => channelForVersion(''), /expected a version string/)
  assert.throws(() => channelForVersion(undefined), /expected a version string/)
})

test('release-bump and publish.yml derive the SAME channel — proved by RUNNING the workflow shell', async () => {
  // The rule lives in two languages. This does not compare their source text —
  // a reworded but equivalent `case` would fail such a check, and a rewritten
  // and DIFFERENT one could pass it if the regex were loose. It extracts the
  // workflow's own `case` block and EXECUTES it in bash, then compares the tag
  // it prints against channelForVersion for the same input.
  const script = await publishWorkflowChannelScript(join(ROOT, '.github', 'workflows', 'publish.yml'))

  const versions = [
    '0.1.34-alpha.0',
    '0.1.0-alpha',
    '0.0.0-dev.202609021200.abc1234',
    '0.0.0-dev.202601010000.0abcdef',
    '0.2.0',
    '1.0.0',
    '1.0.0-beta.2',
    '2.3.4-rc.1',
  ]

  // Instrument self-test FIRST: if the extracted shell cannot produce two
  // different answers, agreement below would be vacuous.
  const answers = new Set()
  for (const version of versions) {
    const { stdout } = await execFileAsync('bash', ['-c', script, 'workflow-channel', version])
    answers.add(stdout)
  }
  assert.ok(
    answers.size >= 3,
    `the extracted publish.yml shell produced only ${answers.size} distinct answers ` +
      `(${[...answers].join(', ')}) — it is not discriminating, so agreement would prove nothing`,
  )

  for (const version of versions) {
    const { stdout } = await execFileAsync('bash', ['-c', script, 'workflow-channel', version])
    assert.equal(
      stdout,
      channelForVersion(version),
      `publish.yml and channelForVersion disagree on ${version}: the workflow would publish ` +
        `under "${stdout}" while the packages' re-run hints would say "${channelForVersion(version)}"`,
    )
  }
})

test('the REAL connector channel constant agrees with the REAL package version', async () => {
  // The drift guard, and the one that catches an UNWIRED bump. It runs on
  // every pull request, not only at release: if release-bump.mjs ever stops
  // rewriting HAVEN_CONNECTOR_CHANNEL, the first release that changes channel
  // leaves the constant behind and this goes red on that release's own PR.
  const source = await readFile(join(ROOT, CONNECTOR_CHANNEL_FILE), 'utf8')
  const declared = readConnectorChannel(source)
  assert.ok(declared, `could not read ${CONNECTOR_CHANNEL_CONSTANT} from ${CONNECTOR_CHANNEL_FILE}`)

  const sdkPkg = JSON.parse(await readFile(join(ROOT, 'packages', 'sdk', 'package.json'), 'utf8'))
  assert.equal(
    declared,
    channelForVersion(sdkPkg.version),
    `${CONNECTOR_CHANNEL_FILE} declares channel "${declared}" but ${sdkPkg.version} publishes ` +
      `under "${channelForVersion(sdkPkg.version)}" — do not hand-edit the constant; re-run the bump`,
  )
})

test('rewriteConnectorChannel rewrites the real file, and reports a rename instead of silently passing', async () => {
  const source = await readFile(join(ROOT, CONNECTOR_CHANNEL_FILE), 'utf8')

  const rewritten = rewriteConnectorChannel(source, 'dev')
  assert.equal(readConnectorChannel(rewritten), 'dev')
  // Only the constant moved: everything else in the file is untouched.
  assert.equal(rewritten.replace("= 'dev'", "= 'alpha'"), source.replace(/= '[a-z0-9-]+'/, "= 'alpha'"))

  // The failure mode that matters: someone renames or reshapes the
  // declaration and the bump's regex quietly matches nothing. `null` is what
  // makes release-bump.mjs die instead of shipping the previous channel.
  const renamed = source.replace(
    `export const ${CONNECTOR_CHANNEL_CONSTANT}`,
    'export const HAVEN_CONNECTOR_DIST_TAG',
  )
  assert.notEqual(renamed, source, 'expected the rename fixture to actually change the source')
  assert.equal(rewriteConnectorChannel(renamed, 'dev'), null)
})

test('no published package still hard-codes a connector channel in a re-run hint', async () => {
  // The acceptance criterion of #2423, as a standing guard. This one IS a text
  // search, and legitimately so: the question is literally "does this literal
  // appear anywhere it should not", which is exactly what a text search
  // answers well. (Whether a guard is REACHED is the question a text search
  // answers badly, and that is not this.)
  const scanned = []
  for (const pkg of ['sdk', 'signer', 'mcp', 'mcp-server', 'connect', 'cli']) {
    const dir = join(ROOT, 'packages', pkg, 'src')
    for (const file of await walk(dir)) {
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      // The constant's own home is exempt, exactly as the acceptance criterion
      // of #2423 words it: its prose explains the rule with worked examples,
      // and the code below asserts that exemption is load-bearing rather than
      // decorative, so it cannot quietly become an escape hatch.
      if (file.endsWith(join('sdk', 'src', 'connector-channel.ts'))) continue
      scanned.push([file, await readFile(file, 'utf8')])
    }
  }

  // Instrument self-test: prove the scanner CAN say yes before believing its
  // no. `packages/connect/README.md` is the npm landing page and still carries
  // the literal by design (a README is not rendered from a constant), so it is
  // a known positive control that lives right next to the negative set.
  const control = await readFile(join(ROOT, 'packages', 'connect', 'README.md'), 'utf8')
  assert.ok(
    HARD_CODED_CHANNEL.test(await readFile(join(ROOT, CONNECTOR_CHANNEL_FILE), 'utf8')),
    `${CONNECTOR_CHANNEL_FILE} is skipped above on the grounds that its PROSE carries the ` +
      'literal. It no longer does, so the skip is now an unexplained hole — delete it.',
  )
  assert.ok(
    HARD_CODED_CHANNEL.test(control),
    'the scanner found no hard-coded channel in packages/connect/README.md, where one is known ' +
      'to exist — the pattern is broken and its "no findings" below would be meaningless',
  )

  const findings = scanned
    .filter(([, text]) => HARD_CODED_CHANNEL.test(text))
    .map(([file]) => file.slice(ROOT.length + 1))
  assert.deepEqual(
    findings,
    [],
    'these files hard-code a connector channel instead of rendering it from ' +
      `${CONNECTOR_CHANNEL_CONSTANT} (#2423): ${findings.join(', ')}`,
  )
})
