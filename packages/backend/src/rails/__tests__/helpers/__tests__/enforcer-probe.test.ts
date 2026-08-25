import { describe, expect, it } from 'vitest'
import {
  assertTestnetOnly,
  decideProbeMode,
  erc20TransferExecution,
  PROBE_CHAIN_ID,
  readProbeModeInputs,
  resolveProbeRpcUrl,
  SKIP_ACK_ENV,
  RPC_URL_ENV,
  DEFAULT_PROBE_RPC_URL,
  unreachableMessage,
} from '../enforcer-probe.js'

/**
 * The enforcer probe's POLICY, proven with no network at all (#2004).
 *
 * Deliberate, and the same reasoning as `db-availability.test.ts` (#1763): a
 * guard against "the on-chain proof did not run and nobody noticed" must not
 * itself be a suite that goes quiet when there is no chain. Every branch
 * below — including both failing ones — is asserted here, offline.
 */
describe('decideProbeMode — the four modes', () => {
  it('runs whenever the chain is reachable, CI or not, acknowledged or not', () => {
    for (const ci of [true, false]) {
      for (const acknowledged of [true, false]) {
        expect(decideProbeMode({ reachable: true, ci, acknowledged })).toBe('run')
      }
    }
  })

  it('FAILS in CI when the chain is unreachable — a green CI run that skipped the proof defeats the point', () => {
    expect(decideProbeMode({ reachable: false, ci: true, acknowledged: false })).toBe('fail-ci')
  })

  it('the acknowledgement is powerless in CI — it is a human at a terminal, not an override', () => {
    expect(decideProbeMode({ reachable: false, ci: true, acknowledged: true })).toBe('fail-ci')
  })

  it('fails locally by DEFAULT when unreachable — the absence of a chain is something you say you accept', () => {
    expect(decideProbeMode({ reachable: false, ci: false, acknowledged: false })).toBe(
      'fail-unacknowledged',
    )
  })

  it('narrows the run only on an explicit local acknowledgement', () => {
    expect(decideProbeMode({ reachable: false, ci: false, acknowledged: true })).toBe(
      'skip-acknowledged',
    )
  })
})

describe('environment reads', () => {
  it('reads CI and the acknowledgement from the env', () => {
    expect(readProbeModeInputs({ CI: '1', [SKIP_ACK_ENV]: '1' } as NodeJS.ProcessEnv)).toEqual({
      ci: true,
      acknowledged: true,
    })
    expect(readProbeModeInputs({} as NodeJS.ProcessEnv)).toEqual({
      ci: false,
      acknowledged: false,
    })
  })

  it('only the literal "1" acknowledges — a truthy string is not consent', () => {
    expect(readProbeModeInputs({ [SKIP_ACK_ENV]: 'true' } as NodeJS.ProcessEnv).acknowledged).toBe(
      false,
    )
  })

  it('defaults to the public Base Sepolia endpoint, overridable', () => {
    expect(resolveProbeRpcUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_PROBE_RPC_URL)
    expect(
      resolveProbeRpcUrl({ [RPC_URL_ENV]: 'https://example.test' } as NodeJS.ProcessEnv),
    ).toBe('https://example.test')
  })
})

describe('testnet-only guard', () => {
  it('accepts Base Sepolia', () => {
    expect(() => assertTestnetOnly(PROBE_CHAIN_ID)).not.toThrow()
  })

  it.each([
    ['Ethereum mainnet', 1],
    ['Base mainnet', 8453],
    ['Gnosis', 100],
  ])('REFUSES %s — the probe must never read a chain Haven serves with real money', (_l, id) => {
    expect(() => assertTestnetOnly(id)).toThrow(/testnet-only/)
  })
})

describe('a transport failure never reads as a verdict', () => {
  it('says so in words, on both the CI and the local path', () => {
    for (const ci of [true, false]) {
      const message = unreachableMessage('https://rpc.test', ci)
      expect(message).toContain('TRANSPORT FAILURE, NOT A POLICY FAILURE')
      expect(message).toContain('Red Line #4')
    }
    expect(unreachableMessage('https://rpc.test', false)).toContain(SKIP_ACK_ENV)
    expect(unreachableMessage('https://rpc.test', true)).toContain(RPC_URL_ENV)
  })
})

describe('execution calldata packing', () => {
  const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
  const TO = ('0x' + 'cc'.repeat(20)) as `0x${string}`

  it('packs target(20) || value(32) || transfer calldata(68), and carries the real recipient and amount', () => {
    const packed = erc20TransferExecution(TOKEN, TO, 1_000_000n)
    // 20 + 32 + 4 + 32 + 32 = 120 bytes
    expect((packed.length - 2) / 2).toBe(120)
    expect(packed.slice(2, 42).toLowerCase()).toBe(TOKEN.slice(2).toLowerCase())
    expect(packed.slice(42, 106)).toBe('0'.repeat(64)) // value 0
    expect(packed.toLowerCase()).toContain(TO.slice(2).toLowerCase())
    expect(packed.toLowerCase()).toContain((1_000_000n).toString(16))
  })

  it('a different amount produces different bytes — the packer is not a constant', () => {
    expect(erc20TransferExecution(TOKEN, TO, 1n)).not.toBe(
      erc20TransferExecution(TOKEN, TO, 2n),
    )
  })
})
