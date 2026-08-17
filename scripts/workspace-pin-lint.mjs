#!/usr/bin/env node
// Workspace pin lint (#1526): internal `@haven_ai/*` dependency ranges must
// match how the consuming package RESOLVES them, and the two answers are
// opposites.
//
//   npm run lint:workspace-pins
//
// ── The rule ───────────────────────────────────────────────────────────
//
//   PUBLISHED package (`private` is not true)
//     → MUST pin a concrete version.
//       Its artifact is installed outside this repo, so `*` resolves to
//       whatever the registry serves rather than the co-released sibling.
//       This is the signer@0.1.10-alpha.0 crash: green in-repo, broken on a
//       user's machine.
//
//   PRIVATE workspace consumer (`private: true`)
//     → MUST use `"*"`.
//       It is only ever installed from inside this workspace. `"*"` links the
//       sibling unconditionally; an exact pin only works while it happens to
//       equal the workspace version AND that workspace is in the install
//       scope.
//
//       What that costs, measured on npm 10.9.7 rather than assumed — with
//       the dependency's workspace OUTSIDE the install scope (e.g. a
//       Dockerfile that lists some workspaces but not all):
//
//         exact pin  → the dependency is NOT INSTALLED AT ALL
//         "*"        → symlinked to the workspace, scope irrelevant
//
//       and with a range nothing can satisfy, the install hard-fails. The
//       older telling of this rule — that `npm ci` "silently installs the
//       stale registry tarball" — is what the 2026-07-13 money-flow QA
//       breakage was attributed to, but it did NOT reproduce here: npm 10.9.7
//       links the workspace even when the pinned range does not match it.
//       Treat that mechanism as unconfirmed and version-dependent; the
//       scope-sensitivity above is the part that reproduces, and it is reason
//       enough. An exact pin on a private consumer buys nothing in any case.
//
// Both directions were previously enforced only for the published half, and
// only inside `scripts/release-bump.mjs` — i.e. at release time, on one
// hardcoded list. This runs on every PR and derives the classification from
// each package's own `private` field, so a new package is covered the moment
// it exists.
//
// ── Why `private` is the right signal ──────────────────────────────────
//
// It is the field npm itself uses to decide publishability, so it cannot
// drift from reality the way a hand-maintained list can. `release-bump.mjs`
// previously reasoned that `mcp-server` "is not private, so it is held to the
// same rule" as npx-installed packages — but its Dockerfile installs with
// `npm ci --workspace=packages/mcp-server --workspace=packages/sdk
// --include-workspace-root` and builds the SDK from source, i.e. it resolves
// from INSIDE the workspace. The flag was wrong, not the reasoning; #1526
// fixes the flag and this lint keeps the two aligned.

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const DEP_TYPES = ['dependencies', 'devDependencies', 'peerDependencies']
const INTERNAL_SCOPE = '@haven_ai/'

/**
 * Ranges that do not pin a concrete co-released version. Kept in sync with
 * `release-bump.mjs`'s `isWildcardRange` — that one still guards the release
 * itself, and a release must not depend on this lint having been run.
 */
export function isWildcardRange(range) {
  return typeof range !== 'string' ||
    range === '*' ||
    range === 'latest' ||
    range === 'x' ||
    range === '' ||
    range.startsWith('workspace:') ||
    range.includes('*')
}

/** The exact range a private workspace consumer must use. */
export const WORKSPACE_LINK_RANGE = '*'

/**
 * Collect violations for one package manifest.
 *
 * Exported for the self-test, which drives it with synthetic manifests rather
 * than mutating the real tree.
 */
export function violationsFor(manifest) {
  const violations = []
  const published = manifest.private !== true
  for (const depType of DEP_TYPES) {
    const deps = manifest[depType]
    if (!deps) continue
    for (const [depName, range] of Object.entries(deps)) {
      if (!depName.startsWith(INTERNAL_SCOPE)) continue
      if (published && isWildcardRange(range)) {
        violations.push({
          package: manifest.name,
          dep: `${depType}.${depName}`,
          range,
          kind: 'published-wildcard',
          detail:
            'published packages must pin a concrete version — "' + range +
            '" resolves to the workspace sibling in-repo but to whatever the ' +
            'registry serves on a fresh install',
        })
      }
      if (!published && range !== WORKSPACE_LINK_RANGE) {
        violations.push({
          package: manifest.name,
          dep: `${depType}.${depName}`,
          range,
          kind: 'private-exact-pin',
          detail:
            'private workspace consumers must use "*" — the pin "' + range +
            '" resolves from the workspace only while it equals the workspace ' +
            'version AND that workspace is in the install scope; outside the ' +
            'scope the dependency is not installed at all, and an unsatisfiable ' +
            'range fails the install outright',
        })
      }
    }
  }
  return violations
}

async function readManifest(name) {
  return JSON.parse(await readFile(join(PACKAGES_DIR, name, 'package.json'), 'utf8'))
}

export async function lint() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true })
  const violations = []
  let checked = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let manifest
    try {
      manifest = await readManifest(entry.name)
    } catch {
      continue // not a package directory
    }
    checked += 1
    violations.push(...violationsFor(manifest))
  }
  return { violations, checked }
}

async function main() {
  const { violations, checked } = await lint()
  if (violations.length === 0) {
    console.log(`✓ internal @haven_ai/* pins correct across ${checked} workspace package(s)`)
    return
  }
  console.error('Workspace pin violations:\n')
  for (const v of violations) {
    console.error(`  ${v.package} → ${v.dep} = "${v.range}"`)
    console.error(`    ${v.detail}\n`)
  }
  console.error(
    'A package that is published (no `private: true`) must pin a concrete version.\n' +
    'A private workspace consumer must use "*". See scripts/README.md.',
  )
  process.exitCode = 1
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
