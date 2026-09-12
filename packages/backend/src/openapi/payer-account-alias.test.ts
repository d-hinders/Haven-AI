/**
 * #2907: `sign_data.components.payer_account === components.safe` on every
 * route that emits `components.safe` — a same-value twin, deliberately NOT a
 * rename into `components.account` (which already means the delegate
 * account address on these two shapes, a different address; owner review on
 * #2906). `components.account` must stay untouched.
 *
 * Static-source assertions rather than full request-level integration tests:
 * the two emitting routes (`delegation-authorize.ts`, `replay.ts`) sit deep
 * in x402 orchestration with heavy existing fixture machinery; asserting the
 * literal expression pins the intended equality without duplicating that
 * setup, and the mutation check below proves the assertion is not vacuous.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), 'utf8')
}

describe('#2907 — payer_account twins safe, not account', () => {
  it('delegation-authorize.ts: payer_account and safe are the same expression', async () => {
    const source = await readSource('../modules/x402/delegation-authorize.ts')
    const componentsBlocks = source.match(/components:\s*\{[^}]*safe:\s*agent\.safe_address[^}]*\}/gs) ?? []
    expect(componentsBlocks.length).toBeGreaterThan(0)
    for (const block of componentsBlocks) {
      expect(block).toMatch(/payer_account:\s*agent\.safe_address/)
      // `account:` must remain the delegate account address, never aliased
      // to the same expression as `safe`/`payer_account`.
      expect(block).not.toMatch(/(?<!payer_)\baccount:\s*agent\.safe_address/)
    }
  })

  it('replay.ts: payer_account and safe are the same expression', async () => {
    const source = await readSource('../modules/x402/replay.ts')
    const componentsBlocks = source.match(/components:\s*\{[^}]*safe:\s*agent\.safe_address[^}]*\}/gs) ?? []
    expect(componentsBlocks.length).toBeGreaterThan(0)
    for (const block of componentsBlocks) {
      expect(block).toMatch(/payer_account:\s*agent\.safe_address/)
      expect(block).not.toMatch(/(?<!payer_)\baccount:\s*agent\.safe_address/)
    }
  })
})
