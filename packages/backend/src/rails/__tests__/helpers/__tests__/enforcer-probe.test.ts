import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertTestnetOnly,
  EnforcerProbeTransportError,
  probeEnforcer,
  probeReachable,
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

/**
 * Transport-vs-verdict classification, offline (#2004, from `haven-reviewer`).
 *
 * `enforcer-probe.ts`'s own docstring makes this the strongest safety claim in
 * the module: *"the one way a proof like this goes false is by reading an
 * unreachable RPC as 'the enforcer allowed it'."* Until these cases existed
 * that sentence was defended by code review alone. The live suite only ever
 * exercises the two clean shapes — a successful `eth_call` and a revert with
 * an `Error(string)` payload — so every branch that actually decides the
 * question was unreachable in ordinary operation and would have survived being
 * inverted.
 *
 * The load-bearing case is the stripped-`data` rate limit: an endpoint that
 * refuses to serve must read as NEITHER `reverted` NOR `allowed`. Reading it as
 * `allowed` fabricates a breach of Red Line #4; reading it as `reverted`
 * fabricates a proof of it. Both are false greens, in opposite directions.
 */
describe('a transport failure is never mistaken for a verdict (offline)', () => {
  const REQUEST = {
    rpcUrl: 'https://rpc.test',
    enforcer: ('0x' + '11'.repeat(20)) as `0x${string}`,
    terms: '0xdeadbeef' as `0x${string}`,
    executionCallData: '0xfeed' as `0x${string}`,
    delegator: ('0x' + 'aa'.repeat(20)) as `0x${string}`,
    redeemer: ('0x' + 'bb'.repeat(20)) as `0x${string}`,
  }

  function respond(body: unknown, init: { ok?: boolean; status?: number } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: async () => body,
      })),
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('LOAD-BEARING: a rate limit with the revert payload stripped throws — it is neither reverted nor allowed', async () => {
    respond({ error: { message: 'Too Many Requests' } }, { ok: false, status: 429 })
    await expect(probeEnforcer(REQUEST)).rejects.toBeInstanceOf(EnforcerProbeTransportError)
  })

  it('LOAD-BEARING: a rate limit whose body WOULD decode as a revert still throws — the HTTP status wins', async () => {
    // The `!response.ok` branch is otherwise SHADOWED: a stripped rate-limit
    // body also trips the no-payload guard below, so dropping the status check
    // left every assertion green. Found by the mutation surviving. An endpoint
    // under load must not be able to fabricate a Red Line #4 verdict.
    respond(
      { error: { message: 'execution reverted', data: '0x08c379a0' } },
      { ok: false, status: 429 },
    )
    await expect(probeEnforcer(REQUEST)).rejects.toBeInstanceOf(EnforcerProbeTransportError)
  })

  it('an unparseable body (an HTML error page) throws rather than crashing with a parse error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0')
        },
      })),
    )
    await expect(probeEnforcer(REQUEST)).rejects.toBeInstanceOf(EnforcerProbeTransportError)
  })

  it('a JSON-RPC error with no data and no mention of a revert throws rather than guessing', async () => {
    respond({ error: { message: 'header not found' } })
    await expect(probeEnforcer(REQUEST)).rejects.toBeInstanceOf(EnforcerProbeTransportError)
  })

  it('a response carrying neither a result nor an error throws', async () => {
    respond({ jsonrpc: '2.0', id: 1 })
    await expect(probeEnforcer(REQUEST)).rejects.toBeInstanceOf(EnforcerProbeTransportError)
  })

  it('a fetch that throws (DNS, refused, timeout) surfaces as a transport error, not a verdict', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(probeEnforcer(REQUEST)).rejects.toBeInstanceOf(EnforcerProbeTransportError)
  })

  // ── and the two shapes that ARE verdicts, so "throws" is not the only answer ──

  it('POSITIVE CONTROL: a successful eth_call reads as allowed', async () => {
    respond({ result: '0x' })
    await expect(probeEnforcer(REQUEST)).resolves.toEqual({ kind: 'allowed' })
  })

  it('POSITIVE CONTROL: an Error(string) revert payload is decoded to its on-chain reason', async () => {
    // abi.encodeWithSignature("Error(string)",
    //   "ERC20PeriodTransferEnforcer:transfer-amount-exceeded")
    const data =
      '0x08c379a0' +
      '0'.repeat(62) + '20' +
      '0'.repeat(62) + '34' +
      Buffer.from('ERC20PeriodTransferEnforcer:transfer-amount-exceeded', 'utf8')
        .toString('hex')
        .padEnd(128, '0')
    respond({ error: { message: 'execution reverted', data } })
    await expect(probeEnforcer(REQUEST)).resolves.toEqual({
      kind: 'reverted',
      reason: 'ERC20PeriodTransferEnforcer:transfer-amount-exceeded',
    })
  })

  it('an error that SAYS it reverted but carries no payload is still a verdict, not a transport failure', async () => {
    respond({ error: { message: 'execution reverted' } })
    const outcome = await probeEnforcer(REQUEST)
    expect(outcome.kind).toBe('reverted')
  })
})

describe('probeReachable (offline)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('is false when the endpoint cannot be reached — the caller then decides by policy, not by guess', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    await expect(probeReachable('https://rpc.test')).resolves.toBe(false)
  })

  it('is true for Base Sepolia', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: '0x14a34' }) })),
    )
    await expect(probeReachable('https://rpc.test')).resolves.toBe(true)
  })

  it('THROWS rather than returning false when pointed at a real-money chain — a misconfigured RPC must not degrade to a quiet skip', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: '0x2105' }) })),
    )
    await expect(probeReachable('https://rpc.test')).rejects.toThrow(/testnet-only/)
  })
})
