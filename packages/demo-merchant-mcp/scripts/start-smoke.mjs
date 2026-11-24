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
 * output nor `/healthz`. Since #5079 it checks the same for the settlement key.
 *
 * #5079: a second, sequential case spawns the same entrypoint with a
 * `MERCHANT_ADDRESS` that is not an address and requires a refusal: a non-zero
 * exit (not a signal or this script's timeout), no banner, stderr beginning
 * with `MERCHANT_ADDRESS is not a valid EVM address`, the bad value not echoed,
 * and neither the CDP secret nor the settlement key printed. It proves the
 * startup check in `src/index.ts` is wired, not only `resolveMerchantAddress`.
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
// Throwaway values: a valid address, a valid 32-byte key. Nothing reaches a chain.
const MERCHANT_ADDRESS = '0x1111111111111111111111111111111111111111'
const SETTLEMENT_PRIVATE_KEY = `0x${'11'.repeat(32)}`
// #5079: a value that is plainly not an address.
const BAD_MERCHANT_ADDRESS = 'not-an-address'
const REFUSAL_PREFIX = 'MERCHANT_ADDRESS is not a valid EVM address'
// #5079: variables that make index.ts warn BEFORE it reads MERCHANT_ADDRESS. The
// refusal case blanks them so "stderr begins with the refusal" cannot fail on a
// developer's shell for the wrong reason.
const EARLY_WARNING_VARIABLES = [
  'MERCHANT_X402_SETTLEMENT_METHODS',
  'MERCHANT_ERC7710_DELEGATION_MANAGER',
  'BASE_URL',
  'NODE_ENV',
  'MERCHANT_HAVEN_BASE_URL',
  'MERCHANT_PASSPORT_ISSUER',
]

// A free port picked here, so /healthz can be asked after the banner (the
// banner prints the configured URL, not the bound port).
async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function baseEnv(port) {
  return {
    ...process.env,
    MERCHANT_ADDRESS,
    SETTLEMENT_PRIVATE_KEY,
    BASE_RPC_URL: 'http://127.0.0.1:1',
    PORT: String(port),
    // Explicitly unset so the smoke run exercises the no-passport path, which
    // is the default deployment shape.
    MERCHANT_HAVEN_BASE_URL: '',
    MERCHANT_PASSPORT_ISSUER: '',
    CDP_API_KEY_ID: CDP_KEY_ID,
    CDP_API_KEY_SECRET: CDP_KEY_SECRET,
  }
}

/**
 * Spawns the entrypoint once and resolves `{ ok, message, stdout, stderr }`.
 * `onStdout` may settle the run early (the happy case); otherwise the run
 * settles when the child exits or the timeout fires.
 */
function runCase(env, { onStdout, onExit }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRYPOINT], { cwd: PACKAGE_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = { stdout: '', stderr: '' }
    let settled = false
    let closed = false
    let verdict
    // Resolve only once the child has closed, so the next case never starts
    // while this one still runs.
    const finish = () => {
      if (closed && verdict) resolve({ ...verdict, ...out })
    }
    const settle = (ok, message) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      verdict = { ok, message }
      child.kill('SIGTERM')
      // A child that ignores SIGTERM, or one that never spawned, must not hang
      // the smoke: give up waiting for `close` after a few seconds.
      setTimeout(() => {
        closed = true
        child.kill('SIGKILL')
        finish()
      }, 5_000).unref()
      finish()
    }
    const timer = setTimeout(() => settle(false, `no answer within ${TIMEOUT_MS} ms`), TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      out.stdout += chunk.toString()
      onStdout?.(out, settle)
    })
    child.stderr.on('data', (chunk) => {
      out.stderr += chunk.toString()
    })
    child.on('error', (error) => settle(false, `could not spawn ${ENTRYPOINT}: ${error.message}`))
    // Wait for the pipes to drain before judging the exit.
    child.on('close', (code, signal) => {
      if (!settled) onExit(out, code, signal, settle)
      closed = true
      finish()
    })
  })
}

async function happyCase() {
  const port = await freePort()
  let checking = false
  return runCase(baseEnv(port), {
    onStdout(out, settle) {
      if (checking || !out.stdout.includes(BANNER) || !out.stdout.includes('CDP:')) return
      checking = true
      ;(async () => {
        // The banner and the CDP line are printed together; wait for the CDP line.
        const healthz = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()
        if (!out.stdout.includes('CDP:       configured')) {
          return settle(false, 'CDP credentials were set but the banner does not say CDP is configured')
        }
        if (!/"cdp":\{"configured":true/.test(healthz)) {
          return settle(false, `/healthz does not report CDP as configured: ${healthz}`)
        }
        for (const [where, text] of [['stdout', out.stdout], ['stderr', out.stderr], ['/healthz', healthz]]) {
          if (text.includes(CDP_KEY_SECRET)) return settle(false, `the CDP key secret appeared in ${where}`)
          if (text.includes(SETTLEMENT_PRIVATE_KEY)) return settle(false, `the settlement key appeared in ${where}`)
        }
        settle(true, 'the built service started, bound its socket, reports CDP, and never printed a secret')
      })().catch((error) => settle(false, `/healthz check failed: ${error.message}`))
    },
    onExit(_out, code, signal, settle) {
      settle(false, `exited before the startup banner (code ${code}, signal ${signal})`)
    },
  })
}

async function refusalCase() {
  const env = { ...baseEnv(await freePort()), MERCHANT_ADDRESS: BAD_MERCHANT_ADDRESS }
  for (const name of EARLY_WARNING_VARIABLES) env[name] = ''
  for (const name of Object.keys(env)) if (name.startsWith('RAILWAY_')) delete env[name]
  return runCase(env, {
    onStdout(out, settle) {
      if (out.stdout.includes(BANNER)) settle(false, 'a bad MERCHANT_ADDRESS started the service (banner printed)')
    },
    onExit(out, code, signal, settle) {
      if (code === 0 || code === null) {
        return settle(false, `a bad MERCHANT_ADDRESS did not exit non-zero (code ${code}, signal ${signal})`)
      }
      if (out.stdout.includes(BANNER)) return settle(false, 'a bad MERCHANT_ADDRESS printed the banner')
      if (!out.stderr.startsWith(REFUSAL_PREFIX)) {
        return settle(false, `stderr does not begin with the refusal "${REFUSAL_PREFIX}"`)
      }
      for (const [where, text] of [['stdout', out.stdout], ['stderr', out.stderr]]) {
        if (text.includes(BAD_MERCHANT_ADDRESS)) return settle(false, `the bad value was echoed in ${where}`)
        if (text.includes(CDP_KEY_SECRET)) return settle(false, `the CDP key secret appeared in ${where}`)
        if (text.includes(SETTLEMENT_PRIVATE_KEY)) return settle(false, `the settlement key appeared in ${where}`)
      }
      settle(true, `a bad MERCHANT_ADDRESS refused startup (exit ${code}) naming the variable, and printed no secret`)
    },
  })
}

let failed = false
for (const [name, run] of [['start', happyCase], ['refusal', refusalCase]]) {
  const result = await run()
  if (result.ok) {
    console.log(`start smoke (${name}): OK — ${result.message}`)
  } else {
    failed = true
    console.error(`start smoke (${name}): FAILED — ${result.message}`)
    if (result.stdout) console.error(`--- stdout ---\n${result.stdout}`)
    if (result.stderr) console.error(`--- stderr ---\n${result.stderr}`)
  }
}
process.exitCode = failed ? 1 : 0
