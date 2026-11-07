#!/usr/bin/env node
/**
 * #4723: start smoke test for the BUILT demo merchant.
 *
 * The Railway build command is `npm ci && npm run build -w
 * packages/demo-merchant-mcp`, and that package now imports `@haven_ai/sdk` at
 * runtime. A green `tsup` proves the bundle was emitted; it does not prove the
 * emitted `dist/index.js` can resolve its workspace dependency and bind a
 * socket. This does: it spawns the built entrypoint with a throwaway config and
 * waits for the startup banner, which is printed inside `server.listen`'s
 * callback — i.e. only after the socket is bound.
 *
 * No network is touched: `createViemSettlementClient` constructs clients but
 * does not connect, and the banner is printed before any RPC read.
 *
 *   npm run smoke:start -w packages/demo-merchant-mcp
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRYPOINT = join(PACKAGE_ROOT, 'dist', 'index.js')
const TIMEOUT_MS = 20_000
const BANNER = 'Haven Demo Merchant MCP server'

const child = spawn(process.execPath, [ENTRYPOINT], {
  cwd: PACKAGE_ROOT,
  env: {
    ...process.env,
    // Throwaway values: a valid address, a valid 32-byte key, and a port the
    // kernel picks. Nothing here reaches a chain.
    MERCHANT_ADDRESS: '0x1111111111111111111111111111111111111111',
    SETTLEMENT_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    BASE_RPC_URL: 'http://127.0.0.1:1',
    PORT: '0',
    // Explicitly unset so the smoke run exercises the no-passport path, which
    // is the default deployment shape.
    MERCHANT_HAVEN_BASE_URL: '',
    MERCHANT_PASSPORT_ISSUER: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
let settled = false

function finish(code, message) {
  if (settled) return
  settled = true
  clearTimeout(timer)
  child.kill('SIGTERM')
  if (code === 0) {
    console.log(`start smoke: OK — ${message}`)
  } else {
    console.error(`start smoke: FAILED — ${message}`)
    if (stdout) console.error(`--- stdout ---\n${stdout}`)
    if (stderr) console.error(`--- stderr ---\n${stderr}`)
  }
  process.exitCode = code
}

const timer = setTimeout(() => finish(1, `no startup banner within ${TIMEOUT_MS} ms`), TIMEOUT_MS)

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
  if (stdout.includes(BANNER)) finish(0, 'the built service started and bound its socket')
})

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

child.on('error', (error) => finish(1, `could not spawn ${ENTRYPOINT}: ${error.message}`))

child.on('exit', (code, signal) => {
  if (!settled) finish(1, `exited before the startup banner (code ${code}, signal ${signal})`)
})
