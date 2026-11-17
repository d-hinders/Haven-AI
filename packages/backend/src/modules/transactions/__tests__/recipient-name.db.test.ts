/**
 * #4882 on the REAL database: the catalog step of the one recipient-naming
 * order, the receipt-borrowing rule, and the loader end to end. No mocks:
 * the claims are SQL claims (which catalog rows name an address, which do
 * not, and what a receipt may name).
 *
 * The catalog rule (owner decision 1 of 2026-11-17 on #4882): an address on
 * a chain is named by a catalog merchant only when every live row at that
 * address on that network belongs to ONE merchant, all of them Haven-curated
 * `operator` rows, at least one an active verified x402 row.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { listCatalogMerchantNameAddresses, listCatalogRecipientNames } from '../../../infra/repositories/merchants.js'
import { resolveRecipientName } from '../counterparty-name.js'
import { loadRecipientNameIndex } from '../recipient-name-index.js'

let seq = 0
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

async function seedMerchant(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO merchants (slug, name) VALUES ($1, $2) RETURNING id`, [
    `m-${++seq}`,
    name,
  ])
  return rows[0].id
}

async function seedOffer(
  merchantId: string,
  payTo: string | null,
  opts: { network?: string; status?: string; verified?: boolean; source?: string; rail?: string } = {},
): Promise<void> {
  seq += 1
  await db.query(
    `INSERT INTO merchant_catalog
       (name, description, category, resource_url, rail, protocol, network, status, verified_at, merchant_id, pay_to, source)
     VALUES ($1, 'x', 'api', $2, $3, 'http', $4, $5, $6, $7, $8, $9)`,
    [
      `offer-${seq}`,
      `https://offer-${seq}.example/paid`,
      opts.rail ?? 'x402',
      opts.network ?? 'eip155:8453',
      opts.status ?? 'active',
      opts.verified === false ? null : new Date().toISOString(),
      merchantId,
      payTo,
      opts.source ?? 'operator',
    ],
  )
}

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`recipient-name-${++seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

/** A confirmed x402 payment to `merchant` with a stored receipt naming `sellerName`. */
async function seedReceipt(userId: string, merchant: string, sellerName: string): Promise<void> {
  const agent = await db.query<{ id: string }>(`INSERT INTO agents (user_id, name) VALUES ($1, 'a') RETURNING id`, [userId])
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (agent_id, user_id, account_address, token_symbol, token_address, to_address,
       amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, expires_at, chain_id)
     VALUES ($1, $2, '0x' || repeat('a', 40), 'USDC', '0x' || repeat('b', 40), $3, '1000', '0.001',
             '0x' || repeat('c', 40), 1, $4, 'confirmed', NOW() + interval '10 minutes', 8453)
     RETURNING id`,
    [agent.rows[0].id, userId, merchant, `0x${String(++seq).padStart(64, 'd')}`],
  )
  const evidence = await db.query<{ id: string }>(
    `INSERT INTO machine_payment_evidence (payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url,
       merchant_address, payer_address, settlement_address, token_symbol, token_address, amount_raw, amount_human)
     VALUES ($1, $2, $3, 'x402', $4, 8453, 'https://merchant.example', $5,
             '0x' || repeat('e', 40), '0x' || repeat('f', 40), 'USDC', '0x' || repeat('b', 40), '1000', '0.001')
     RETURNING id`,
    [intent.rows[0].id, agent.rows[0].id, userId, `0x${String(++seq).padStart(64, '1')}`, merchant],
  )
  await db.query(`INSERT INTO merchant_receipts (evidence_id, inline_json) VALUES ($1, $2)`, [
    evidence.rows[0].id,
    JSON.stringify({ saljare: { name: sellerName } }),
  ])
}

const names = async (addresses: string[]) =>
  (await listCatalogRecipientNames(addresses)).map((r) => `${Number(r.chain_id)}:${r.pay_to}:${r.name}`).sort()

describeDb('the catalog step of the recipient-naming order (#4882)', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('names an address that is the verified receiving address of exactly one operator merchant, on that chain', async () => {
    const m = await seedMerchant('NordShield VPN')
    await seedOffer(m, addr(1))
    await seedOffer(m, addr(1)) // a second offer of the SAME merchant still names it
    expect(await names([addr(1)])).toEqual([`8453:${addr(1)}:NordShield VPN`])
  })

  it('an address shared by two merchants names neither — whatever the second row is', async () => {
    const a = await seedMerchant('A')
    const b = await seedMerchant('B')
    await seedOffer(a, addr(2))
    await seedOffer(b, addr(2), { verified: false, status: 'degraded' })
    expect(await names([addr(2)])).toEqual([])
  })

  it('a bazaar (seller-listed) row never names, and makes a shared operator row ambiguous', async () => {
    const seller = await seedMerchant('Seller Words')
    await seedOffer(seller, addr(3), { source: 'bazaar' })
    expect(await names([addr(3)])).toEqual([])

    const op = await seedMerchant('Operator Co')
    await seedOffer(op, addr(4))
    await seedOffer(op, addr(4), { source: 'bazaar' })
    expect(await names([addr(4)])).toEqual([])
  })

  it('needs an active, verified x402 row; a delisted row is ignored entirely', async () => {
    const m = await seedMerchant('M')
    await seedOffer(m, addr(5), { verified: false })
    await seedOffer(m, addr(6), { status: 'degraded' })
    await seedOffer(m, addr(7), { rail: 'mpp' })
    expect(await names([addr(5), addr(6), addr(7)])).toEqual([])

    const live = await seedMerchant('Live')
    const gone = await seedMerchant('Gone')
    await seedOffer(live, addr(8))
    await seedOffer(gone, addr(8), { status: 'delisted' })
    expect(await names([addr(8)])).toEqual([`8453:${addr(8)}:Live`])
  })

  it('is per chain: the same address on another network is its own entry; a non-EVM network never names', async () => {
    const a = await seedMerchant('On Base')
    const b = await seedMerchant('On Sepolia')
    await seedOffer(a, addr(9))
    await seedOffer(b, addr(9), { network: 'eip155:84532' })
    await seedOffer(a, addr(10), { network: 'solana:mainnet' })
    expect(await names([addr(9), addr(10)])).toEqual([`84532:${addr(9)}:On Sepolia`, `8453:${addr(9)}:On Base`].sort())
  })

  it('a catalog entry with no recorded address matches nothing', async () => {
    const m = await seedMerchant('No Address')
    await seedOffer(m, null)
    expect(await names([addr(11)])).toEqual([])
  })

  it('matches a mixed-case input address (pay_to is stored lowercase)', async () => {
    const m = await seedMerchant('Cased')
    const lower = '0xabcdef0123456789abcdef0123456789abcdef01'
    await seedOffer(m, lower)
    const checksummed = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01'
    expect((await listCatalogRecipientNames([checksummed])).map((r) => r.name)).toEqual(['Cased'])
  })

  it('the borrowing lookup returns a catalog name with each address a CURATED row records, by name key', async () => {
    const m = await seedMerchant('  Nord\u200bShield   VPN ')
    await seedOffer(m, addr(12))
    await seedOffer(m, null)
    const bazaar = await seedMerchant('NordShield-VPN')
    await seedOffer(bazaar, addr(13), { source: 'bazaar' })
    const rows = await listCatalogMerchantNameAddresses(['nordshieldvpn'])
    // The bazaar row's address is not an allowed one: only curated rows vouch.
    expect(rows.map((r) => r.pay_to).filter(Boolean)).toEqual([addr(12)])
    expect(rows.every((r) => r.name_key === 'nordshieldvpn')).toBe(true)
  })

  it('a merchant whose verified offers on a network disagree, or leave one unstated, names neither address', async () => {
    const split = await seedMerchant('Split')
    await seedOffer(split, addr(14))
    await seedOffer(split, addr(15))
    const unstated = await seedMerchant('Unstated')
    await seedOffer(unstated, addr(16))
    await seedOffer(unstated, null)
    expect(await names([addr(14), addr(15), addr(16)])).toEqual([])
  })

  it('a chain id beyond int4 is read, not an error that drops every name', async () => {
    const big = await seedMerchant('Big Chain')
    const base = await seedMerchant('Base Merchant')
    await seedOffer(big, addr(17), { network: 'eip155:11297108109' })
    await seedOffer(base, addr(18))
    expect(await names([addr(17), addr(18)])).toEqual([`11297108109:${addr(17)}:Big Chain`, `8453:${addr(18)}:Base Merchant`].sort())
  })
})

describeDb('loadRecipientNameIndex end to end (#4882)', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('a receipt that borrows a catalog merchant’s name at another address is not used; the catalog names its own address', async () => {
    const userId = await seedUser()
    const m = await seedMerchant('NordShield VPN')
    await seedOffer(m, addr(20))
    await seedReceipt(userId, addr(21), 'nordshield vpn') // the impostor
    await seedReceipt(userId, addr(22), 'Klara Data AB') // an honest seller name

    const index = await loadRecipientNameIndex(userId, [addr(20), addr(21), addr(22)], { accounts: [], contacts: [] })
    const at = (a: string) => resolveRecipientName(index, { address: a, chainId: 8453, x402ResourceUrl: null })
    expect(at(addr(20))).toEqual({ label: 'NordShield VPN', kind: 'catalog' })
    expect(at(addr(21))).toEqual({ label: null, kind: 'unknown' })
    expect(at(addr(22))).toEqual({ label: 'Klara Data AB', kind: 'receipt' })
  })

  it('a seller-listed (bazaar) copy of a curated name cannot make its own address an allowed one', async () => {
    const userId = await seedUser()
    const curated = await seedMerchant('NordShield VPN')
    await seedOffer(curated, addr(23))
    const copy = await seedMerchant('NordShield VPN')
    await seedOffer(copy, addr(24), { source: 'bazaar' })
    await seedReceipt(userId, addr(24), 'NordShield VPN')
    const index = await loadRecipientNameIndex(userId, [addr(24)], { accounts: [], contacts: [] })
    expect(resolveRecipientName(index, { address: addr(24), chainId: 8453, x402ResourceUrl: null })).toEqual({
      label: null,
      kind: 'unknown',
    })
  })

  it('a look-alike spelling (zero-width, punctuation, accents) still counts as borrowing', async () => {
    const userId = await seedUser()
    const m = await seedMerchant('NordShield VPN')
    await seedOffer(m, addr(25))
    await seedReceipt(userId, addr(26), 'Nord\u200bShiéld-VPN')
    const index = await loadRecipientNameIndex(userId, [addr(26)], { accounts: [], contacts: [] })
    expect(resolveRecipientName(index, { address: addr(26), chainId: 8453, x402ResourceUrl: null }).label).toBeNull()
  })

  it('reads contacts and own accounts itself when the caller passes none', async () => {
    const userId = await seedUser()
    await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'Acme AB', $2)`, [userId, addr(30)])
    await db.query(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type, name)
       VALUES ($1, $2, 8453, 'delegator_hybrid', 'Old Vault')`,
      [userId, addr(31)],
    )
    const index = await loadRecipientNameIndex(userId, [addr(30), addr(31)])
    expect(resolveRecipientName(index, { address: addr(30), chainId: 8453, x402ResourceUrl: null }).label).toBe('Acme AB')
    expect(resolveRecipientName(index, { address: addr(31), chainId: 8453, x402ResourceUrl: null }).label).toBe('Old Vault')
  })
})
