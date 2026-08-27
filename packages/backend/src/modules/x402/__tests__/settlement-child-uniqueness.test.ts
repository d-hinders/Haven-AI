/**
 * The settlement child is INTENT-UNIQUE (#2094).
 *
 * This is the test the issue exists for. Before #2094 the child was built with
 * the kit's default salt (`0x00`) and its only clock-derived field was the
 * `timestamp` caveat's `beforeThreshold`, so two authorizations sharing
 * merchant `payTo`, token, amount and expiry SECOND produced a BYTE-IDENTICAL
 * child with the same `childHash` — nothing on-chain distinguished two of a
 * user's own look-alike open payments.
 *
 * The clock is FROZEN in the uniqueness cases on purpose. Left running, two
 * builds a millisecond apart could land in different seconds and produce
 * different children for a reason that has nothing to do with the salt — the
 * test would pass on the old code too, which is exactly the shape of a test
 * that cannot fail. Freezing removes the only other varying field, so a green
 * here is a statement about the salt and nothing else (and the mutation run
 * confirms it: reverting `salt:` to the default turns these red).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keccak256, stringToBytes } from 'viem'
import { AbiCoder } from 'ethers'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { buildSettlementDelegation, settlementSalt } from '../x402-delegation.js'
import { buildBudgetDelegation, delegationSalt, type HavenBudgetPolicy } from '../../../rails/delegation-policy.js'

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const DELEGATE_ACCT = ('0x' + 'dd'.repeat(20)) as `0x${string}`
const TREASURY = ('0x' + 'aa'.repeat(20)) as `0x${string}`
const MERCHANT = ('0x' + 'cc'.repeat(20)) as `0x${string}`
const NOW = Math.floor(Date.now() / 1000)

const INTENT_A = '11111111-1111-4111-8111-111111111111'
const INTENT_B = '22222222-2222-4222-8222-222222222222'

function budget(): HavenBudgetPolicy {
  return {
    agentId: 'a', chainId: 84532, treasuryAddress: TREASURY,
    delegateAccountAddress: DELEGATE_ACCT, tokenAddress: USDC,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60,
    expiresAt: NOW + 86_400, version: 1,
  }
}
const signedBudget = { ...buildBudgetDelegation(budget()), signature: ('0x' + 'ab'.repeat(65)) } as never

/** Two calls to this differ in NOTHING except the intent id. */
function req(intentId: string) {
  return {
    chainId: 84532,
    intentId,
    delegateAccountAddress: DELEGATE_ACCT,
    budgetDelegation: signedBudget,
    asset: USDC as `0x${string}`,
    amountAtomic: 100_000n,
    payTo: MERCHANT,
    maxTimeoutSeconds: 120,
  } as never
}

afterEach(() => {
  vi.useRealTimers()
})

/** Same merchant, token, amount AND expiry second — the #2094 collision case. */
function freezeClock() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'))
}

describe('the settlement child is intent-unique (#2094)', () => {
  it('THE PROOF: two authorizations identical in merchant/token/amount/second produce DIFFERENT children', () => {
    freezeClock()
    const a = buildSettlementDelegation(req(INTENT_A))
    const b = buildSettlementDelegation(req(INTENT_B))

    // The collision precondition really holds: every other field is equal.
    // Asserting it here is what makes the inequality below meaningful — without
    // it, a difference in expiry could be doing the work instead of the salt.
    expect(a.expiresAt).toBe(b.expiresAt)
    expect(a.child.delegate).toBe(b.child.delegate)
    expect(a.child.delegator).toBe(b.child.delegator)
    expect(a.child.authority).toBe(b.child.authority)
    expect(a.child.caveats).toEqual(b.child.caveats)

    // …and the children are nevertheless distinguishable on-chain.
    expect(a.childHash).not.toBe(b.childHash)
    expect((a.child as unknown as { salt: string }).salt).not.toBe(
      (b.child as unknown as { salt: string }).salt,
    )
  })

  it('POSITIVE CONTROL: the same collision inputs with the same intent id DO collide', () => {
    // The control the proof above needs. If this were also unequal, the test
    // above would be proving "two builds differ", not "two INTENTS differ" —
    // and would stay green under a random salt, which the issue forbids.
    freezeClock()
    const a = buildSettlementDelegation(req(INTENT_A))
    const b = buildSettlementDelegation(req(INTENT_A))
    expect(a.childHash).toBe(b.childHash)
  })

  it('DETERMINISM: the same intent recomputes to the same child, or no sweeper could ever find it', () => {
    // #2117's passive sweeper starts from a stored intent row and must be able
    // to derive the child it should look for. That is only possible if the salt
    // is a pure function of the intent — never random, never clock-seeded.
    freezeClock()
    const first = buildSettlementDelegation(req(INTENT_A))
    vi.advanceTimersByTime(300) // same second, later instant
    const recomputed = buildSettlementDelegation(req(INTENT_A))
    expect(recomputed.childHash).toBe(first.childHash)
    expect(recomputed.child).toEqual(first.child)
  })

  it('the salt is exactly keccak256 of the domain-tagged intent id — recomputable without this module', () => {
    // Spelled out rather than asserted through the builder: a verifier outside
    // the backend must be able to reproduce it from the published rule alone.
    expect(settlementSalt(INTENT_A)).toBe(
      keccak256(stringToBytes(`haven-x402-settlement:${INTENT_A}`)),
    )
  })

  it('a settlement salt can never collide with a budget salt — the domain tags differ', () => {
    const policy = budget()
    expect(settlementSalt(INTENT_A)).not.toBe(delegationSalt(policy))
    // The tags are what does it: even a settlement whose "intent id" were
    // forged to read like a budget salt's suffix lands in a different space.
    expect(
      settlementSalt(`${policy.agentId}:${policy.chainId}:${policy.tokenAddress.toLowerCase()}:open:1`),
    ).not.toBe(delegationSalt(policy))
  })

  it('refuses to build without an intent id rather than silently reverting to a constant salt', () => {
    expect(() => buildSettlementDelegation(req(''))).toThrow(/intent id/)
  })

  it('ON-CHAIN LEAK: the salt does not reveal the intent id, the merchant, or the amount', () => {
    const salt = settlementSalt(INTENT_A) as string
    expect(salt).not.toContain(INTENT_A)
    expect(salt.toLowerCase()).not.toContain(MERCHANT.slice(2).toLowerCase())
    expect(salt.toLowerCase()).not.toContain('186a0') // 100_000 in hex
    // 32 bytes of keccak output over a 122-bit-random preimage: opaque to an
    // observer, and reproducible by anyone holding the intent row.
    expect(salt).toMatch(/^0x[0-9a-f]{64}$/)
  })
})

describe('the on-chain child re-hashes to the stored delegation_hash (#2094 check 8)', () => {
  /**
   * The mechanism `settlement-transfer-verifier.ts` check 8 depends on: the
   * DelegationManager emits the redeemed `Delegation` struct in full, and
   * re-hashing what it emitted must reproduce what authorize stored. If this
   * ever stops holding, check 8 silently degrades to "no decodable log" and
   * the ambiguity guard quietly widens again.
   */
  const DELEGATION_TUPLE =
    'tuple(address delegate,address delegator,bytes32 authority,' +
    'tuple(address enforcer,bytes terms,bytes args)[] caveats,uint256 salt,bytes signature)'

  function roundTrip(child: Record<string, unknown>, signature: string) {
    const c = child as never as {
      delegate: string; delegator: string; authority: string
      caveats: Array<{ enforcer: string; terms: string; args: string }>; salt: string
    }
    const encoded = AbiCoder.defaultAbiCoder().encode(
      [DELEGATION_TUPLE],
      [[c.delegate, c.delegator, c.authority, c.caveats.map((x) => [x.enforcer, x.terms, x.args]), c.salt, signature]],
    )
    const [d] = AbiCoder.defaultAbiCoder().decode([DELEGATION_TUPLE], encoded)
    return hashDelegation({
      delegate: d.delegate,
      delegator: d.delegator,
      authority: d.authority,
      caveats: d.caveats.map((x: { enforcer: string; terms: string; args: string }) => ({
        enforcer: x.enforcer, terms: x.terms, args: x.args,
      })),
      salt: d.salt,
      signature: '0x',
    } as never)
  }

  it('an event-shaped encode/decode of the child reproduces its childHash exactly', () => {
    const built = buildSettlementDelegation(req(INTENT_A))
    expect(roundTrip(built.child as never, `0x${'11'.repeat(65)}`)).toBe(built.childHash)
  })

  it('the signature the merchant supplies does not enter the hash', () => {
    // hashDelegation hashes the EIP-712 struct, which has no signature member.
    // Check 8 would be unusable otherwise: the log carries a signature the
    // backend never saw.
    const built = buildSettlementDelegation(req(INTENT_A))
    expect(roundTrip(built.child as never, `0x${'ff'.repeat(65)}`)).toBe(built.childHash)
    expect(roundTrip(built.child as never, '0x')).toBe(built.childHash)
  })

  it('IN-FLIGHT COMPATIBILITY: a pre-#2094 child (salt 0x00) still re-hashes to its stored hash', () => {
    // An authorization created BEFORE this change and settled after it. Its
    // child carries the old constant salt, and its `delegation_hash` was stored
    // from that child. Check 8 must bind it exactly as it binds a new one —
    // the verifier reads what the chain emits, not what today's builder would
    // build.
    const built = buildSettlementDelegation(req(INTENT_A))
    const legacyChild = { ...(built.child as unknown as Record<string, unknown>), salt: '0x00' }
    const legacyHash = hashDelegation({ ...legacyChild, signature: '0x' } as never)

    expect(legacyHash).not.toBe(built.childHash) // it really is the old child
    expect(roundTrip(legacyChild, `0x${'11'.repeat(65)}`)).toBe(legacyHash)
  })
})
