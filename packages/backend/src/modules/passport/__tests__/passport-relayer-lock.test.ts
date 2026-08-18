/**
 * #1546 — passport submissions must share the relayer's nonce lane.
 *
 * The relayer EOA's nonce is strictly sequential and ethers populates it from
 * `getTransactionCount(…, 'pending')` at submit time, so two concurrent
 * broadcasts read the same pending nonce and one is rejected. The transaction
 * that dies is not necessarily the passport's: the loser can be a payment
 * funding, a gasless sweep, or a delegation-rail activation sharing the lane.
 *
 * Two tests, deliberately different in kind:
 *  - a BEHAVIOURAL pin that two concurrent anchors cannot interleave their
 *    broadcasts (fails if the lock is removed from `attestation.ts`);
 *  - a SCAN so the next passport-shaped module cannot reintroduce the gap
 *    silently — derived from the sources, not from a list someone maintains.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKEND_SRC = join(__dirname, '..', '..', '..')

// ── The behavioural pin ──────────────────────────────────────────────────────

const UID = '0x' + 'ab'.repeat(32)
const TX_HASH = '0x' + 'cd'.repeat(32)

/** Records broadcast enter/exit so overlap is observable. */
const trace: string[] = []
let inFlight = 0
let maxConcurrent = 0

const relayerModule = await vi.importActual<typeof import('../../../infra/relayer.js')>(
  '../../../infra/relayer.js',
)

vi.mock('../../../infra/relayer.js', async () => {
  // The REAL lock — mocking it would test the mock. Only `getRelayer` is faked,
  // because it needs a funded key and a provider.
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: '0x' + '11'.repeat(20) }) }
})

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  class FakeContract {
    attest = Object.assign(
      async () => {
        inFlight += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        trace.push('broadcast:start')
        // Yield across macrotasks: an unlocked second call would start here.
        await new Promise((resolve) => setTimeout(resolve, 20))
        trace.push('broadcast:end')
        inFlight -= 1
        return { hash: TX_HASH, wait: async () => ({ status: 1 }) }
      },
      { staticCall: async () => UID },
    )
    revoke = async () => ({ hash: TX_HASH, wait: async () => ({ status: 1 }) })
  }
  return { ...actual, Contract: FakeContract }
})

const { anchorOnChain, revokeOnChain } = await import('../attestation.js')

const claim = {
  agentEoa: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
  smartAccount: '0x2222222222222222222222222222222222222222',
  treasury: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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
})

/**
 * Hold the shared lane the way another submitter would, and always give it
 * back — `release()` is idempotent and safe in a `finally`. Without that, a
 * failing assertion mid-test leaves the lane held forever and every later test
 * in the file inherits the failure, which is noise masking the real result.
 */
function occupyLane(chainId = 84532) {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const done = relayerModule.withRelayerSendLock(chainId, () => held)
  return {
    async release() {
      release()
      await done
    },
  }
}

describe('passport anchoring holds the relayer send lock (#1546)', () => {
  it('serialises two concurrent anchors — broadcasts never overlap', async () => {
    await Promise.all([anchorOnChain(84532, claim), anchorOnChain(84532, claim)])

    // The whole invariant: at no point were two broadcasts in flight.
    expect(maxConcurrent).toBe(1)
    expect(trace).toEqual([
      'broadcast:start',
      'broadcast:end',
      'broadcast:start',
      'broadcast:end',
    ])
  })

  it('a lane already busy with another submitter delays the anchor, not the reverse', async () => {
    // Proves the anchor joins the SHARED lane rather than a private one: the
    // lock is taken with the same chain id another path would use.
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
 * derivation, `staticCall`) needs no lock and must not be flagged.
 */
const WRITE_SHAPED = /\.(sendTransaction|attest|revoke|execTransaction|executeAllowanceTransfer)\s*\(/

describe('scan: every write-shaped relayer consumer references the lock (#1546)', () => {
  // KNOWN PRECISION LIMIT (review finding, accepted): the predicate is
  // file-level — a file holding one locked and one UNLOCKED write site passes,
  // because `withRelayerSendLock` appears somewhere in it. Per-call-site
  // checking needs real parsing (broadcasts span lines); the behavioural pins
  // above are the defence for files this scan already knows about, and this
  // scan's job is the file with ZERO lock references — the exact shape
  // attestation.ts had. Tighten if a mixed-site bug ever actually appears.
  it('finds no unlocked submitter', () => {
    const offenders: string[] = []
    for (const file of backendSources()) {
      const source = readFileSync(file, 'utf8')
      if (!source.includes('getRelayer(')) continue
      const writes = source
        .split('\n')
        .filter((line) => WRITE_SHAPED.test(line) && !line.includes('staticCall'))
      if (writes.length > 0 && !source.includes('withRelayerSendLock')) {
        offenders.push(file.slice(BACKEND_SRC.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })

  it('the scan can actually see a violation — proven, not assumed', () => {
    // A guard that cannot fail is not a guard. This is the shape of the bug:
    // a getRelayer consumer that broadcasts with no lock reference anywhere.
    const violating = [
      "const relayer = getRelayer(chainId)",
      "const tx = await contract.attest(request)",
    ].join('\n')
    const writes = violating
      .split('\n')
      .filter((line) => WRITE_SHAPED.test(line) && !line.includes('staticCall'))
    expect(writes).toHaveLength(1)
    expect(violating.includes('withRelayerSendLock')).toBe(false)
  })

  it('does not flag a read-only relayer consumer', () => {
    const readOnly = "const relayer = getRelayer(chainId)\nawait provider.getBalance(relayer.address)"
    const writes = readOnly.split('\n').filter((line) => WRITE_SHAPED.test(line))
    expect(writes).toEqual([])
  })
})
