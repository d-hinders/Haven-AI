#!/usr/bin/env node
/**
 * Build-time bundle verification for @haven_ai/connect.
 *
 * Checks that the MCP_VERSION resolved by connect's built bundle at runtime
 * matches the MCP_VERSION constant in packages/mcp/src/server.ts.
 *
 * The regression this guards against (hit twice in production):
 *
 *   1. packages/mcp/src/server.ts updated to v0.1.8-alpha
 *   2. packages/mcp/dist/ NOT rebuilt (stale, still at v0.1.7-alpha)
 *   3. connect's tsup run resolves @haven_ai/mcp from the workspace symlink →
 *      loads the stale dist → bundles `mcp.MCP_VERSION = '0.1.7-alpha'`
 *   4. Published connect installs wrong MCP version → wrong SDK via nested
 *      node_modules resolution → broken wire format in production.
 *
 * Run automatically as a postbuild step (packages/connect/package.json).
 * Also runnable manually: node scripts/verify-connect-bundle.mjs
 *
 * If this fails: run `npm run release:bump -- <type>` (see scripts/README.md),
 * which wipes all dist directories before rebuilding in the correct order.
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)))

async function main() {
  // ── 1. Read the source-of-truth MCP_VERSION from server.ts ──────────────
  const serverTsPath = join(ROOT, 'packages', 'mcp', 'src', 'server.ts')
  let serverTs
  try {
    serverTs = await readFile(serverTsPath, 'utf8')
  } catch {
    die(`Could not read ${serverTsPath}. Is packages/mcp present?`)
  }

  const match = serverTs.match(/export const MCP_VERSION\s*=\s*(['"])(.+?)\1/)
  if (!match) {
    die(
      `Could not find MCP_VERSION constant in ${serverTsPath}.\n` +
      `Expected: export const MCP_VERSION = '...'`,
    )
  }
  const sourceVersion = match[2]

  // ── 2. Require the built connect bundle and read mcpVersion ──────────────
  const bundlePath = join(ROOT, 'packages', 'connect', 'dist', 'index.cjs')
  const req = createRequire(import.meta.url)

  let manifest
  try {
    const connectDist = req(bundlePath)
    manifest = connectDist.MCP_RUNTIME_MANIFEST
  } catch (err) {
    die(
      `Could not require ${bundlePath}.\n` +
      `Run "npm run build -w packages/connect" first.\n` +
      `Error: ${err.message}`,
    )
  }

  if (!manifest || typeof manifest.mcpVersion !== 'string') {
    die(
      `MCP_RUNTIME_MANIFEST.mcpVersion is not a string in the connect bundle.\n` +
      `Check packages/connect/src/runtime-manifest.ts.`,
    )
  }

  const bundleVersion = manifest.mcpVersion

  // ── 3. Assert they match ─────────────────────────────────────────────────
  if (bundleVersion !== sourceVersion) {
    die(
      [
        `Build-order mismatch: connect's bundle resolves MCP_VERSION "${bundleVersion}"`,
        `but packages/mcp/src/server.ts declares "${sourceVersion}".`,
        ``,
        `This means packages/mcp/dist/ was stale when connect was built.`,
        `The built bundle loaded the old MCP dist via the workspace symlink.`,
        ``,
        `Fix: run the bump script to wipe all dists and rebuild in order:`,
        `  npm run release:bump -- prerelease   (or your chosen bump type)`,
        ``,
        `Or manually:`,
        `  rm -rf packages/sdk/dist packages/mcp/dist packages/connect/dist`,
        `  npm run build -w packages/sdk`,
        `  npm run build -w packages/mcp`,
        `  npm run build -w packages/connect`,
        ``,
        `See scripts/README.md for the full recipe.`,
      ].join('\n'),
    )
  }

  ok(`connect bundle mcpVersion = "${bundleVersion}" ✓ (matches packages/mcp/src/server.ts)`)
}

function ok(msg) {
  process.stdout.write(`\n✓ ${msg}\n\n`)
}

function die(msg) {
  process.stderr.write(`\n✗ verify-connect-bundle: ${msg}\n\n`)
  process.exit(1)
}

main().catch((err) => {
  process.stderr.write(`\n✗ Unexpected error: ${err.message}\n${err.stack ?? ''}\n`)
  process.exit(1)
})
