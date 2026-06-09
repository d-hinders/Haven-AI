/**
 * Install-path smoke tests (see packages/connect/tests/install-smoke/README.md).
 *
 * Two tiers:
 *
 * 1. Always-run constant-parity test — catches MCP_VERSION drift between
 *    `packages/mcp/src/server.ts` and `packages/mcp/package.json` without
 *    any packing. This is cheap and runs on every `vitest run`.
 *
 * 2. Pack-and-install smoke tests (HAVEN_CONNECT_PACKAGE_SMOKE=1) — packs
 *    `@haven_ai/sdk` and `@haven_ai/mcp` into real tarballs via `npm pack`,
 *    extracts them into a fresh temp directory (no workspace symlinks for
 *    Haven packages), and then:
 *      a. verifies installed versions match the manifest;
 *      b. verifies there is no nested `@haven_ai/sdk` inside the mcp
 *         package (the nested-resolution bug from connect@0.1.4-alpha);
 *      c. verifies the X-PAYMENT wire format produced by the installed
 *         runtime matches the spec shape and is bound to the delegate key;
 *      d. probes the installed MCP server via JSON-RPC to confirm all
 *         required tools are advertised.
 *
 * Run locally:
 *   npm run smoke:pack -w packages/connect
 */

import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acknowledgeLocalMcpConsent } from './local-mcp-consent.js'
import { prepareLocalMcpRuntime } from './local-mcp-runtime.js'
import { probeLocalMcpTools } from './probes.js'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import { MCP_VERSION } from '@haven_ai/mcp'

const execFileAsync = promisify(execFile)
const runSmoke = process.env.HAVEN_CONNECT_PACKAGE_SMOKE === '1'
const describeSmoke = runSmoke ? describe : describe.skip

// ── Always-run: constant-parity check ────────────────────────────────────────
// The MCP_VERSION constant in @haven_ai/mcp/src/server.ts MUST stay in sync
// with the "version" field in packages/mcp/package.json.  If someone bumps
// the package.json version but forgets to update the source constant (or vice
// versa), the manifest that connect ships will be wrong.
describe('MCP_VERSION constant parity', () => {
  it('MCP_VERSION exported by @haven_ai/mcp matches its package.json version', async () => {
    const mcpPackageJsonPath = fileURLToPath(new URL('../../mcp/package.json', import.meta.url))
    const mcpPackageJson = JSON.parse(await readFile(mcpPackageJsonPath, 'utf8')) as { version: string }
    expect(
      MCP_VERSION,
      [
        `MCP_VERSION in packages/mcp/src/server.ts is "${MCP_VERSION}" but`,
        `packages/mcp/package.json declares version "${mcpPackageJson.version}".`,
        'Keep them in sync: bump both together when releasing a new MCP version.',
      ].join(' '),
    ).toBe(mcpPackageJson.version)
  })

  // This test skips when dist/ hasn't been built yet (fresh checkout, CI before
  // the build step). The primary enforcement is the postbuild hook in
  // packages/connect/package.json and the install-smoke CI job. When this test
  // does run (after a local build or in smoke:pack), it catches the build-order
  // bug: if packages/mcp/dist/ was stale when connect's tsup ran, the bundle
  // require()s the old mcp dist and resolves the wrong mcpVersion at runtime.
  it('connect dist/index.cjs resolves the correct mcpVersion at runtime (skips when dist absent)', async () => {
    const bundlePath = fileURLToPath(new URL('../dist/index.cjs', import.meta.url))

    // Skip gracefully if not yet built.
    try {
      await access(bundlePath)
    } catch {
      return // not built yet — postbuild hook + CI enforce this after each build
    }

    // Source-of-truth: the MCP_VERSION literal in server.ts.
    const serverTsPath = fileURLToPath(new URL('../../mcp/src/server.ts', import.meta.url))
    const serverTs = await readFile(serverTsPath, 'utf8')
    const sourceMatch = serverTs.match(/export const MCP_VERSION\s*=\s*(['"])(.+?)\1/)
    expect(
      sourceMatch,
      'Could not find MCP_VERSION constant in packages/mcp/src/server.ts',
    ).not.toBeNull()
    const sourceVersion = sourceMatch![2]

    // Require the built bundle and check what mcpVersion it resolves to at runtime.
    // The bundle does: var mcp = require('@haven_ai/mcp'); mcpVersion: mcp.MCP_VERSION
    // If mcp/dist/ was stale when connect built, bundleVersion !== sourceVersion.
    const req = createRequire(import.meta.url)
    const connectDist = req(bundlePath) as { MCP_RUNTIME_MANIFEST: { mcpVersion: string } }
    const bundleVersion = connectDist.MCP_RUNTIME_MANIFEST?.mcpVersion

    expect(
      bundleVersion,
      [
        `Build-order mismatch: connect's bundle resolves mcpVersion "${bundleVersion}"`,
        `but packages/mcp/src/server.ts declares "${sourceVersion}".`,
        `packages/mcp/dist/ was stale when connect was built.`,
        `Fix: npm run release:bump -- prerelease (see scripts/README.md)`,
        `or: rm -rf packages/{sdk,mcp,connect}/dist && rebuild in order.`,
      ].join(' '),
    ).toBe(sourceVersion)
  })
})

// ── Pack-and-install smoke tests ──────────────────────────────────────────────
describeSmoke('published package smoke', () => {
  // Shared state populated by beforeAll.
  let tempDir = ''
  let runtimeNodeModules = ''

  // Paths for the credential/wrapper tier (used by the wrapper + probe tests).
  let homeDir = ''
  let identityPath = ''
  let signerPath = ''
  let credentialDirectory = ''

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'haven-connect-package-smoke-'))
    const packDir = join(tempDir, 'packs')
    const packCacheDir = join(tempDir, 'pack-npm-cache')
    homeDir = join(tempDir, 'home')
    credentialDirectory = join(homeDir, '.haven', 'agents', 'agent-1')
    identityPath = join(credentialDirectory, 'identity.json')
    signerPath = join(credentialDirectory, 'signer.json')

    await mkdir(packDir, { recursive: true })
    await mkdir(packCacheDir, { recursive: true, mode: 0o700 })
    await mkdir(join(homeDir, '.npm'), { recursive: true, mode: 0o700 })
    await mkdir(credentialDirectory, { recursive: true, mode: 0o700 })

    const sdkTarball = await npmPack(packageDir('sdk'), packDir, packCacheDir)
    const mcpTarball = await npmPack(packageDir('mcp'), packDir, packCacheDir)
    await installPackedRuntimeFromTarballs(homeDir, sdkTarball, mcpTarball)

    runtimeNodeModules = join(
      homeDir, '.haven', 'mcp-runtime', MCP_RUNTIME_MANIFEST.mcpVersion, 'node_modules',
    )

    await writeJson(identityPath, {
      api_key: 'sk_agent_package_smoke',
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 8453,
      network: 'Base',
      api_url: 'https://api.haven.example',
      agent_budget: [{
        token_symbol: 'USDC',
        allowance_amount: '25000000',
        reset_period_min: 1440,
      }],
    })
    await writeJson(signerPath, {
      // Test-only key — the Hardhat/Anvil well-known account #1 private key.
      // Its correct EIP-55 checksummed address is 0xaB5339CaCC54C3Cf0aAE75c1Fa6b79C006faA73c.
      // Never used on mainnet; safe to commit in test fixtures.
      delegate_key: '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38',
      delegate_address: '0xaB5339CaCC54C3Cf0aAE75c1Fa6b79C006faA73c',
      agent_id: 'agent-1',
      safe_address: '0x2222222222222222222222222222222222222222',
      chain_id: 8453,
      network: 'Base',
    })
  }, 120_000)

  afterAll(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  // ── 1. Version cross-check ────────────────────────────────────────────────
  // Verify that what was packed is what was installed, and that there is no
  // nested @haven_ai/sdk hiding inside @haven_ai/mcp/node_modules.
  // The nested-SDK bug (connect@0.1.4-alpha / mcp@0.1.6-alpha) caused Node's
  // bottom-up module resolution to load the wrong SDK version at runtime.
  it('installed package versions match packed tarballs and SDK is not nested in mcp', async () => {
    const [installedMcpPkg, installedSdkPkg] = await Promise.all([
      readInstalledPackageJson(join(runtimeNodeModules, '@haven_ai', 'mcp', 'package.json')),
      readInstalledPackageJson(join(runtimeNodeModules, '@haven_ai', 'sdk', 'package.json')),
    ])

    expect(
      installedMcpPkg.version,
      `installed @haven_ai/mcp version should be ${MCP_RUNTIME_MANIFEST.mcpVersion}`,
    ).toBe(MCP_RUNTIME_MANIFEST.mcpVersion)

    expect(
      installedSdkPkg.version,
      `installed @haven_ai/sdk version should be ${MCP_RUNTIME_MANIFEST.sdkVersion}`,
    ).toBe(MCP_RUNTIME_MANIFEST.sdkVersion)

    // Nested SDK = nested-resolution bug: mcp must NOT have its own copy of
    // the SDK inside its own node_modules directory.
    const nestedSdkPkg = join(
      runtimeNodeModules, '@haven_ai', 'mcp', 'node_modules', '@haven_ai', 'sdk', 'package.json',
    )
    let nestedSdkExists = false
    try {
      await access(nestedSdkPkg)
      nestedSdkExists = true
    } catch {
      // Expected: the path should not exist.
    }
    expect(
      nestedSdkExists,
      [
        'Found a nested @haven_ai/sdk inside @haven_ai/mcp/node_modules.',
        'This is the nested-resolution bug: Node will load the mcp-bundled SDK',
        'instead of the explicitly-installed root SDK, causing version mismatches',
        'at runtime. Fix: ensure @haven_ai/mcp does not pin @haven_ai/sdk as a',
        'bundled dependency.',
      ].join(' '),
    ).toBe(false)
  })

  // ── 2. X-PAYMENT wire-format check ───────────────────────────────────────
  // Exercise the x402 signing path from inside the installed runtime to verify:
  //   • the installed x402 + viem packages are importable and working;
  //   • the wire payload has the correct top-level keys {x402Version, accepted, payload};
  //   • payload.authorization is present (the EIP-3009 authorization object);
  //   • authorization.from matches the delegate address derived from the key
  //     (confirming the signature is bound to the right signer).
  //
  // The script is written into the runtime directory so Node resolves its
  // imports from the co-located node_modules (both the packed Haven packages
  // and the symlinked third-party deps).
  it('X-PAYMENT wire payload has correct shape with delegate-bound authorization', async () => {
    const runtimeDirectory = join(
      homeDir, '.haven', 'mcp-runtime', MCP_RUNTIME_MANIFEST.mcpVersion,
    )
    const wireTestScript = join(runtimeDirectory, 'wire-format-check.mjs')

    // Test-only key (Hardhat/Anvil well-known account #1) + its derived
    // EIP-55 checksummed address. viem derives the address from the key at
    // test time; we hard-code it here so a regression in key derivation
    // (e.g. a wrong viem version) would fail this assertion explicitly.
    const delegateKey = '0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38'
    const delegateAddress = '0xaB5339CaCC54C3Cf0aAE75c1Fa6b79C006faA73c'

    await writeFile(wireTestScript, [
      '// Auto-generated by package-smoke.test.ts — do not edit.',
      "import { privateKeyToAccount } from 'viem/accounts'",
      "import { exact } from 'x402/schemes'",
      '',
      `const DELEGATE_KEY = ${JSON.stringify(delegateKey)}`,
      `const DELEGATE_ADDRESS = ${JSON.stringify(delegateAddress)}`,
      '',
      'const account = privateKeyToAccount(DELEGATE_KEY)',
      '',
      '// Minimal well-formed x402 payment option for Base USDC.',
      'const mockOption = {',
      "  scheme: 'exact',",
      "  network: 'base',",
      "  maxAmountRequired: '1000000',",
      "  resource: 'https://smoke-test.example/data',",
      "  description: 'Smoke test resource',",
      "  mimeType: 'application/json',",
      "  payTo: '0x0E8F9364fE8a316d00aD5AFD6D09993c764B45d1',",
      '  maxTimeoutSeconds: 300,',
      "  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',",
      '  extra: null,',
      '}',
      '',
      '// Build the EIP-3009 header exactly as createStandardX402Header does.',
      'const rawHeader = await exact.evm.createPaymentHeader(account, 2, mockOption)',
      'const rawPayload = JSON.parse(atob(rawHeader))',
      '',
      '// Wrap in the Haven v2 wire shape.',
      'const wirePayload = {',
      '  x402Version: 2,',
      '  accepted: mockOption,',
      '  payload: rawPayload.payload,',
      '}',
      '',
      'const result = {',
      '  topLevelKeys: Object.keys(wirePayload).sort(),',
      '  x402Version: wirePayload.x402Version,',
      '  hasAccepted: wirePayload.accepted !== undefined,',
      '  hasPayload: wirePayload.payload !== undefined,',
      '  hasAuthorization: wirePayload.payload?.authorization !== undefined,',
      '  hasSignature: typeof wirePayload.payload?.signature === "string"',
      '    && wirePayload.payload.signature.startsWith("0x"),',
      '  authFromLower: (wirePayload.payload?.authorization?.from ?? "").toLowerCase(),',
      '  delegateAddressLower: DELEGATE_ADDRESS.toLowerCase(),',
      '}',
      '',
      'process.stdout.write(JSON.stringify(result) + "\\n")',
    ].join('\n'))

    const { stdout } = await execFileAsync('node', [wireTestScript], {
      cwd: runtimeDirectory,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })

    const result = JSON.parse(stdout.trim()) as {
      topLevelKeys: string[]
      x402Version: number
      hasAccepted: boolean
      hasPayload: boolean
      hasAuthorization: boolean
      hasSignature: boolean
      authFromLower: string
      delegateAddressLower: string
    }

    expect(result.topLevelKeys, 'wire payload top-level keys must be exactly {accepted, payload, x402Version}').toEqual(
      ['accepted', 'payload', 'x402Version'],
    )
    expect(result.x402Version, 'x402Version must be 2').toBe(2)
    expect(result.hasAccepted, 'wire payload must have an accepted field').toBe(true)
    expect(result.hasPayload, 'wire payload must have a payload field').toBe(true)
    expect(result.hasAuthorization, 'payload must have an authorization object (EIP-3009 fields)').toBe(true)
    expect(result.hasSignature, 'payload must have a 0x-prefixed signature').toBe(true)
    expect(
      result.authFromLower,
      'authorization.from must equal the delegate address (signature is bound to the delegate key)',
    ).toBe(result.delegateAddressLower)
  })

  // ── 3. MCP wrapper + tools probe ─────────────────────────────────────────
  // Verifies that the stable wrapper script generated by prepareLocalMcpRuntime:
  //   • resolves to the packed CLI binary (not a workspace path);
  //   • does not embed credentials in its source;
  //   • spawns a working MCP server that advertises all required tools.
  it('MCP server from packed tarballs lists all required tools via JSON-RPC probe', async () => {
    const acknowledgement = await acknowledgeLocalMcpConsent(identityPath, signerPath, () => undefined)
    expect(acknowledgement.acknowledged).toBe(true)

    const runtime = await prepareLocalMcpRuntime({
      credentialDirectory,
      identityPath,
      signerPath,
      homeDir,
    }, {
      runCommand: async () => {
        throw new Error('prepareLocalMcpRuntime should reuse the packed runtime installed by this smoke test')
      },
    })

    expect(runtime.command).toBe(join(credentialDirectory, 'bin', 'haven-mcp'))
    expect(runtime.args).toEqual([])
    expect(runtime.npmCacheDirectory).toBe(join(homeDir, '.haven', 'npm-cache'))

    const wrapper = await readFile(runtime.wrapperPath, 'utf8')
    expect(wrapper).toContain(runtime.cliPath)
    expect(wrapper).not.toContain('sk_agent_package_smoke')
    expect(wrapper).not.toContain('0x59c6995e998f97a5a0044966f094538eac3f95e63a6c4ed67f298b7c89c86d38')

    const probe = await probeLocalMcpTools(
      runtime.command,
      runtime.args,
      MCP_RUNTIME_MANIFEST.requiredTools,
      20_000,
    )
    expect(probe.status, `MCP tools probe failed with status "${probe.status}"`).toBe('ok')
  }, 60_000)
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function packageDir(name: 'sdk' | 'mcp'): string {
  return fileURLToPath(new URL(`../../${name}/`, import.meta.url))
}

async function npmPack(packageDirectory: string, packDirectory: string, cacheDirectory: string): Promise<string> {
  const { stdout } = await execFileAsync('npm', [
    'pack',
    '--pack-destination',
    packDirectory,
    '--cache',
    cacheDirectory,
  ], {
    cwd: packageDirectory,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  })
  return join(packDirectory, stdout.trim().split(/\r?\n/).at(-1) ?? '')
}

async function installPackedRuntimeFromTarballs(homeDir: string, sdkTarball: string, mcpTarball: string): Promise<void> {
  const runtimeDirectory = join(homeDir, '.haven', 'mcp-runtime', MCP_RUNTIME_MANIFEST.mcpVersion)
  const runtimeNodeModules = join(runtimeDirectory, 'node_modules')
  await extractPackageTarball(sdkTarball, join(runtimeNodeModules, '@haven_ai', 'sdk'))
  await extractPackageTarball(mcpTarball, join(runtimeNodeModules, '@haven_ai', 'mcp'))
  for (const dependency of ['@modelcontextprotocol', 'ethers', 'viem', 'x402', 'zod']) {
    await linkWorkspaceDependency(runtimeNodeModules, dependency)
  }
}

async function extractPackageTarball(tarball: string, destination: string): Promise<void> {
  const extractDir = `${destination}.extract`
  await rm(extractDir, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  await mkdir(dirname(destination), { recursive: true })
  await execFileAsync('tar', ['-xzf', tarball, '-C', extractDir], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
  await rm(destination, { recursive: true, force: true })
  await rename(join(extractDir, 'package'), destination)
  await rm(extractDir, { recursive: true, force: true })
}

async function linkWorkspaceDependency(runtimeNodeModules: string, dependency: string): Promise<void> {
  const source = workspaceNodeModule(dependency)
  const destination = join(runtimeNodeModules, ...dependency.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await symlink(source, destination, 'dir')
}

function workspaceNodeModule(dependency: string): string {
  return fileURLToPath(new URL(`../../../node_modules/${dependency}/`, import.meta.url))
}

async function readInstalledPackageJson(path: string): Promise<{ version: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { version: string }
}

async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
}
