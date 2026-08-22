#!/usr/bin/env node
/**
 * Haven release-bump script
 *
 * Atomically bumps all four published packages to the same new version,
 * updates every cross-package pin and source constant, rebuilds in the
 * correct dependency order, and verifies the built connect bundle before
 * exiting.
 *
 * Usage:
 *   node scripts/release-bump.mjs <bump-type>
 *   npm run release:bump -- <bump-type>
 *
 * Bump types:
 *   patch        0.1.9 → 0.1.10  (also strips any prerelease suffix)
 *   minor        0.1.9 → 0.2.0
 *   major        0.1.9 → 1.0.0
 *   prerelease   0.1.9 → 0.1.10-alpha.0  |  0.1.9-alpha.0 → 0.1.9-alpha.1
 *   <version>    any explicit semver, e.g. 0.2.0-beta.1
 *
 * See scripts/README.md for full documentation.
 */

import { execFile } from 'node:child_process'
import { readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bumpLockfileText, lockfileDiffViolations } from './release-lockfile.mjs'

const execAsync = promisify(execFile)

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const pkg = (name) => join(ROOT, 'packages', name, 'package.json')

const PACKAGES = ['sdk', 'signer', 'mcp', 'connect', 'cli']

// Every package whose published artifact resolves @haven_ai/* deps from
// OUTSIDE the workspace (a fresh `npx` install on someone else's machine).
// These MUST pin internal deps to a concrete version — a `*` / `latest` /
// `workspace:*` range resolves to the workspace sibling in-repo (green) but to
// whatever the registry serves on a user's machine (the
// signer@0.1.10-alpha.0 / sdk crash that motivated this guard).
//
// #1526: `mcp-server` used to be in this list, justified as "not private, so
// it is held to the same rule". That reasoning inverted the actual test. Its
// Dockerfile installs with `npm ci --workspace=packages/mcp-server
// --workspace=packages/sdk --include-workspace-root` and builds the SDK from
// source — it resolves from INSIDE the workspace, like `backend`. The exact
// pin bought nothing and carried the private-consumer hazard instead: the
// moment it fell one release out of step, `npm ci` would stop satisfying the
// range from the workspace and silently install the published registry
// tarball. The package is now correctly `private: true` and uses `"*"`;
// `scripts/workspace-pin-lint.mjs` enforces both directions on every PR.
const PUBLISHED_PACKAGES = ['sdk', 'signer', 'mcp', 'connect', 'cli']

// Packages whose VERSION moves in lockstep with a release. A superset of the
// published set: `mcp-server` is versioned for coherence with its
// HOSTED_SERVER_VERSION constant, without being pin-managed.
const VERSIONED_PACKAGES = [...PUBLISHED_PACKAGES, 'mcp-server']

// Dep ranges that are forbidden for an internal @haven_ai/* dependency in any
// published package, because none of them pin a concrete co-released version.
function isWildcardRange(range) {
  return (
    range === '*' ||
    range === 'latest' ||
    range === 'x' ||
    range === '' ||
    range.includes('*') ||
    range.startsWith('workspace:')
  )
}

// Source files that contain inlined version literals.
const MCP_SERVER_TS    = join(ROOT, 'packages', 'mcp', 'src', 'server.ts')
const RUNTIME_MANIFEST = join(ROOT, 'packages', 'connect', 'src', 'runtime-manifest.ts')

// Source-level version constants that must stay in lockstep with the release.
// Each is an `export const NAME = '...'` literal. They are self-reported
// versions (MCP/server handshake `version` field, connector `--version`),
// not dependency ranges — but they drift on every release if not rewritten
// here, so the bump is only atomic if the script owns them all.
const SOURCE_VERSION_CONSTANTS = [
  { name: 'SIGNER_VERSION',        file: join(ROOT, 'packages', 'signer', 'src', 'server.ts'),     label: 'packages/signer/src/server.ts' },
  { name: 'HOSTED_SERVER_VERSION', file: join(ROOT, 'packages', 'mcp-server', 'src', 'server.ts'), label: 'packages/mcp-server/src/server.ts' },
  { name: 'CONNECTOR_VERSION',     file: join(ROOT, 'packages', 'connect', 'src', 'runtime.ts'),   label: 'packages/connect/src/runtime.ts' },
  { name: 'CLI_VERSION',           file: join(ROOT, 'packages', 'cli', 'src', 'commands.ts'),      label: 'packages/cli/src/commands.ts' },
]

// ── Semver helpers ────────────────────────────────────────────────────────────

/** Resolve the semver package from the workspace root node_modules. */
async function getSemver() {
  const semverPath = join(ROOT, 'node_modules', 'semver', 'index.js')
  return (await import(semverPath)).default
}

const VALID_BUMP_TYPES = new Set(['patch', 'minor', 'major', 'prerelease'])

/**
 * Compute the next version given the current version and a bump type.
 * For `prerelease`, the identifier is always `alpha`.
 */
async function nextVersion(current, bumpType) {
  const semver = await getSemver()

  if (!VALID_BUMP_TYPES.has(bumpType)) {
    // Treat as an explicit semver string.
    if (!semver.valid(bumpType)) {
      die(`"${bumpType}" is not a valid semver string or bump type. Valid types: patch, minor, major, prerelease.`)
    }
    return bumpType
  }

  const next = semver.inc(current, bumpType, 'alpha')
  if (!next) die(`Could not compute ${bumpType} increment from ${current}.`)
  return next
}

// ── File update helpers ───────────────────────────────────────────────────────

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

async function updatePackageVersion(packageName, newVersion) {
  const path = pkg(packageName)
  const data = await readJson(path)
  data.version = newVersion
  await writeJson(path, data)
  log(`  ${data.name}@${newVersion}`)
}

async function updateDepPin(packageName, depName, newVersion) {
  const path = pkg(packageName)
  const data = await readJson(path)

  for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (data[depType]?.[depName] !== undefined) {
      data[depType][depName] = newVersion
    }
  }

  await writeJson(path, data)
}

/**
 * Replace an `export const NAME = '...'` string literal in a source file.
 * Used for the self-reported version constants in SOURCE_VERSION_CONSTANTS.
 */
async function updateSourceVersionConstant({ name, file, label }, newVersion) {
  const source = await readFile(file, 'utf8')
  const updated = source.replace(
    new RegExp(`^(export const ${name}\\s*=\\s*)(['"]).*?\\2`, 'm'),
    `$1$2${newVersion}$2`,
  )
  if (updated === source) {
    die(`Could not find ${name} constant in ${label}. Pattern: export const ${name} = '...'`)
  }
  await writeFile(file, updated, 'utf8')
  log(`  ${name} → '${newVersion}' in ${label}`)
}

/**
 * Verify each SOURCE_VERSION_CONSTANTS entry now reads the new version.
 * Guards against a constant being renamed/moved so the regex silently misses it.
 */
async function verifySourceVersionConstants(newVersion) {
  for (const entry of SOURCE_VERSION_CONSTANTS) {
    const source = await readFile(entry.file, 'utf8')
    const match = source.match(new RegExp(`export const ${entry.name}\\s*=\\s*(['"])(.+?)\\1`))
    if (!match || match[2] !== newVersion) {
      die(
        `Verification failed: ${entry.name} in ${entry.label} is ` +
        `'${match ? match[2] : '<not found>'}' but should be '${newVersion}'.`,
      )
    }
    log(`  ✓ ${entry.name} = '${newVersion}' in ${entry.label}`)
  }
}

/**
 * Replace the MCP_VERSION string literal in packages/mcp/src/server.ts.
 * Matches: export const MCP_VERSION = '...'
 */
async function updateMcpVersionConstant(newVersion) {
  const source = await readFile(MCP_SERVER_TS, 'utf8')
  const updated = source.replace(
    /^(export const MCP_VERSION\s*=\s*)(['"]).*?\2/m,
    `$1$2${newVersion}$2`,
  )
  if (updated === source) {
    die(`Could not find MCP_VERSION constant in ${MCP_SERVER_TS}. Pattern: export const MCP_VERSION = '...'`)
  }
  await writeFile(MCP_SERVER_TS, updated, 'utf8')
  log(`  MCP_VERSION → '${newVersion}' in packages/mcp/src/server.ts`)
}

/**
 * Replace sdkVersion and signerVersion literals in
 * packages/connect/src/runtime-manifest.ts.
 */
async function updateRuntimeManifest(newVersion) {
  let source = await readFile(RUNTIME_MANIFEST, 'utf8')

  source = source.replace(
    /(\bsdkVersion:\s*)(['"]).*?\2/,
    `$1$2${newVersion}$2`,
  )
  source = source.replace(
    /(\bsignerVersion:\s*)(['"]).*?\2/,
    `$1$2${newVersion}$2`,
  )

  await writeFile(RUNTIME_MANIFEST, source, 'utf8')
  log(`  sdkVersion + signerVersion → '${newVersion}' in packages/connect/src/runtime-manifest.ts`)
}

// ── Build helpers ─────────────────────────────────────────────────────────────

async function run(command, args, cwd = ROOT) {
  log(`  $ ${command} ${args.join(' ')}`)
  try {
    const { stdout, stderr } = await execAsync(command, args, {
      cwd,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    if (stdout.trim()) process.stdout.write(stdout)
    if (stderr.trim()) process.stderr.write(stderr)
  } catch (err) {
    const message = err.stderr?.trim() || err.stdout?.trim() || err.message
    die(`Command failed: ${command} ${args.join(' ')}\n\n${message}`)
  }
}

async function wipeAllDists() {
  log('  Wiping dist directories...')
  const wipes = PACKAGES.map((name) =>
    rm(join(ROOT, 'packages', name, 'dist'), { recursive: true, force: true }),
  )
  await Promise.all(wipes)
  log('  Dists wiped.')
}

// ── Verification ──────────────────────────────────────────────────────────────

/**
 * Fail the release if any published package declares a wildcard range
 * (`*`, `latest`, `workspace:*`, anything containing `*`) for an internal
 * `@haven_ai/*` dependency. Such ranges resolve to the workspace sibling
 * in-repo but to an arbitrary registry version on a fresh install — exactly
 * how signer@0.1.10-alpha.0 shipped pointing at an SDK without the
 * `decodeBase64Json` export.
 */
async function verifyNoWildcardInternalDeps() {
  const violations = []
  for (const name of PUBLISHED_PACKAGES) {
    const data = await readJson(pkg(name))
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = data[depType]
      if (!deps) continue
      for (const [depName, range] of Object.entries(deps)) {
        if (depName.startsWith('@haven_ai/') && isWildcardRange(range)) {
          violations.push(`  ${data.name} → ${depType}.${depName} = "${range}"`)
        }
      }
    }
  }
  if (violations.length > 0) {
    die(
      'Wildcard internal dependency range(s) found in published package(s):\n' +
      violations.join('\n') + '\n\n' +
      'Internal @haven_ai/* deps must pin a concrete version so a fresh install\n' +
      'resolves the co-released package, not whatever the registry serves.',
    )
  }
  log('  ✓ no wildcard internal @haven_ai/* deps in published packages')
}

/**
 * The inverse rule (#1526): fail the release if a PRIVATE workspace consumer
 * exact-pins an internal `@haven_ai/*` dependency.
 *
 * This direction was unenforced, and it is the one a release can actively
 * create: `release:bump` moves the workspace version, leaving any private
 * consumer that names the OLD version depending on a range its sibling no
 * longer satisfies.
 *
 * Measured consequence on npm 10.9.7 (#1526), rather than assumed: with the
 * dependency's workspace outside the install scope, an exact pin leaves it
 * NOT INSTALLED, while `"*"` symlinks regardless; a range nothing satisfies
 * fails the install outright. The stronger claim this rule is usually told
 * with — that npm silently substitutes the stale registry tarball, per the
 * 2026-07-13 money-flow QA breakage — did NOT reproduce; npm linked the
 * workspace even on a mismatched pin. Recorded as unconfirmed rather than
 * repeated as fact.
 *
 * `scripts/workspace-pin-lint.mjs` checks the same rule on every PR. It is
 * repeated here because a release must not depend on a lint having been run,
 * and because this is the moment the hazard is actually created.
 */
async function verifyPrivateConsumersUnpinned() {
  const names = (await readdir(join(ROOT, 'packages'), { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  const violations = []
  for (const name of names) {
    let data
    try {
      data = await readJson(pkg(name))
    } catch {
      continue
    }
    if (data.private !== true) continue
    for (const depType of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [depName, range] of Object.entries(data[depType] ?? {})) {
        if (depName.startsWith('@haven_ai/') && range !== '*') {
          violations.push(`  ${data.name} → ${depType}.${depName} = "${range}"`)
        }
      }
    }
  }
  if (violations.length > 0) {
    die(
      'Private workspace consumer(s) exact-pin an internal dependency:\n' +
      violations.join('\n') + '\n\n' +
      'These are installed only from inside this workspace, so they must use "*".\n' +
      'This bump would leave the pin naming a version its workspace sibling no\n' +
      'longer is — which resolves only while that workspace is in the install\n' +
      'scope, and not at all when it is not.',
    )
  }
  log('  ✓ no exact internal @haven_ai/* pins in private workspace consumers')
}

/**
 * Verify that connect's built dist contains the expected sdkVersion and
 * signerVersion literals (they are inlined at build time), and that the
 * mcpVersion is accessible (it is a runtime reference to @haven_ai/mcp).
 */
async function verifyConnectBundle(newVersion) {
  const cliCjs = join(ROOT, 'packages', 'connect', 'dist', 'cli.cjs')
  let content
  try {
    content = await readFile(cliCjs, 'utf8')
  } catch {
    die(`Verification failed: ${cliCjs} does not exist after build.`)
  }

  // sdkVersion and signerVersion are string literals in the built bundle.
  if (!content.includes(`"${newVersion}"`)) {
    die(
      `Verification failed: connect dist/cli.cjs does not contain "${newVersion}".\n` +
      `This means sdkVersion or signerVersion was not updated correctly.\n` +
      `Check packages/connect/src/runtime-manifest.ts and rebuild.`,
    )
  }

  // Ensure no stale version strings remain for the two literal fields.
  // (Can only do this if we know the old version, which we do.)
  log(`  ✓ connect dist/cli.cjs contains "${newVersion}"`)

  // Also verify the MCP server source was updated.
  const serverTs = await readFile(MCP_SERVER_TS, 'utf8')
  if (!serverTs.includes(`MCP_VERSION = '${newVersion}'`)) {
    die(
      `Verification failed: MCP_VERSION in packages/mcp/src/server.ts is not '${newVersion}'.\n` +
      `Rerun the script or update server.ts manually.`,
    )
  }
  log(`  ✓ MCP_VERSION = '${newVersion}' in packages/mcp/src/server.ts`)
}

// ── Logging / error helpers ───────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(msg + '\n')
}

function die(msg) {
  process.stderr.write(`\n✗ ${msg}\n\n`)
  process.exit(1)
}

function header(msg) {
  log(`\n── ${msg} ${'─'.repeat(Math.max(0, 60 - msg.length))}`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const bumpArg = process.argv[2]
  if (!bumpArg) {
    die(
      'Usage: node scripts/release-bump.mjs <bump-type>\n' +
      'Bump types: patch | minor | major | prerelease | <explicit-version>',
    )
  }

  // ── 1. Determine new version ──────────────────────────────────────────────
  header('Reading current version')
  const sdkPkg = await readJson(pkg('sdk'))
  const currentVersion = sdkPkg.version
  log(`  Current SDK version: ${currentVersion}`)

  const newVersion = await nextVersion(currentVersion, bumpArg)
  log(`  New version:         ${newVersion}  (${bumpArg})`)

  // ── 2. Preview + confirm ──────────────────────────────────────────────────
  header('Changes to be applied')
  log(`  All published packages (${PUBLISHED_PACKAGES.join(', ')}): ${currentVersion} → ${newVersion}`)
  log(`  Cross-package pins updated to ${newVersion}`)
  log(`  MCP_VERSION = '${newVersion}'  (packages/mcp/src/server.ts)`)
  log(`  sdkVersion + signerVersion = '${newVersion}'  (packages/connect/src/runtime-manifest.ts)`)
  log(`  ${SOURCE_VERSION_CONSTANTS.map((c) => c.name).join(', ')} = '${newVersion}'`)
  // These two are CHECKS THIS RUN WILL PERFORM, not results — the guards run
  // after the pins are rewritten, further down. Saying "(verified)" here
  // printed a reassuring line immediately before the run died on that very
  // check (#1526).
  log(`  will verify: no wildcard internal @haven_ai/* deps in published packages`)
  log(`  will verify: no exact internal @haven_ai/* pins in private consumers`)
  log(`  dist directories wiped, packages rebuilt in order: sdk → signer → mcp → connect`)

  if (!process.argv.includes('--yes') && process.stdout.isTTY) {
    log('')
    log('  Press Enter to continue, or Ctrl-C to abort...')
    await new Promise((resolve) => {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.once('data', (key) => {
        process.stdin.setRawMode(false)
        process.stdin.pause()
        if (key[0] === 3) { process.stdout.write('\nAborted.\n'); process.exit(0) }
        resolve()
      })
    })
  }

  // ── 3. Update package.json versions ──────────────────────────────────────
  // All published packages move to the same version number in lockstep.
  // mcp-server is bumped here for version coherence (it pairs with its
  // HOSTED_SERVER_VERSION constant) even though build/publish below is scoped
  // to PACKAGES — it is Docker-deployed from source, not npm-published here.
  header('Updating package.json versions')
  for (const name of VERSIONED_PACKAGES) {
    await updatePackageVersion(name, newVersion)
  }

  // ── 4. Update cross-package dep pins ─────────────────────────────────────
  header('Updating cross-package dependency pins')

  // signer depends on sdk (exact pin). MUST be rewritten: the signer is
  // npx-installed standalone, so a stale `*` here resolves to whatever the
  // registry serves rather than the co-released SDK (the bug this guards).
  await updateDepPin('signer', '@haven_ai/sdk', newVersion)
  log(`  packages/signer: @haven_ai/sdk → "${newVersion}"`)

  // mcp depends on sdk (exact pin)
  await updateDepPin('mcp', '@haven_ai/sdk', newVersion)
  log(`  packages/mcp: @haven_ai/sdk → "${newVersion}"`)

  // mcp-server is deliberately NOT pinned here (#1526). It is a private
  // workspace consumer: its Docker build installs the sdk/signer workspaces
  // directly, so `"*"` links the sibling and an exact pin would only create a
  // window in which `npm ci` resolves the registry tarball instead. Rewriting
  // it back to a concrete version would reintroduce exactly that window, so
  // this omission is load-bearing — `verifyPrivateConsumersUnpinned` below
  // fails the release if anything puts it back.

  // connect depends on sdk, mcp, signer (exact pins)
  await updateDepPin('connect', '@haven_ai/sdk', newVersion)
  await updateDepPin('connect', '@haven_ai/mcp', newVersion)
  await updateDepPin('connect', '@haven_ai/signer', newVersion)
  log(`  packages/connect: @haven_ai/sdk, @haven_ai/mcp, @haven_ai/signer → "${newVersion}"`)

  // Guard: after rewriting pins, no published package may still carry a
  // wildcard internal dep. Fail loudly here rather than discover it post-publish.
  await verifyNoWildcardInternalDeps()
  await verifyPrivateConsumersUnpinned()

  // ── 5. Update source-code version constants ───────────────────────────────
  header('Updating source-code version constants')
  await updateMcpVersionConstant(newVersion)
  await updateRuntimeManifest(newVersion)
  for (const entry of SOURCE_VERSION_CONSTANTS) {
    await updateSourceVersionConstant(entry, newVersion)
  }

  // ── 6. Wipe all dists ────────────────────────────────────────────────────
  header('Wiping dist directories')
  await wipeAllDists()

  // ── 7. npm install + deterministic lockfile (#1663) ──────────────────────
  // The install keeps node_modules consistent for the builds below, but its
  // lockfile output is NOT taken: on three consecutive cuts (0.1.26 → 0.1.28)
  // the local npm also inserted "dev"/"peer" metadata on unrelated entries,
  // and each release hand-repaired the diff back to its 11 version lines.
  // Instead the version substitution is replayed structurally onto the
  // pre-install lockfile, and a guard below fails the release if the final
  // diff carries anything but version lines — the release commit's whole
  // safety argument is that nothing in it is anything but a version string.
  header('Running npm install (node_modules only — lockfile is rewritten deterministically)')
  const lockfilePath = join(ROOT, 'package-lock.json')
  const lockfileBefore = await readFile(lockfilePath, 'utf8')
  await run('npm', ['install', '--no-audit', '--no-fund'])
  await writeFile(
    lockfilePath,
    bumpLockfileText(lockfileBefore, { currentVersion, newVersion }),
    'utf8',
  )
  // Assert on what is ON DISK, not on what was just computed — so if the
  // rewrite above is ever removed, this reads npm's polluted output and fails.
  const lockfileViolations = lockfileDiffViolations(
    lockfileBefore,
    await readFile(lockfilePath, 'utf8'),
    { currentVersion, newVersion },
  )
  if (lockfileViolations.length > 0) {
    die(
      'package-lock.json changed beyond version lines (#1663):\n  ' +
      lockfileViolations.slice(0, 20).join('\n  ') +
      (lockfileViolations.length > 20 ? `\n  … and ${lockfileViolations.length - 20} more` : ''),
    )
  }
  log(`  ✓ lockfile diff is version lines only (${newVersion})`)

  // ── 8. Build in dependency order ─────────────────────────────────────────
  // sdk first (no Haven deps), then signer (depends on sdk), then mcp
  // (depends on sdk), then connect (depends on sdk + mcp + signer).
  // This order is critical — if mcp is stale when connect builds, tsup
  // may inline a stale constant.
  header('Building packages (sdk → signer → mcp → connect)')
  await run('npm', ['run', 'build', '-w', 'packages/sdk'])
  await run('npm', ['run', 'build', '-w', 'packages/signer'])
  await run('npm', ['run', 'build', '-w', 'packages/mcp'])
  // Build connect directly with tsup (skip the pre-build of mcp/signer that
  // connect's build script does — they're already built above and the pre-build
  // would otherwise re-run the mcp build which can mask a stale MCP_VERSION).
  await run('node_modules/.bin/tsup', [], join(ROOT, 'packages', 'connect'))

  // ── 9. Verify bundle ──────────────────────────────────────────────────────
  header('Verifying connect bundle')
  await verifyConnectBundle(newVersion)
  await verifySourceVersionConstants(newVersion)

  // Strong build-order check: the dedicated verifier require()s the built
  // bundle and compares its runtime-resolved mcpVersion against the
  // MCP_VERSION literal in packages/mcp/src/server.ts. We build connect via
  // tsup directly above (step 8), which bypasses connect's own `build` script
  // that normally runs this verifier — so run it explicitly here. Without this,
  // verifyConnectBundle alone only checks the inlined sdk/signer version string
  // and cannot catch a stale mcpVersion (it is resolved at runtime, not inlined).
  await run('node', [join(ROOT, 'scripts', 'verify-connect-bundle.mjs')])

  // ── Done ──────────────────────────────────────────────────────────────────
  header('Done')
  log(`\n  Released: ${newVersion}`)
  log('')
  // #1788: this block used to end with `npm publish` invocations — the one
  // action CLAUDE.md and the release skill forbid in three separate places,
  // arriving at the moment of maximum trust, right after the tool has done
  // everything else correctly. It also named four of the five published
  // packages, so following it stranded @haven_ai/cli at the previous version.
  //
  // Nothing here enumerates packages. The published set is derived at publish
  // time by publish.yml; a second hand-maintained list is what drifted.
  log('  Next steps — publishing is NOT one of them:')
  log('')
  log('    1. git diff --stat            review the bump')
  log('    2. Write the two contract docs, or the blocking coupling gate fails:')
  log('         docs/operations/mcp-runtime-compatibility.md')
  log('           re-pin the Supported Runtime Manifest table + prepend a last-verified note')
  log('         docs/regulatory/casp-changelog/<date>-<pr>-release.md')
  log('           a new shard, ending in a perimeter verdict')
  log('    3. npm run docs:coupling      must exit 0')
  log('    4. Commit on a release branch and open a PR into `dev`.')
  log('')
  log('  Publishing happens on the dev -> main promotion, and is version-gated:')
  log('  publish.yml skips any version already on npm.')
  log('')
  log('  Never run `npm publish` by hand. It bypasses the per-package summary,')
  log('  the prod release record, and every promotion gate.')
  log('  See .agents/skills/release/SKILL.md.')
  log('')
}

main().catch((err) => {
  process.stderr.write(`\n✗ Unexpected error: ${err.message}\n${err.stack ?? ''}\n`)
  process.exit(1)
})
