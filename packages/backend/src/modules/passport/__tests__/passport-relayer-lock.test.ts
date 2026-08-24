/**
 * #1546, re-pointed by #1559 — passport submissions must go through the
 * outbound submit pipeline, which serialises on the relayer's nonce lane.
 *
 * Two tests, deliberately different in kind:
 *  - BEHAVIOURAL pins that two concurrent anchors cannot interleave their
 *    broadcasts, and that the anchor waits behind any other tenant of the
 *    shared lane. The REAL lock and the REAL submitRecorded pipeline run
 *    (real ethers signing against a fake provider); only the record open is
 *    stubbed to id-null so no database is touched.
 *  - A SCAN so the next submitter-shaped module cannot bypass the queue
 *    silently: queue-lane files must reference `submitRecorded`, and the set
 *    of legacy lock-only submitters (Safe-bound, retiring with #1440) is
 *    PINNED so it can only shrink.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_SRC = join(__dirname, '..', '..', '..')

// ── The behavioural pins ─────────────────────────────────────────────────────

const UID = '0x' + 'ab'.repeat(32)

const trace: string[] = []
let inFlight = 0
let maxConcurrent = 0
let pendingNonce = 7

const relayerModule = await vi.importActual<typeof import('../../../infra/relayer.js')>(
  '../../../infra/relayer.js',
)
const actualEthers = await vi.importActual<typeof import('ethers')>('ethers')

/**
 * A REAL ethers Wallet over a fake provider: real populate/sign (so the
 * pre-broadcast hash derivation in submitRecorded is exercised for real),
 * fake network. `broadcastTransaction` is where overlap would show.
 */
function fakeProviderWallet() {
  const provider = {
    getNetwork: async () => ({ chainId: 84532n, name: 'test' }),
    getFeeData: async () => ({ maxFeePerGas: 200n, maxPriorityFeePerGas: 10n, gasPrice: 200n }),
    estimateGas: async () => 60_000n,
    getTransactionCount: async () => pendingNonce,
    async broadcastTransaction(raw: string) {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      trace.push('broadcast:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      trace.push('broadcast:end')
      inFlight -= 1
      pendingNonce += 1
      const parsed = actualEthers.Transaction.from(raw)
      return { hash: parsed.hash, nonce: parsed.nonce, wait: async () => ({ status: 1 }) }
    },
  }
  return new actualEthers.Wallet('0x' + '11'.repeat(32), provider as never)
}
const wallet = fakeProviderWallet()

vi.mock('../../../infra/relayer.js', async () => {
  // The REAL lock — mocking it would test the mock. Only `getRelayer` is faked.
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => wallet }
})

vi.mock('../../../infra/outbound-queue.js', async () => {
  // REAL submitRecorded (the pipeline under test); only the record open is
  // stubbed to id-null so the fence path skips the database entirely.
  const actual = await vi.importActual<typeof import('../../../infra/outbound-queue.js')>(
    '../../../infra/outbound-queue.js',
  )
  return {
    ...actual,
    openOutboundRecord: async () => ({
      id: null,
      broadcast: async () => undefined,
      mined: async () => undefined,
      failed: async () => undefined,
    }),
  }
})

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  class FakeContract {
    // staticCall is the only legitimate Contract use left on the anchor path
    // (#1559): a direct contract SEND would bypass the pipeline, so it throws.
    attest = Object.assign(
      async () => {
        throw new Error('direct contract broadcast — must go through submitRecorded')
      },
      { staticCall: async () => UID },
    )
    revoke = async () => {
      throw new Error('direct contract broadcast — must go through submitRecorded')
    }
  }
  return { ...actual, Contract: FakeContract }
})

const { anchorOnChain, revokeOnChain } = await import('../attestation.js')

const claim = {
  agentEoa: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  smartAccount: '0x2222222222222222222222222222222222222222',
  treasury: '0x3333333333333333333333333333333333333333',
  assuranceLevel: 0,
  policyUri: 'haven:agent:abc',
  issuedAt: 1_700_000_000,
  expiresAt: 0,
} as Parameters<typeof anchorOnChain>[1]

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = UID
  trace.length = 0
  inFlight = 0
  maxConcurrent = 0
  pendingNonce = 7
})

/**
 * Hold the shared lane the way another submitter would, and always give it
 * back — `release()` is idempotent and safe in a `finally`.
 */
function occupyLane() {
  let releaseInner: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    releaseInner = resolve
  })
  const done = relayerModule.withRelayerSendLock(84532, () => held)
  return {
    async release() {
      releaseInner?.()
      await done
    },
  }
}

describe('passport anchoring goes through the serialised submit pipeline (#1546/#1559)', () => {
  it('serialises two concurrent anchors — broadcasts never overlap', async () => {
    await Promise.all([anchorOnChain(84532, claim), anchorOnChain(84532, claim)])

    expect(maxConcurrent).toBe(1)
    expect(trace).toEqual([
      'broadcast:start',
      'broadcast:end',
      'broadcast:start',
      'broadcast:end',
    ])
  })

  it('a lane already busy with another submitter delays the anchor, not the reverse', async () => {
    const lane = occupyLane()
    try {
      const anchor = anchorOnChain(84532, claim)
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(trace).toEqual([]) // still waiting behind the other submitter

      await lane.release()
      await anchor
      expect(trace).toEqual(['broadcast:start', 'broadcast:end'])
    } finally {
      await lane.release()
    }
  })

  it('revocation takes the lane too', async () => {
    const lane = occupyLane()
    try {
      let done = false
      const revoke = revokeOnChain(84532, UID).then(() => { done = true })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(done).toBe(false)

      await lane.release()
      await revoke
      expect(done).toBe(true)
    } finally {
      await lane.release()
    }
  })
})

// ── The scan ─────────────────────────────────────────────────────────────────

/** Every .ts source under the backend, tests excluded. */
function backendSources(dir = BACKEND_SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules' && entry !== '__tests__') backendSources(full, out)
      // NOTE: filter on `.test.` — a bare `grep -v test` silently drops
      // `atte(st)ation.ts`, which is how the original scan missed the file
      // this issue is about (#1546).
    } else if (entry.endsWith('.ts') && !entry.includes('.test.')) {
      out.push(full)
    }
  }
  return out
}

/**
 * Calls that BROADCAST. Read-only relayer use (balance monitoring, address
 * derivation, `staticCall`) needs no serialisation and must not be flagged.
 */
const WRITE_SHAPED = /\.(sendTransaction|attest|revoke|execTransaction|executeAllowanceTransfer|broadcastTransaction)\s*\(/

/**
 * The Safe-bound legacy submitters (#1440 retires them) — the ONLY files
 * allowed to broadcast under the bare lock instead of `submitRecorded`.
 * PINNED so the set can only shrink: a new submitter that reaches for the
 * bare lock instead of the queue fails the scan by not being listed here.
 */
const LEGACY_LOCK_ONLY = new Set([
  'infra/relayer.ts', // the lock's home; no broadcast of its own
  'infra/outbound-queue.ts', // the pipeline itself broadcasts, by design
  'rails/allowance-module.ts',
  'routes/safe-exec.ts',
  // Shrunk by #1988 (epic #1440): `modules/accounts/safe-deployer.ts` is
  // DELETED, and `routes/safe-deploy.ts` is a 410 tombstone that no longer
  // touches the relayer at all. `infra/chain/safe-proxy-deployer.ts` stays —
  // trimmed to `ensurePasskeySignerDeployed`, which `routes/safe-exec.ts`
  // still reaches and which still broadcasts under the lock.
  'infra/chain/safe-proxy-deployer.ts',
])

describe('scan: no submitter outside the outbound pipeline (#1559)', () => {
  it('every write-shaped relayer consumer uses submitRecorded, or is a pinned legacy site', () => {
    const offenders: string[] = []
    for (const file of backendSources()) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('getRelayer(')) continue
      const writes = source
        .split('\n')
        .filter((line) => WRITE_SHAPED.test(line) && !line.includes('staticCall'))
      if (writes.length === 0) continue
      const rel = file.slice(BACKEND_SRC.length + 1)
      if (LEGACY_LOCK_ONLY.has(rel)) {
        // Legacy sites still need the lock reference (#1546's original rule).
        if (!source.includes('withRelayerSendLock')) offenders.push(`${rel} (legacy, no lock)`)
        continue
      }
      if (!source.includes('submitRecorded')) offenders.push(`${rel} (broadcasts outside the pipeline)`)
    }
    expect(offenders).toEqual([])
  })

  it('the legacy set can only SHRINK — its members still exist and still broadcast', () => {
    // A pinned allowlist rots when entries linger after their file dies or
    // stops broadcasting; each entry must still earn its place, so removals
    // are forced through this test the same way additions are.
    //
    // #1988 strengthened the second half, because it was not being checked.
    // `readFileSync` alone catches a DELETED entry — that is how this test
    // caught `modules/accounts/safe-deployer.ts` — but `routes/safe-deploy.ts`
    // became a 410 tombstone with no relayer call in it at all and would have
    // sat here indefinitely, existing and broadcasting nothing: an allowlist
    // entry excusing a file from a rule it no longer comes near. So the
    // "still broadcast" clause is now asserted rather than only asserted-in-
    // prose. `infra/relayer.ts` and `infra/outbound-queue.ts` are exempt from
    // the clause for the reason their own comments give: one is the lock's
    // home and the other IS the pipeline.
    const NO_BROADCAST_OF_ITS_OWN = new Set(['infra/relayer.ts', 'infra/outbound-queue.ts'])
    for (const rel of LEGACY_LOCK_ONLY) {
      const source = readFileSync(join(BACKEND_SRC, rel), 'utf8')
      expect(source.length).toBeGreaterThan(0)
      if (NO_BROADCAST_OF_ITS_OWN.has(rel)) continue
      expect(source, `${rel} is pinned as a legacy relayer site but no longer uses the relayer`)
        .toContain('getRelayer')
    }
  })

  it('the scan can actually see a violation — proven, not assumed', () => {
    // The shape of the bug: a getRelayer consumer broadcasting with neither
    // pipeline nor (for legacy) lock reference.
    const violating = [
      'const relayer = getRelayer(chainId)',
      'const tx = await relayer.sendTransaction(tx)',
    ].join('\n')
    const writes = violating
      .split('\n')
      .filter((line) => WRITE_SHAPED.test(line) && !line.includes('staticCall'))
    expect(writes).toHaveLength(1)
    expect(violating.includes('submitRecorded')).toBe(false)
    expect(violating.includes('withRelayerSendLock')).toBe(false)
  })

  it('does not flag a read-only relayer consumer', () => {
    const readOnly = "const relayer = getRelayer(chainId)\nawait provider.getBalance(relayer.address)"
    const writes = readOnly.split('\n').filter((line) => WRITE_SHAPED.test(line))
    expect(writes).toEqual([])
  })
})
