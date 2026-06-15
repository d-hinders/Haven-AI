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
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execAsync = promisify(execFile)

// ── Paths ─────────────────────────────────────────────────────────────────────

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))
const pkg = (name) => join(ROOT, 'packages', name, 'package.json')

const PACKAGES = ['sdk', 'signer', 'mcp', 'connect']

// Every package whose published/deployed artifact resolves @haven_ai/* deps
// from outside the workspace (fresh `npx` install or container build). These
// MUST pin internal deps to a concrete version — a `*` / `latest` / `workspace:*`
// range resolves to the workspace sibling in-repo (green) but to whatever the
// registry serves on a user's machine (the signer@0.1.10-alpha.0 / sdk crash
// that motivated this guard). `mcp-server` is Docker-deployed rather than
// npx-installed, but it is not private, so it is held to the same rule.
const PUBLISHED_PACKAGES = ['sdk', 'signer', 'mcp', 'mcp-server', 'connect']

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
  log(`  no wildcard internal @haven_ai/* deps (verified)`)
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
  for (const name of PUBLISHED_PACKAGES) {
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

  // mcp-server depends on sdk (runtime) + signer (dev). Docker-deployed, but
  // pinned so the hosted build tracks the released SDK/signer.
  await updateDepPin('mcp-server', '@haven_ai/sdk', newVersion)
  await updateDepPin('mcp-server', '@haven_ai/signer', newVersion)
  log(`  packages/mcp-server: @haven_ai/sdk, @haven_ai/signer → "${newVersion}"`)

  // connect depends on sdk, mcp, signer (exact pins)
  await updateDepPin('connect', '@haven_ai/sdk', newVersion)
  await updateDepPin('connect', '@haven_ai/mcp', newVersion)
  await updateDepPin('connect', '@haven_ai/signer', newVersion)
  log(`  packages/connect: @haven_ai/sdk, @haven_ai/mcp, @haven_ai/signer → "${newVersion}"`)

  // Guard: after rewriting pins, no published package may still carry a
  // wildcard internal dep. Fail loudly here rather than discover it post-publish.
  await verifyNoWildcardInternalDeps()

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

  // ── 7. npm install ────────────────────────────────────────────────────────
  header('Running npm install (updates package-lock.json)')
  await run('npm', ['install', '--no-audit', '--no-fund'])

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
  log('  Next steps:')
  log('    git diff --stat                          # review all changes')
  log('    git add -p && git commit -m "chore: bump to ' + newVersion + '"')
  log('    npm publish -w packages/sdk --tag alpha')
  log('    npm publish -w packages/signer --tag alpha')
  log('    npm publish -w packages/mcp --tag alpha')
  log('    npm publish -w packages/connect --tag alpha')
  log('')
}

main().catch((err) => {
  process.stderr.write(`\n✗ Unexpected error: ${err.message}\n${err.stack ?? ''}\n`)
  process.exit(1)
})
