/**
 * `@haven_ai/sdk/test-support` — shared test fixtures for the sibling
 * packages (signer, mcp, mcp-server, connect). Test fixtures only: nothing
 * the SDK or signer runs imports this entry.
 *
 * - `./direct-userop.js` (#3283): the ONE guard-valid direct-payment
 *   UserOp builder.
 * - `./signed-receipt.js` (#3723): a REAL signed erc7710 receipt bundle —
 *   the first positive handler-level verify fixture on the MCP runtimes.
 * - `./low-s.js` (#4550): the canonical low-s ECDSA assertion the EIP-3009
 *   bridge tests share — the malleable twin recovers to the same address, so
 *   recovery-only tests cannot catch a high-s header.
 */
export * from './direct-userop.js'
export * from './signed-receipt.js'
export * from './low-s.js'
