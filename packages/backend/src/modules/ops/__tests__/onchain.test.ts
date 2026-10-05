/**
 * `buildOpsOnchainView` (#3513, epic #3507) — the DB-vs-chain merge, with
 * every chain read MOCKED (no RPC module is imported here; the readers come
 * in through `OpsOnchainReaders`, which is also how the route gets them).
 *
 * What is pinned, per the issue's acceptance criteria:
 * - deployed vs counterfactual (bytecode leg);
 * - delegation disabled on-chain but active in the DB is flagged;
 * - budget remaining is computed (`fromChain: true` → the figure);
 * - `fromChain: false` renders `unavailable`, never a remaining figure;
 * - `legacy_safe`, unserved-chain and unpinned-chain rows are `not_served`
 *   with their reason and ZERO reader calls;
 * - a second call within the 60 s TTL makes no reader calls (single-flight
 *   cache, the `platform/cache` pattern);
 * - a per-chain RPC failure renders that chain `unavailable`, not a throw.
 * Plus the masking contract: no raw address, no `delegation_json`, no
 * `delegation_hash` anywhere in the response.
 *
 * The env is set BEFORE the module graph loads: `domain/chains.ts` reads
 * `HAVEN_DEPLOY_CHAIN_IDS` at import time, and dev's shape — Base Sepolia
 * only — is the shape these tests assume (same pattern as
 * `domain/__tests__/chains.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Executor, QueryRow } from '../../../infra/transaction.js'
import type { OpsOnchainReaders } from '../onchain.js'

process.env.HAVEN_DEPLOY_CHAIN_IDS = '84532'

const {
  buildOpsOnchainView,
  createTestCache,
  onchainCacheKey,
  OPS_ONCHAIN_CACHE_TTL_MS,
} = await import('../onchain.js')

const ACCOUNT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const HASH_A = `0x${'a'.repeat(64)}`
const DELEGATION_JSON = '{"signed":"never-returned"}'

function execWith(rows: { users: unknown[]; accounts: unknown[]; delegations: unknown[] }): Executor {
  return {
    async query<R extends QueryRow = QueryRow>(sql: string): Promise<{ rows: R[]; rowCount: number | null }> {
      if (/FROM users/.test(sql)) return { rows: rows.users as R[], rowCount: rows.users.length }
      if (/FROM smart_accounts/.test(sql)) return { rows: rows.accounts as R[], rowCount: rows.accounts.length }
      if (/FROM agent_delegations/.test(sql)) return { rows: rows.delegations as R[], rowCount: rows.delegations.length }
      throw new Error(`unexpected sql: ${sql}`)
    },
  }
}

interface AccountRow {
  id: string
  chain_id: number
  account_address: string
  account_type: string
  execution_rail: string
  name: string
  delegations: {
    account_id: string
    chain_id: number
    delegation_hash: string
    delegation_json: string
    budget_atomic: string
  }[]
}

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'acc-1',
    chain_id: 84532,
    account_address: ACCOUNT,
    account_type: 'delegator_hybrid',
    execution_rail: 'delegation',
    name: 'Account 1',
    delegations: [],
    ...overrides,
  }
}

function delegation(accountId: string, hash: string, budget = '1000000'): AccountRow['delegations'][number] {
  return {
    account_id: accountId,
    chain_id: 84532,
    delegation_hash: hash,
    delegation_json: DELEGATION_JSON,
    budget_atomic: budget,
  }
}

/** Strict reader spy: throws on ANY chain call, so a not-served row is proven zero-RPC. */
function zeroReaders(): OpsOnchainReaders {
  const refuse = (): never => {
    throw new Error('a not-served row reached the chain')
  }
  return {
    chainHasDelegationPins: vi.fn((chainId: number) => chainId === 84532),
    accountHasCode: vi.fn(refuse),
    readDisabledDelegationHashes: vi.fn(refuse),
    readRemainingBudget: vi.fn(refuse),
  }
}

function happyReaders(overrides: Partial<OpsOnchainReaders> = {}): OpsOnchainReaders {
  return {
    chainHasDelegationPins: vi.fn((chainId: number) => chainId === 84532),
    accountHasCode: vi.fn(async () => true),
    readDisabledDelegationHashes: vi.fn(async () => new Set<`0x${string}`>()),
    readRemainingBudget: vi.fn(async (_chainId: number, _json: string, budget: string) => ({
      remainingAtomic: (BigInt(budget) / 2n).toString(),
      fromChain: true,
    })),
    ...overrides,
  }
}

type OpsOnchainView = NonNullable<Awaited<ReturnType<typeof buildOpsOnchainView>>>
type ReadableAccount = Extract<OpsOnchainView['accounts'][number], { chain: unknown }>

describe('ops on-chain view (#3513) — mocked chain reads', () => {
  it('reads a deployed account with an enabled delegation and computes the budget', async () => {
    const readers = happyReaders()
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', HASH_A)],
    })
    const view = await buildOpsOnchainView(db, 'u1', { readers, cache: createTestCache() })
    expect(view).not.toBeNull()
    expect(view!.accounts).toHaveLength(1)
    const account = view!.accounts[0] as ReadableAccount
    expect(account.account_id).toBe('acc-1')
    expect(account.account_address).toBe('0xaaaa…aaaa')
    expect(account.account_address).not.toBe(ACCOUNT)
    expect(account.chain.deploy_status).toBe('deployed')
    expect(account.chain.delegations).toHaveLength(1)
    expect(account.chain.delegations[0]).toEqual({
      budget_atomic: '1000000',
      onchain: 'enabled',
      budget_status: 'from_chain',
      budget_remaining_atomic: '500000',
    })
    expect(account.flags).toEqual({
      counterfactual_with_active_delegation: false,
      delegation_disabled_onchain_active_in_db: false,
    })
    const rendered = JSON.stringify(view)
    expect(rendered).not.toContain(DELEGATION_JSON)
    expect(rendered).not.toContain(HASH_A)
    expect(rendered).not.toContain(ACCOUNT)
  })

  it('flags a counterfactual account with an active stored delegation', async () => {
    const readers = happyReaders({ accountHasCode: vi.fn(async () => false) })
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', HASH_A)],
    })
    const view = await buildOpsOnchainView(db, 'u1', { readers, cache: createTestCache() })
    const account = view!.accounts[0] as ReadableAccount
    expect(account.chain.deploy_status).toBe('counterfactual')
    expect(account.flags.counterfactual_with_active_delegation).toBe(true)
  })

  it('flags a delegation disabled on-chain while active in the DB', async () => {
    const readers = happyReaders({
      readDisabledDelegationHashes: vi.fn(
        async (_chainId: number, hashes: readonly `0x${string}`[]) => new Set<`0x${string}`>(hashes),
      ),
    })
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', HASH_A)],
    })
    const view = await buildOpsOnchainView(db, 'u1', { readers, cache: createTestCache() })
    const account = view!.accounts[0] as ReadableAccount
    expect(account.chain.delegations[0].onchain).toBe('disabled')
    expect(account.flags.delegation_disabled_onchain_active_in_db).toBe(true)
  })

  it('renders fromChain:false as unavailable and never a remaining figure', async () => {
    const readers = happyReaders({
      readRemainingBudget: vi.fn(async () => ({ remainingAtomic: '999999', fromChain: false })),
    })
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', HASH_A)],
    })
    const view = await buildOpsOnchainView(db, 'u1', { readers, cache: createTestCache() })
    const account = view!.accounts[0] as ReadableAccount
    expect(account.chain.delegations[0]).toEqual({
      budget_atomic: '1000000',
      onchain: 'enabled',
      budget_status: 'unavailable',
      budget_remaining_atomic: null,
    })
  })

  it('lists legacy_safe and unserved-chain rows not_served with ZERO reader calls', async () => {
    const readers = zeroReaders()
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [
        accountRow({ id: 'acc-legacy', account_type: 'legacy_safe', execution_rail: 'allowance_module' }),
        accountRow({ id: 'acc-unserved', chain_id: 8453 }), // supported and pinned, but this environment does not serve it
      ],
      delegations: [],
    })
    const view = await buildOpsOnchainView(db, 'u1', { readers, cache: createTestCache() })
    // The response is ordered by chain_id: 8453 (not served here) first.
    expect(view!.accounts.map((a) => (a as { reason?: string }).reason ?? 'READ')).toEqual([
      'chain_not_served',
      'legacy_safe',
    ])
    expect(readers.accountHasCode).not.toHaveBeenCalled()
    expect(readers.readDisabledDelegationHashes).not.toHaveBeenCalled()
    expect(readers.readRemainingBudget).not.toHaveBeenCalled()
  })

  it('a served-but-unpinned chain is not_served (zero RPC) even for a delegator_hybrid row', async () => {
    const readers: OpsOnchainReaders = {
      ...zeroReaders(),
      // The env serves 84532, which this environment pretends has no pins.
      chainHasDelegationPins: vi.fn(() => false),
    }
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [],
    })
    const view = await buildOpsOnchainView(db, 'u1', { readers, cache: createTestCache() })
    expect(view!.accounts[0]).toMatchObject({ status: 'not_served', reason: 'chain_not_pinned' })
    expect(readers.accountHasCode).not.toHaveBeenCalled()
  })

  it('a second call within the TTL makes no reader calls (single-flight cache)', async () => {
    const readers = happyReaders()
    const cache = createTestCache()
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', HASH_A)],
    })
    // #3624: pin the clock. `generated_at` is stamped per call (only the
    // read-set is cached), so two calls straddling a millisecond boundary
    // differed and `toEqual` flaked (~2 in 10 runs).
    const now = () => 1_700_000_000_000
    const first = await buildOpsOnchainView(db, 'u1', { readers, cache, now })
    const second = await buildOpsOnchainView(db, 'u1', { readers, cache, now })
    expect((readers.accountHasCode as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect((readers.readDisabledDelegationHashes as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect((readers.readRemainingBudget as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
    expect(second).toEqual(first)
    expect(OPS_ONCHAIN_CACHE_TTL_MS).toBe(60_000)
    expect(onchainCacheKey(84532, 'u1')).toBe('ops-onchain:84532:u1')
  })

  it('a per-chain RPC failure renders unavailable, not a 500', async () => {
    const readers = happyReaders({
      accountHasCode: vi.fn(async () => {
        throw new Error('RPC burst limit')
      }),
      readDisabledDelegationHashes: vi.fn(async () => {
        throw new Error('RPC burst limit')
      }),
      readRemainingBudget: vi.fn(async () => {
        throw new Error('RPC burst limit')
      }),
    })
    const db = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', HASH_A)],
    })
    const view = await buildOpsOnchainView(db, 'u1', { readers, cache: createTestCache() })
    expect(view).not.toBeNull()
    const account = view!.accounts[0] as ReadableAccount
    expect(account.chain.deploy_status).toBe('unavailable')
    expect(account.chain.delegations[0]).toMatchObject({ onchain: 'unavailable', budget_status: 'unavailable' })
  })

  it('an unknown user answers null; a user with no accounts answers an empty list', async () => {
    const readers = zeroReaders()
    const nobody = execWith({ users: [], accounts: [], delegations: [] })
    expect(await buildOpsOnchainView(nobody, 'u-none', { readers, cache: createTestCache() })).toBeNull()
    const empty = execWith({ users: [{ id: 'u1' }], accounts: [], delegations: [] })
    const view = await buildOpsOnchainView(empty, 'u1', { readers, cache: createTestCache() })
    expect(view).toEqual({ user_id: 'u1', accounts: [], generated_at: expect.any(String) })
    expect(readers.accountHasCode).not.toHaveBeenCalled()
  })

  it('legs missing from the cached read-set render unknown, never a guess', async () => {
    const readers = happyReaders()
    // The cached read-set covers only HASH_A; a delegation created mid-TTL
    // (second read, same (chain, user) key) must answer `unknown` for its
    // legs — the read-set simply does not know yet.
    const cache = createTestCache()
    const firstDb = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', HASH_A)],
    })
    await buildOpsOnchainView(firstDb, 'u1', { readers, cache })
    const secondDb = execWith({
      users: [{ id: 'u1' }],
      accounts: [accountRow()],
      delegations: [delegation('acc-1', `0x${'b'.repeat(64)}`, '700')],
    })
    const second = await buildOpsOnchainView(secondDb, 'u1', { readers, cache })
    const account = second!.accounts[0] as ReadableAccount
    expect(account.chain.delegations[0]).toMatchObject({ onchain: 'unknown', budget_status: 'unknown' })
    // The ACCOUNT was already read (bytecode is keyed by address and covered
    // by the cached set); only the mid-TTL delegation's legs are unknown.
    expect(account.chain.deploy_status).toBe('deployed')
  })
})
