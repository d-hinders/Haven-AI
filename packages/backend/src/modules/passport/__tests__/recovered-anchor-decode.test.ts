/**
 * #1847 — `recoverAnchorFromReceipt` attributes the recovered attestation
 * from the mined transaction's OWN calldata.
 *
 * The DB half of the fix lives in `rekey-recovered-anchor.test.ts` behind the
 * recovery SEAM; this file proves the real implementation decodes the right
 * addresses out of the right bytes — the wrong index here would write
 * `smartAccount` where `agentEoa` belongs, blind `STALE_ANCHOR_PREDICATE`
 * differently, and no seam-stubbed test would ever notice.
 *
 * The chain is a collaborator this module does not own, so it is mocked
 * (`docs/contributing/testing-strategy.md`), same pattern as
 * `anchor-tx-liveness.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const RELAYER = '0x' + '11'.repeat(20)
const TX = '0x' + 'ab'.repeat(32)
const CHAIN = 84532
const UID = '0x' + 'cd'.repeat(32)
const AGENT_EOA = '0x' + 'aa'.repeat(20)
const SMART_ACCOUNT = '0x' + 'bb'.repeat(20)
const TREASURY = '0x' + 'cc'.repeat(20)

const getTransaction = vi.fn()
const getTransactionReceipt = vi.fn()
const provider = { getTransaction, getTransactionReceipt }

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: RELAYER, provider }) }
})

const { recoverAnchorFromReceipt, buildAttestCall } = await import('../attestation.js')
const { getEasDeployment } = await import('../schema.js')
const { Interface } = await import('ethers')

/** The Attested log exactly as EAS emits it for our schema. */
function attestedLog(recipient: string) {
  const iface = new Interface([
    'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)',
  ])
  const encoded = iface.encodeEventLog('Attested', [
    recipient,
    RELAYER,
    UID,
    process.env.AGENT_PASSPORT_SCHEMA_UID_84532,
  ])
  return {
    address: getEasDeployment(CHAIN).eas,
    topics: encoded.topics,
    data: encoded.data,
  }
}

/** The exact calldata Haven broadcast — built by the one encoding home. */
function attestCalldataFor(agentEoa: string, smartAccount: string): string {
  return buildAttestCall(CHAIN, {
    agentEoa,
    smartAccount,
    treasury: TREASURY,
    assuranceLevel: 0,
    policyUri: 'haven:agent:agt_test',
    issuedAt: 1_700_000_000,
    expiresAt: 0,
  }).data
}

beforeEach(() => {
  process.env.AGENT_PASSPORT_SCHEMA_UID_84532 = '0x' + '1'.repeat(64)
  getTransaction.mockReset().mockResolvedValue(null)
  getTransactionReceipt.mockReset().mockResolvedValue(null)
})

describe('#1847 — recovered anchors are attributed from the transaction bytes', () => {
  it('decodes agentEoa and smartAccount out of the mined attest calldata', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [attestedLog(AGENT_EOA)] })
    getTransaction.mockResolvedValue({ data: attestCalldataFor(AGENT_EOA, SMART_ACCOUNT) })

    const result = await recoverAnchorFromReceipt(CHAIN, TX)
    expect(result).not.toBeNull()
    expect(result?.attestationUid.toLowerCase()).toBe(UID.toLowerCase())
    expect(result?.txHash).toBe(TX)
    // The load-bearing part: position 0 is the EOA, position 1 the smart
    // account — a swap here survives every seam-stubbed test.
    expect(result?.attested.agentEoa.toLowerCase()).toBe(AGENT_EOA.toLowerCase())
    expect(result?.attested.smartAccount.toLowerCase()).toBe(SMART_ACCOUNT.toLowerCase())
  })

  it('THROWS (retryable) when the tx body is unavailable — never attributes from facts the chain does not hold', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [attestedLog(AGENT_EOA)] })
    getTransaction.mockResolvedValue(null)

    await expect(recoverAnchorFromReceipt(CHAIN, TX)).rejects.toThrow(
      /cannot attribute the recovered attestation/,
    )
  })

  it('still returns null for a pending transaction — recovery answers, never guesses (#1745)', async () => {
    getTransactionReceipt.mockResolvedValue(null)
    expect(await recoverAnchorFromReceipt(CHAIN, TX)).toBeNull()
    expect(getTransaction).not.toHaveBeenCalled()
  })

  it('still throws on a mined-but-reverted transaction', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 0, logs: [] })
    await expect(recoverAnchorFromReceipt(CHAIN, TX)).rejects.toThrow(/reverted/)
  })

  it('still throws when the mined tx carries no EAS Attested event (e.g. a lane cancel at the same hash)', async () => {
    getTransactionReceipt.mockResolvedValue({ status: 1, logs: [] })
    await expect(recoverAnchorFromReceipt(CHAIN, TX)).rejects.toThrow(/no EAS Attested event/)
  })
})
