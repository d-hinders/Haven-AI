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
