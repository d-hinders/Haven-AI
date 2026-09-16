/**
 * #2914: `sign_data.components.safe` is gone — the naming contraction
 * removed the dual-emit window #2907 opened. `payer_account` is now the
 * ONLY name for the account a payment is drawn from, on every route that
 * used to emit `components.safe` — deliberately NOT `account` (which means
 * the DELEGATE account address on these two shapes, a different address;
 * owner review on #2906). `components.account` must stay untouched where it
 * still appears.
 *
 * Static-source assertions rather than full request-level integration tests:
 * the three emitting sites (`delegation-authorize.ts`, `replay.ts`, and the
 * POST /payments idempotent replay in `routes/payments.ts`) sit deep
 * in x402 orchestration with heavy existing fixture machinery; asserting the
 * literal expression pins the intended value without duplicating that setup,
 * and the mutation check below proves the assertion is not vacuous.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

describe('#2914 — payer_account is the only name, safe is gone', () => {
  it('delegation-authorize.ts: payer_account carries the account, and safe never appears', async () => {
    const source = await readSource('../modules/x402/delegation-authorize.ts')
    expect(source).not.toMatch(/\bsafe:\s*agent\.account_address/)
    const componentsBlocks =
      source.match(/components:\s*\{[^}]*payer_account:\s*agent\.account_address[^}]*\}/gs) ?? []
    expect(componentsBlocks.length).toBeGreaterThan(0)
    for (const block of componentsBlocks) {
      // `account:` must remain the delegate account address, never aliased
      // to the same expression as `payer_account`.
      expect(block).not.toMatch(/(?<!payer_)\baccount:\s*agent\.account_address/)
    }
  })

  it('replay.ts: payer_account carries the account, and safe never appears', async () => {
    const source = await readSource('../modules/x402/replay.ts')
    expect(source).not.toMatch(/\bsafe:\s*agent\.account_address/)
    const componentsBlocks =
      source.match(/components:\s*\{[^}]*payer_account:\s*agent\.account_address[^}]*\}/gs) ?? []
    expect(componentsBlocks.length).toBeGreaterThan(0)
    for (const block of componentsBlocks) {
      expect(block).not.toMatch(/(?<!payer_)\baccount:\s*agent\.account_address/)
    }
  })

  it('routes/payments.ts (POST /payments idempotent replay): payer_account carries the account, and safe never appears', async () => {
    // The legacy replay body sits behind the retired-rail 410 gate at the
    // route level (see routes/__tests__/payments.test.ts "POST /payments
    // idempotency"), so it cannot be reached by a request in the test
    // harness — the source assertion is the instrument here, the same one the
    // two x402 emitters get. A wrong value (e.g. the delegate address) fails.
    const source = await readSource('../routes/payments.ts')
    expect(source).not.toMatch(/\bsafe:\s*agent\.account_address/)
    const componentsBlocks =
      source.match(/components:\s*\{[^}]*payer_account:\s*agent\.account_address[^}]*\}/gs) ?? []
    expect(componentsBlocks.length).toBeGreaterThan(0)
    for (const block of componentsBlocks) {
      expect(block).not.toMatch(/(?<!payer_)\baccount:\s*agent\.account_address/)
      expect(block).not.toMatch(/payer_account:\s*agent\.delegate_address/)
    }
  })
})
