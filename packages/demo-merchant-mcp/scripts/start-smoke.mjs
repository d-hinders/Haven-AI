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
 * No external network is touched: `createViemSettlementClient` constructs
 * clients but does not connect, the banner is printed before any RPC read, and
 * the only request made is this script's own GET of the local `/healthz`.
 *
 * #4851: it runs with a throwaway CDP credential pair and asserts that CDP is
 * reported as configured and that the secret appears in neither the startup
 * output nor `/healthz`.
 *
 *   npm run smoke:start -w packages/demo-merchant-mcp
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRYPOINT = join(PACKAGE_ROOT, 'dist', 'index.js')
const TIMEOUT_MS = 20_000
const BANNER = 'Haven Demo Merchant MCP server'
// #4851: a throwaway CDP credential pair, so the run builds the Coinbase client
// and offers the joke. The Coinbase client signs per request, so construction
// with a fake secret succeeds and nothing reaches Coinbase. The secret must
// appear in neither the startup output nor /healthz.
const CDP_KEY_ID = 'smoke-cdp-key-id'
const CDP_KEY_SECRET = 'smoke-cdp-secret-must-never-be-printed'

// A free port picked here, so /healthz can be asked after the banner (the
// banner prints the configured URL, not the bound port).
const PORT = await new Promise((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const child = spawn(process.execPath, [ENTRYPOINT], {
  cwd: PACKAGE_ROOT,
  env: {
    ...process.env,
    // Throwaway values: a valid address, a valid 32-byte key, and a free port.
    // Nothing here reaches a chain.
    MERCHANT_ADDRESS: '0x1111111111111111111111111111111111111111',
    SETTLEMENT_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
    BASE_RPC_URL: 'http://127.0.0.1:1',
    PORT: String(PORT),
    // Explicitly unset so the smoke run exercises the no-passport path, which
    // is the default deployment shape.
    MERCHANT_HAVEN_BASE_URL: '',
    MERCHANT_PASSPORT_ISSUER: '',
    CDP_API_KEY_ID: CDP_KEY_ID,
    CDP_API_KEY_SECRET: CDP_KEY_SECRET,
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

let checking = false

async function checkRunningService() {
  // The banner and the CDP line are printed together; wait for the CDP line.
  const healthz = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).text()
  if (!stdout.includes("CDP:       configured")) {
    return finish(1, 'CDP credentials were set but the banner does not say CDP is configured')
  }
  if (!/"cdp":\{"configured":true/.test(healthz)) {
    return finish(1, `/healthz does not report CDP as configured: ${healthz}`)
  }
  for (const [where, text] of [['stdout', stdout], ['stderr', stderr], ['/healthz', healthz]]) {
    if (text.includes(CDP_KEY_SECRET)) return finish(1, `the CDP key secret appeared in ${where}`)
  }
  finish(0, 'the built service started, bound its socket, reports CDP, and never printed the CDP secret')
}

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString()
  if (!checking && stdout.includes(BANNER) && stdout.includes('CDP:')) {
    checking = true
    checkRunningService().catch((error) => finish(1, `/healthz check failed: ${error.message}`))
  }
})

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString()
})

child.on('error', (error) => finish(1, `could not spawn ${ENTRYPOINT}: ${error.message}`))

child.on('exit', (code, signal) => {
  if (!settled) finish(1, `exited before the startup banner (code ${code}, signal ${signal})`)
})
