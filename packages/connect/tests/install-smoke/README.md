# Install-path smoke tests

**Test file:** [`packages/connect/src/package-smoke.test.ts`](../../src/package-smoke.test.ts)  
**CI job:** `install_smoke` in [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml)

## Why this exists

Workspace tests run with symlinked `node_modules`. That means `import { X } from '@haven_ai/mcp'` resolves to the live TypeScript source in `packages/mcp/src/`, not the published tarball. Three classes of bug are invisible in that environment but surface immediately in production:

| Bug class | Symptom | Root cause |
|---|---|---|
| **Stale `MCP_VERSION`** | `connect@0.1.4-alpha` advertised the wrong MCP version | `mcp` dist was outdated when `connect` was built; tsup inlined the stale constant |
| **Nested SDK resolution** | Wrong SDK loaded at runtime in `mcp@0.1.6-alpha` | `@haven_ai/mcp` pinned `@haven_ai/sdk@0.1.8` (broken); npm hoisted both; Node picked the nested one |
| **Broken wire format** | x402 payments silently failed | Signing helpers from the wrong SDK version produced non-verifiable headers |

These tests mirror what an actual user does: `npm pack` → `npm install` → run.

## What is tested

### Always runs (no environment variable needed)

**`MCP_VERSION` constant parity** — checks that `MCP_VERSION` exported from `packages/mcp/src/server.ts` equals the `version` field in `packages/mcp/package.json`. If someone bumps the package version without updating the constant (or vice versa), `connect`'s runtime manifest ships the wrong value and `prepareLocalMcpRuntime` installs the wrong tarball.

### Runs only when `HAVEN_CONNECT_PACKAGE_SMOKE=1`

**1. Version cross-check** — after packing and extracting the SDK and MCP tarballs into a clean temp directory:
- Reads `node_modules/@haven_ai/mcp/package.json` and asserts its `version` matches `MCP_RUNTIME_MANIFEST.mcpVersion`.
- Reads `node_modules/@haven_ai/sdk/package.json` and asserts its `version` matches `MCP_RUNTIME_MANIFEST.sdkVersion`.
- Asserts that `@haven_ai/mcp/node_modules/@haven_ai/sdk` does **not** exist (the nested-resolution bug path).

**2. X-PAYMENT wire-format check** — writes a small `.mjs` script into the runtime directory so it imports `viem/accounts` and `x402/schemes` from the co-located `node_modules` (symlinked workspace deps). The script:
- Builds an EIP-3009 payment header using `exact.evm.createPaymentHeader` with a well-known test key.
- Wraps it in the Haven v2 wire shape `{x402Version, accepted, payload}`.
- Emits JSON on stdout.

The test then asserts:
- Top-level keys are exactly `["accepted", "payload", "x402Version"]` (sorted).
- `payload.authorization` is present (the EIP-3009 fields).
- `payload.signature` is a `0x`-prefixed hex string.
- `authorization.from` equals the delegate address derived from the test key (signature is bound to the correct signer).

**3. MCP JSON-RPC probe** — calls `prepareLocalMcpRuntime` (which detects the already-installed runtime and skips the network install), spawns `haven-mcp` via the generated wrapper, and sends `tools/list`. Asserts all tools in `MCP_RUNTIME_MANIFEST.requiredTools` are advertised.

## Running locally

```sh
# From the repo root:
npm run smoke:pack -w packages/connect

# Or from packages/connect:
npm run smoke:pack
```

The `smoke:pack` script rebuilds SDK and MCP first (`npm --prefix ../sdk run build && npm --prefix ../mcp run build`), then runs Vitest with `HAVEN_CONNECT_PACKAGE_SMOKE=1`.

A full run takes ~60-90 seconds; most of that is `npm pack` and tarball extraction.

## Adding new checks

1. Add a new `it(...)` block inside `describeSmoke` in `package-smoke.test.ts`.
2. If the check needs the installed runtime (`runtimeNodeModules`), it's available from `beforeAll`.
3. If the check is cheap (no packing), put it in the top-level `describe('MCP_VERSION constant parity', ...)` block so it always runs without the env flag.
4. Keep inline Node.js scripts short — write them to `runtimeDirectory` as `.mjs` files so they resolve imports from the co-located `node_modules`.

## Extending to cover `connect` itself

Currently only `@haven_ai/sdk` and `@haven_ai/mcp` are packed. To also pack `@haven_ai/connect` and run its CLI from the tarball:

1. Add `const connectTarball = await npmPack(packageDir('connect'), packDir, packCacheDir)` in `beforeAll`.
2. Install it into a separate temp dir with `npm install` from the tarball.
3. Run `npx haven-connect` (or the bin path) against a mock Haven backend.

This would catch a bundled `MCP_VERSION` mismatch in the connect dist itself — a regression that the current test cannot detect because it runs connect from the workspace TypeScript source.
