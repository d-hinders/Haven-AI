// npm homepage guard (#2548). Every published package's `package.json` carried
// `homepage: "https://haven.xyz"` — a domain nobody owns — so the Homepage link
// on all five npm pages resolved to `Could not resolve host`, for humans and
// for the agents that follow the npm links listed in `llms.txt`. Nothing
// failed: npm renders the field verbatim and no check read it, which is the
// same shape #2520 found in the discovery artifacts (filed off #2520's own
// pass; see `packages/frontend/src/lib/__tests__/discovery-artifacts.test.ts`
// for the artifact half of that fix).
//
// So the rule is mechanical rather than remembered:
//
//   * no `homepage` may name one of the dead hosts (a bare substring check —
//     a URL is not required to carry one);
//   * a `homepage` that IS a URL may only point at an allow-listed host, so
//     adopting a production home later is a decision somebody makes on
//     purpose, in this file;
//   * every `homepage` value present must be identical to every other, because
//     drift between the published packages is the failure #2533 exists to
//     prevent.
//
// The package list is derived from the filesystem, never hardcoded: a new
// package is covered the moment it exists. The check is an exported function
// over plain manifest objects (the `violationsFor` shape of
// `scripts/workspace-pin-lint.mjs`) so the synthetic manifests below can prove
// it bites — a guard that only ever sees a green tree passes vacuously.
//
// Run with: node --test scripts/ci/npm-homepage-guard.test.mjs
// (also collected by the `ci_config_checks` job's `scripts/ci/*.test.mjs`)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/** Domains nobody owns; filed off #2520, which removed them from the artifacts. */
export const DEAD_HOSTS = ['haven.xyz', 'app.haven.xyz', 'docs.haven.xyz']

/**
 * Hosts a published package's `homepage` may point at. Exactly one entry: the
 * public repository, the same target #2520 used for the product-docs link.
 * A production home does not exist in this repo yet (#2548 deliberately did
 * not invent one), so adding a second entry is the deliberate decision.
 */
export const ALLOWED_HOSTS = new Set(['github.com'])

function hostnameOf(homepage) {
  try {
    return new URL(homepage).hostname
  } catch {
    return null
  }
}

/**
 * Collect violations across a list of `{ name, homepage }` manifest summaries.
 *
 * Exported for the self-tests, which drive it with synthetic manifests rather
 * than mutating the real tree. A manifest without a `homepage` field is out of
 * scope: the rule polices the value, not the field's existence. Each manifest
 * gets at most one link violation (dead host wins over unlisted host — the
 * dead host is always also unlisted, and reporting both is noise), plus one
 * drift violation per value that differs from the canonical (lexicographically
 * first) value present.
 */
export function violationsFor(manifests) {
  const withHomepage = manifests.filter((m) => typeof m.homepage === 'string')
  const violations = []

  for (const m of withHomepage) {
    const lowered = m.homepage.toLowerCase()
    const dead = DEAD_HOSTS.find((host) => lowered.includes(host))
    if (dead) {
      violations.push({
        package: m.name,
        homepage: m.homepage,
        kind: 'dead-host',
        detail:
          `"${m.homepage}" names the dead host "${dead}" — a domain nobody ` +
          'owns, so the npm page\'s Homepage link resolves to ' +
          '"Could not resolve host" for every reader, human or agent',
      })
      continue
    }
    const hostname = hostnameOf(m.homepage)
    if (hostname === null) {
      violations.push({
        package: m.name,
        homepage: m.homepage,
        kind: 'unparseable-homepage',
        detail:
          `"${m.homepage}" is not a URL, so the guard cannot verify its host — ` +
          'failing closed rather than letting an unverifiable value through',
      })
      continue
    }
    if (!ALLOWED_HOSTS.has(hostname)) {
      violations.push({
        package: m.name,
        homepage: m.homepage,
        kind: 'unlisted-host',
        detail:
          `"${m.homepage}" points at "${hostname}", which is not allow-listed ` +
          `(allowed: ${[...ALLOWED_HOSTS].join(', ')}) — adding a host is a ` +
          'deliberate decision made in this guard, not a side effect of a ' +
          'package.json edit',
      })
    }
  }

  const values = [...new Set(withHomepage.map((m) => m.homepage))].sort()
  if (values.length > 1) {
    const canonical = values[0]
    for (const m of withHomepage) {
      if (m.homepage !== canonical) {
        violations.push({
          package: m.name,
          homepage: m.homepage,
          kind: 'homepage-drift',
          detail:
            `"${m.homepage}" differs from the other packages' "${canonical}" — ` +
            'the published packages must advertise one identical homepage, or ' +
            'they drift apart exactly as #2533 describes',
        })
      }
    }
  }

  return violations
}

async function readManifests() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true })
  const manifests = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const raw = await readFile(join(PACKAGES_DIR, entry.name, 'package.json'), 'utf8')
      const manifest = JSON.parse(raw)
      manifests.push({ name: manifest.name ?? entry.name, homepage: manifest.homepage })
    } catch {
      // not a package directory
    }
  }
  return manifests
}

test('a package pointing at the public repository is clean', () => {
  assert.deepEqual(
    violationsFor([{ name: '@haven_ai/sdk', homepage: 'https://github.com/d-hinders/Haven-AI' }]),
    [],
  )
})

test('a package without a homepage field is out of scope', () => {
  assert.deepEqual(violationsFor([{ name: '@haven_ai/core' }]), [])
})

// The positive control for the host the issue is about: the exact value all
// five packages shipped until #2548.
test('the dead host is a violation, naming the package', () => {
  const [v] = violationsFor([{ name: '@haven_ai/sdk', homepage: 'https://haven.xyz' }])
  assert.equal(v.kind, 'dead-host')
  assert.equal(v.package, '@haven_ai/sdk')
  assert.match(v.detail, /Could not resolve host/)
})

test('all three dead hosts are caught, at any path depth', () => {
  for (const [host, url] of [
    ['haven.xyz', 'https://haven.xyz/package'],
    ['app.haven.xyz', 'https://app.haven.xyz/setup'],
    ['docs.haven.xyz', 'https://docs.haven.xyz/account-recovery'],
  ]) {
    const [v] = violationsFor([{ name: '@haven_ai/cli', homepage: url }])
    assert.equal(v.kind, 'dead-host', `expected dead-host for ${host}`)
    assert.match(v.detail, new RegExp(host.replace(/\./g, '\\.')))
  }
})

test('the dead host is caught case-insensitively and as a bare substring', () => {
  const [v] = violationsFor([{ name: '@haven_ai/mcp', homepage: 'https://Haven.XYZ' }])
  assert.equal(v.kind, 'dead-host')
  // A lookalike that merely CONTAINS the dead host fails closed too.
  const [v2] = violationsFor([
    { name: '@haven_ai/mcp', homepage: 'https://haven.xyz.evil.example' },
  ])
  assert.equal(v2.kind, 'dead-host')
})

test('an unlisted host is flagged by the allow-list filter', () => {
  const [v] = violationsFor([{ name: '@haven_ai/signer', homepage: 'https://example.com' }])
  assert.equal(v.kind, 'unlisted-host')
  assert.match(v.detail, /not allow-listed/)
})

test('a near-miss host is not silently allowed — the entry is exact', () => {
  const [v] = violationsFor([
    { name: '@haven_ai/signer', homepage: 'https://www.github.com/d-hinders/Haven-AI' },
  ])
  assert.equal(v.kind, 'unlisted-host')
})

test('an unparseable homepage fails closed', () => {
  const [v] = violationsFor([{ name: '@haven_ai/connect', homepage: 'd-hinders/Haven-AI' }])
  assert.equal(v.kind, 'unparseable-homepage')
})

test('drift between two packages is a violation', () => {
  const violations = violationsFor([
    { name: '@haven_ai/sdk', homepage: 'https://github.com/d-hinders/Haven-AI' },
    { name: '@haven_ai/cli', homepage: 'https://gitlab.com/d-hinders/Haven-AI' },
  ])
  const drift = violations.filter((v) => v.kind === 'homepage-drift')
  assert.equal(drift.length, 1)
  assert.equal(drift[0].package, '@haven_ai/cli')
})

test('identical homepages across many packages do not drift', () => {
  const manifests = ['sdk', 'cli', 'connect', 'mcp', 'signer'].map((p) => ({
    name: `@haven_ai/${p}`,
    homepage: 'https://github.com/d-hinders/Haven-AI',
  }))
  assert.deepEqual(violationsFor(manifests), [])
})

test('the real workspace is clean', async () => {
  const manifests = await readManifests()
  const violations = violationsFor(manifests)
  assert.deepEqual(violations, [], `expected no violations, got:\n${JSON.stringify(violations, null, 2)}`)

  // Floors, so this assertion cannot pass vacuously on a tree the scan
  // silently read nothing from (the #2520 lesson: its first version threw on
  // a clean tree). Eleven workspace packages exist today; five of them — the
  // published set — carry a `homepage`.
  assert.ok(
    manifests.length >= 8,
    `expected to scan the workspace packages, scanned ${manifests.length}`,
  )
  const withHomepage = manifests.filter((m) => typeof m.homepage === 'string')
  assert.ok(
    withHomepage.length >= 5,
    `expected the published packages to still carry a homepage, found ${withHomepage.length}`,
  )
})
