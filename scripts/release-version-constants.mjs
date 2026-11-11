// The self-reported version constants the release bump rewrites, one module so
// a test can check each entry still points at the file that declares it.
// #3454 moved SIGNER_VERSION from signer/src/server.ts into tools.ts and the
// bump died half-way through the next release, because nothing tied this table
// to where the constants live. `release-version-constants.test.mjs` does now.

/** `[name, repo-relative file]` for every `export const NAME = '...'` the bump owns. */
export const SOURCE_VERSION_CONSTANT_FILES = [
  // #3454: declared in tools.ts beside SIGNER_NAME; server.ts only re-exports it.
  ['SIGNER_VERSION', 'packages/signer/src/tools.ts'],
  ['HOSTED_SERVER_VERSION', 'packages/mcp-server/src/server.ts'],
  ['CONNECTOR_VERSION', 'packages/connect/src/runtime.ts'],
  ['CLI_VERSION', 'packages/cli/src/commands.ts'],
  // #3303: the SDK's own `X-Haven-Client` identity for a bare embedder.
  ['SDK_VERSION', 'packages/sdk/src/client-identity.ts'],
]

/**
 * Version constants the bump rewrites through a DEDICATED writer rather than
 * the `SOURCE_VERSION_CONSTANT_FILES` loop above.
 *
 * `MCP_VERSION` is written by `updateMcpVersionConstant` and verified by its own
 * check, so it cannot join the loop: `updateSourceVersionConstant` dies when the
 * replacement produces no change, and the dedicated writer has already written
 * the same literal by the time the loop reaches it. It is listed here anyway
 * because it IS a release-owned version constant, and the docs coupling gate's
 * version-literal partition (#4612) has to recognise it —
 * `packages/mcp/src/server.ts` is in `docs/operations/package-dev-channel.md`'s
 * `covers:`, so a release bump would otherwise implicate that doc on a diff that
 * is a version literal only.
 */
export const DEDICATED_VERSION_CONSTANT_FILES = [
  ['MCP_VERSION', 'packages/mcp/src/server.ts'],
]

/**
 * Every release-owned version constant, whichever writer owns it. This is the
 * set a version-literal partition must recognise; `SOURCE_VERSION_CONSTANT_FILES`
 * alone is the set the bump's generic loop writes.
 */
export const ALL_VERSION_CONSTANT_FILES = [
  ...SOURCE_VERSION_CONSTANT_FILES,
  ...DEDICATED_VERSION_CONSTANT_FILES,
]

/** The `export const NAME = '...'` literal the bump rewrites, anchored to a line start. */
export function versionConstantPattern(name) {
  return new RegExp(`^(export const ${name}\\s*=\\s*)(['"]).*?\\2`, 'm')
}
