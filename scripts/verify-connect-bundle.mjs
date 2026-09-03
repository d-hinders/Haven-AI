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
 * Run automatically as part of connect's `build` script (packages/connect/package.json),
 * and explicitly by scripts/release-bump.mjs after it builds connect via tsup.
 * Also runnable manually: node scripts/verify-connect-bundle.mjs
 *
 * If this fails: run `npm run release:bump -- <type>` (see scripts/README.md),
 * which wipes all dist directories before rebuilding in the correct order.
 *
 * Since #2423 it also verifies the CONNECTOR CHANNEL the same way, and for the
 * same reason. Every "re-run `npx @haven_ai/connect@<tag>`" hint in the
 * published packages now renders from `HAVEN_CONNECTOR_CHANNEL` in
 * `packages/sdk/src/connector-channel.ts`, so a stale `packages/sdk/dist`
 * would ship a snapshot build telling its tester to re-run the PRODUCTION
 * connector — the identical stale-dist failure, one constant over. It is
 * checked by CALLING the built SDK's own helper rather than by matching source
 * text: what matters is what the artifact renders at runtime.
 */

import { readFile } from 'node:fs/promises'
import { channelForVersion, readConnectorChannel } from './release-channel.mjs'
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

  await verifyConnectorChannel(req)
}

/**
 * The connector channel, checked on the BUILT artifact (#2423).
 *
 * Three independent readings have to agree:
 *   1. the channel declared in packages/sdk/src/connector-channel.ts (source);
 *   2. the channel derived from packages/sdk/package.json's version, by the
 *      same rule publish.yml uses to choose `npm publish --tag`;
 *   3. what the BUILT sdk bundle actually renders when called.
 *
 * (3) is the one that catches a stale dist, and it is a call rather than a
 * grep: after #2423 the hint is assembled at runtime from the package name and
 * the channel, so no `@haven_ai/connect@alpha` literal exists in any bundle to
 * search for. Searching would find nothing and report success.
 */
async function verifyConnectorChannel(req) {
  const channelTsPath = join(ROOT, 'packages', 'sdk', 'src', 'connector-channel.ts')
  const sourceChannel = readConnectorChannel(await readFile(channelTsPath, 'utf8'))
  if (!sourceChannel) {
    die(
      `Could not find HAVEN_CONNECTOR_CHANNEL in ${channelTsPath}.\n` +
      `Expected: export const HAVEN_CONNECTOR_CHANNEL = '...'`,
    )
  }

  const sdkPkg = JSON.parse(await readFile(join(ROOT, 'packages', 'sdk', 'package.json'), 'utf8'))
  const expected = channelForVersion(sdkPkg.version)
  if (sourceChannel !== expected) {
    die(
      [
        `Connector channel mismatch: packages/sdk/src/connector-channel.ts declares`,
        `"${sourceChannel}", but version ${sdkPkg.version} publishes under "${expected}".`,
        ``,
        `HAVEN_CONNECTOR_CHANNEL is owned by scripts/release-bump.mjs — do not hand-edit it.`,
        `Re-run the bump so the constant is rewritten with the version:`,
        `  npm run release:bump -- <version>`,
      ].join('\n'),
    )
  }

  const sdkBundlePath = join(ROOT, 'packages', 'sdk', 'dist', 'index.cjs')
  let rendered
  try {
    rendered = req(sdkBundlePath).connectorRerunCommand()
  } catch (err) {
    die(
      `Could not read connectorRerunCommand from ${sdkBundlePath}.\n` +
      `Run "npm run build -w packages/sdk" first.\n` +
      `Error: ${err.message}`,
    )
  }

  const want = `npx @haven_ai/connect@${sourceChannel}`
  if (rendered !== want) {
    die(
      [
        `Build-order mismatch: the built SDK renders its re-run hint as`,
        `  ${rendered}`,
        `but packages/sdk/src/connector-channel.ts declares channel "${sourceChannel}",`,
        `which should render`,
        `  ${want}`,
        ``,
        `packages/sdk/dist/ is stale. Every published package's "re-run the connector"`,
        `hint resolves through it, so this ships hints pointing at the wrong npm channel.`,
        ``,
        `Fix: rm -rf packages/sdk/dist && npm run build -w packages/sdk`,
      ].join('\n'),
    )
  }

  ok(`connector channel = "${sourceChannel}" ✓ (source, version ${sdkPkg.version}, and built SDK all agree)`)
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
