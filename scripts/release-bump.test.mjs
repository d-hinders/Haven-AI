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
