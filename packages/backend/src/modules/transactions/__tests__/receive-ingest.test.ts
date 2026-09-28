/**
 * The ingest filter and the settlement-token resolution (#3333 round-2 F-1).
 *
 * What is proven here and nowhere else: a Gnosis USDC.e leg is INBOUND-indexed
 * — the old dot-stripped symbol test (`'USDC.e' → 'USDCE' ≠ 'USDC'`) skipped
 * every chain-100 leg, so nothing persisted there and
 * `usdcAddressForChain(100)` was null. Identity is the registry ADDRESS per
 * chain, so a contract that merely NAMES itself USDC is not the settlement
 * asset, and the bridged registry entry is.
 *
 * The registry is static data (no mocking); the persistence is real-DB
 * (`docs/contributing/testing-strategy.md`): the assertion the review asked
 * for is that the leg PERSISTS, not that a filter returned true.
 */
import type { FastifyBaseLogger } from 'fastify'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import db from '../../../db.js'
import { ingestInboundTransfers } from '../receive.js'
import { usdcAddressForChain } from '../off-ramp.js'
import type { RawERC20Transfer } from '../../../infra/explorer-api.js'

/** The registry's Gnosis bridged USDC.e contract (core chains.ts, verbatim). */
const GNOSIS_USDC_E = '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0'
/** The registry's Base native USDC contract. */
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const GNOSIS_EURE = '0xcB444e90D8198415266c6a2724b7900fb12FC56E'

const log = { warn: () => {} } as unknown as FastifyBaseLogger

let seq = 0

async function seedAccount(chainId: number): Promise<{ userId: string; accountId: string; address: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rcv-f1-${n}-${Date.now()}-${Math.random()}@test.example`],
  )
  const userId = user.rows[0].id
  const address = `0x${String(n).padStart(4, '0')}${'a'.repeat(36)}`
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, address, chainId],
  )
  return { userId, accountId: account.rows[0].id, address }
}

function leg(accountAddress: string, over: Partial<RawERC20Transfer> = {}): RawERC20Transfer {
  const n = ++seq
  return {
    blockNumber: String(4_000_000 + n),
    timeStamp: '1790534400',
    hash: `0x${String(n).padStart(4, '0')}${'f'.repeat(60)}`,
    from: `0x${String(n).padStart(4, '0')}${'b'.repeat(36)}`,
    to: accountAddress,
    value: '1000000',
    contractAddress: GNOSIS_USDC_E,
    tokenName: 'Bridged USD Coin',
    tokenSymbol: 'USDC.e',
    tokenDecimal: '6',
    ...over,
  }
}

describeDb('receive ingest token identity (#3333 round-2 F-1)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('persists a Gnosis USDC.e leg and skips every non-settlement leg on chain 100', async () => {
    const seeded = await seedAccount(100)
    const strangerAddress = `0x${'c'.repeat(40)}`

    const inserted = await ingestInboundTransfers(
      { id: seeded.accountId, userId: seeded.userId, accountAddress: seeded.address, chainId: 100 },
      [
        // The settlement asset by registry address — persisted.
        leg(seeded.address),
        // Same contract, checksummed differently in the explorer payload —
        // identity is case-insensitive on the address, still persisted.
        leg(seeded.address, {
          hash: `0x${'2'.repeat(64)}`,
          contractAddress: GNOSIS_USDC_E.toLowerCase(),
        }),
        // A different registry asset (EURe) — not the settlement asset.
        leg(seeded.address, {
          hash: `0x${'3'.repeat(64)}`,
          contractAddress: GNOSIS_EURE,
          tokenSymbol: 'EURe',
        }),
        // A contract that merely NAMES itself USDC — not the registry asset.
        leg(seeded.address, {
          hash: `0x${'4'.repeat(64)}`,
          contractAddress: `0x${'9'.repeat(40)}`,
          tokenSymbol: 'USDC',
        }),
        // The settlement asset, but inbound to a DIFFERENT address.
        leg(strangerAddress, { hash: `0x${'5'.repeat(64)}` }),
      ],
      log,
    )

    expect(inserted).toBe(2)

    const rows = await db.query<{ token_address: string; chain_id: number; amount_raw: string }>(
      `SELECT token_address, chain_id, amount_raw FROM inbound_transfers WHERE account_id = $1`,
      [seeded.accountId],
    )
    expect(rows.rowCount).toBe(2)
    for (const row of rows.rows) {
      expect(row.chain_id).toBe(100)
      expect(row.token_address).toBe(GNOSIS_USDC_E.toLowerCase())
      expect(row.amount_raw).toBe('1000000')
    }
  })

  it('usdcAddressForChain resolves the bridged USDC.e contract on Gnosis and native USDC on Base', () => {
    expect(usdcAddressForChain(100)?.toLowerCase()).toBe(GNOSIS_USDC_E.toLowerCase())
    expect(usdcAddressForChain(8453)?.toLowerCase()).toBe(BASE_USDC.toLowerCase())
  })
})
