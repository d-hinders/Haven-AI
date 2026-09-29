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

/** The `export const NAME = '...'` literal the bump rewrites, anchored to a line start. */
export function versionConstantPattern(name) {
  return new RegExp(`^(export const ${name}\\s*=\\s*)(['"]).*?\\2`, 'm')
}
