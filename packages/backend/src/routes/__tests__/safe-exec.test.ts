import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FastifyInstance } from 'fastify'

const {
  mockQuery,
  mockGetRelayer,
  mockWarnIfRelayerLow,
  mockExecTransaction,
  mockExecTransactionStaticCall,
  mockExecTransactionEstimateGas,
  mockSafeNonce,
  mockSafeEncodeTransactionData,
  mockSafeCheckSignatures,
  mockCreateSigner,
  mockContractConstructor,
  mockGetSafeDetails,
} = vi.hoisted(() => {
  const execTransaction = vi.fn()
  const execTransactionStaticCall = vi.fn()
  const execTransactionEstimateGas = vi.fn()
  const safeNonce = vi.fn()
  const safeEncodeTransactionData = vi.fn()
  const safeCheckSignatures = vi.fn()
  const createSigner = vi.fn()
  Object.assign(execTransaction, {
    staticCall: execTransactionStaticCall,
    estimateGas: execTransactionEstimateGas,
  })
  return {
    mockQuery: vi.fn(),
    mockGetRelayer: vi.fn(),
    mockWarnIfRelayerLow: vi.fn(),
    mockExecTransaction: execTransaction,
    mockExecTransactionStaticCall: execTransactionStaticCall,
    mockExecTransactionEstimateGas: execTransactionEstimateGas,
    mockSafeNonce: safeNonce,
    mockSafeEncodeTransactionData: safeEncodeTransactionData,
    mockSafeCheckSignatures: safeCheckSignatures,
    mockCreateSigner: createSigner,
    mockGetSafeDetails: vi.fn(),
    mockContractConstructor: vi.fn((address: string, abi: unknown) => {
      if (Array.isArray(abi) && abi.some((item) => String(item).includes('createSigner(uint256 x, uint256 y, uint176 verifiers)'))) {
        return {
          createSigner,
        }
      }

      return {
        nonce: safeNonce,
        encodeTransactionData: safeEncodeTransactionData,
        checkSignatures: safeCheckSignatures,
        execTransaction,
      }
    }),
  }
})

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../infra/relayer.js', () => ({
  getRelayer: (...args: unknown[]) => mockGetRelayer(...args),
  warnIfRelayerLow: (...args: unknown[]) => mockWarnIfRelayerLow(...args),
  // Pass-through: the per-chain send serialisation is covered by
  // lib/relayer.test.ts; route tests only care that the submit runs.
  withRelayerSendLock: (_chainId: number, fn: () => Promise<unknown>) => fn(),
}))

// Only the owner read is faked — `predictSafePasskeySignerAddress` stays real,
// because the route's signer-mismatch guard is meaningless against a stub.
vi.mock('../../modules/accounts/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../modules/accounts/index.js')>(
    '../../modules/accounts/index.js',
  )
  return {
    ...actual,
    getSafeDetails: (...args: unknown[]) => mockGetSafeDetails(...args),
  }
})

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  return {
    ...actual,
    Contract: mockContractConstructor,
  }
})

import { buildApp } from '../../__tests__/helpers.js'
import { SAFE_EXEC_CONFIRM_TIMEOUT_MS } from '../safe-exec.js'
import { PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS } from '../../infra/chain/safe-proxy-deployer.js'
import { STALE_BROADCAST_SECONDS } from '../../infra/outbound-bump-worker.js'

describe('Safe exec routes', () => {
  let app: FastifyInstance
  const signerAddress = '0x0802e96a6dd7e1dd80620cf5d759d41b714c0ce2'

  function buildPasskeyContractSignature(ownerAddress: string, innerSignature: string): string {
    const ownerWord = ownerAddress.toLowerCase().slice(2).padStart(64, '0')
    const offsetWord = '41'.padStart(64, '0')
    const typeByte = '00'
    const innerHex = innerSignature.startsWith('0x') ? innerSignature.slice(2) : innerSignature
    const lengthWord = (innerHex.length / 2).toString(16).padStart(64, '0')
    return `0x${ownerWord}${offsetWord}${typeByte}${lengthWord}${innerHex}`
  }

  const validBody = {
    chain_id: 100,
    safe_address: '0x07058311f995c89F4DbE17Db61fa1A3CDe638975',
    to: '0x1111111111111111111111111111111111111111',
    value: '0',
    data: '0x',
    operation: 0 as const,
    safe_tx_gas: '0',
    base_gas: '0',
    gas_price: '0',
    gas_token: '0x0000000000000000000000000000000000000000',
    refund_receiver: '0x0000000000000000000000000000000000000000',
    nonce: '1',
    signatures: buildPasskeyContractSignature(signerAddress, '0x1234'),
  }

  beforeAll(async () => {
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockGetRelayer.mockReset()
    mockWarnIfRelayerLow.mockReset()
    mockExecTransaction.mockReset()
    mockExecTransactionStaticCall.mockReset()
    mockExecTransactionEstimateGas.mockReset()
    mockSafeNonce.mockReset()
    mockSafeEncodeTransactionData.mockReset()
    mockSafeCheckSignatures.mockReset()
    mockCreateSigner.mockReset()
    mockContractConstructor.mockClear()
    mockGetSafeDetails.mockReset()

    mockGetRelayer.mockReturnValue({
      address: '0xrelayer',
      provider: {
        getCode: vi.fn().mockResolvedValue('0x1234'),
      },
    })
    mockWarnIfRelayerLow.mockResolvedValue(undefined)
    mockSafeNonce.mockResolvedValue(1n)
    mockSafeEncodeTransactionData.mockResolvedValue('0xdeadbeef')
    mockSafeCheckSignatures.mockResolvedValue(undefined)
    mockExecTransactionStaticCall.mockResolvedValue(true)
    mockExecTransactionEstimateGas.mockResolvedValue(1_900_000n)
    mockCreateSigner.mockResolvedValue({
      hash: '0xsignertx',
      wait: vi.fn().mockResolvedValue({}),
    })
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  /**
   * Answer the route's passkey queries by WHAT they ask rather than by call
   * order. The positional chain is the failure mode the #1227 ratchet exists
   * to shrink: adding one query to the handler re-shuffles every test that
   * mocked the old sequence. The queries themselves are proven against real
   * Postgres in `infra/repositories/__tests__/user-passkeys.test.ts`; what
   * these route tests own is the DECISION taken on the result.
   */
  function stubPasskeyQueries(rows: {
    /** FIND_PASSKEY_FOR_SAFE — the Safe-bound row. */
    bound?: unknown[]
    /** FIND_PASSKEY_BY_CREDENTIAL — the named credential. */
    byCredential?: unknown[]
    /** LIST_PASSKEY_SIGNERS_FOR_CHAIN — every passkey on the chain. */
    forChain?: unknown[]
  }): void {
    mockQuery.mockImplementation(async (sql: unknown) => {
      const text = String(sql)
      if (/UPDATE user_passkeys/.test(text)) return { rowCount: 1, rows: [] }
      if (/credential_id = \$3/.test(text)) return { rows: rows.byCredential ?? [] }
      if (/LOWER\(safe_address\)/.test(text)) return { rows: rows.bound ?? [] }
      if (/FROM user_passkeys/.test(text)) return { rows: rows.forChain ?? [] }
      // Everything else on this route is the relayer spend guard, which is
      // fail-open by design and covered by its own tests.
      return { rowCount: 0, rows: [] }
    })
  }

  /** The params the route passed to its Safe-binding UPDATE, if it ran. */
  function bindCallParams(): unknown[] | null {
    const call = mockQuery.mock.calls.find(([sql]) => /UPDATE user_passkeys/.test(String(sql)))
    return call ? (call[1] as unknown[]) : null
  }

  it('POST /safe/exec relays Safe execution', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockExecTransaction.mockResolvedValueOnce({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({
      tx_hash: '0xtxhash',
      chain_id: 100,
      // #1754: explicit discriminator, so a client branches on one field
      // rather than on the HTTP status. Additive — `tx_hash`/`chain_id` are
      // byte-identical to what this route answered before.
      status: 'confirmed',
    })
    expect(mockWarnIfRelayerLow).toHaveBeenCalledWith(100)
    expect(mockGetRelayer).toHaveBeenCalledWith(100)
    expect(mockCreateSigner).not.toHaveBeenCalled()
    expect(mockSafeCheckSignatures).toHaveBeenCalledWith(
      expect.any(String),
      '0xdeadbeef',
      validBody.signatures,
    )
    expect(mockExecTransactionStaticCall).toHaveBeenCalledWith(
      validBody.to,
      0n,
      '0x',
      0,
      0n,
      0n,
      0n,
      validBody.gas_token,
      validBody.refund_receiver,
      validBody.signatures,
    )
    expect(mockExecTransaction).toHaveBeenCalledWith(
      validBody.to,
      0n,
      '0x',
      0,
      0n,
      0n,
      0n,
      validBody.gas_token,
      validBody.refund_receiver,
      validBody.signatures,
      { gasLimit: 2_050_000n },
    )
  })

  it('POST /safe/exec returns 403 for an unrelated Safe', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // No Safe binding, and no passkey on the chain either (#1229 looks at the
    // whole set before refusing).
    stubPasskeyQueries({})

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('Safe is not associated with the authenticated user')
  })

  it('POST /safe/exec returns 503 when the relayer is unfunded', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockExecTransaction.mockRejectedValueOnce(new Error('insufficient funds for intrinsic transaction cost'))

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(503)
    expect(response.json().error).toBe('Relayer is temporarily unfunded; please try again later')
  })

  it('POST /safe/exec returns 502 on generic revert without leaking the revert code', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockExecTransactionStaticCall.mockRejectedValueOnce(new Error('execution reverted: GS013'))

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Safe execution reverted on-chain')
    expect(JSON.stringify(response.json())).not.toContain('GS013')
  })

  it('POST /safe/exec returns 409 when the Safe nonce is stale', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockSafeNonce.mockResolvedValueOnce(2n)

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Safe nonce changed; refresh and try again')
    expect(mockExecTransactionStaticCall).not.toHaveBeenCalled()
  })

  it('POST /safe/exec returns a specific error when Safe rejects the full signature payload', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockSafeCheckSignatures.mockRejectedValueOnce(new Error('execution reverted: GS024'))

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Safe rejected the signed transaction payload')
    expect(mockExecTransactionStaticCall).not.toHaveBeenCalled()
  })

  it('POST /safe/exec falls back to a conservative gas limit when estimation fails', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockExecTransactionEstimateGas.mockRejectedValueOnce(new Error('estimate failed'))
    mockExecTransaction.mockResolvedValueOnce({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(201)
    expect(mockExecTransaction).toHaveBeenCalledWith(
      validBody.to,
      0n,
      '0x',
      0,
      0n,
      0n,
      0n,
      validBody.gas_token,
      validBody.refund_receiver,
      validBody.signatures,
      { gasLimit: 5_000_000n },
    )
  })

  it('POST /safe/exec auto-deploys the passkey signer if the deterministic signer address has no code', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        public_key_x: Buffer.from('11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff', 'hex'),
        public_key_y: Buffer.from('ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100', 'hex'),
        signer_address: signerAddress,
      }],
    })
    mockGetRelayer.mockReturnValue({
      address: '0xrelayer',
      provider: {
        getCode: vi.fn().mockResolvedValueOnce('0x'),
      },
    })
    mockExecTransaction.mockResolvedValueOnce({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(201)
    expect(mockCreateSigner).toHaveBeenCalledWith(
      BigInt('0x11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff'),
      BigInt('0xffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100'),
      BigInt('0x445a0683e494ea0c5af3e83c5159fbe47cf9e765'),
    )
  })

  // ── Confirmation-wait boundedness: timeout vs revert (#1754, #1755) ──
  //
  // The premise, verified against ethers 6.16.0 rather than assumed:
  // `TransactionResponse.wait(_confirms, _timeout)` computes
  // `timeout = (_timeout == null) ? 0 : _timeout` and only arms the rejecting
  // timer `if (timeout > 0)`. So the pre-#1754 bare `tx.wait()` could not
  // reject with TIMEOUT at all — the timeout case did not exist to be
  // mis-mapped; the wait simply never returned. A revert is separately
  // distinguishable (`CALL_EXCEPTION`), but nothing branched on it: the outer
  // catch answered `502 "Safe execution reverted on-chain"` for every
  // rejection. These tests pin BOTH halves — the new pending answer AND the
  // unchanged revert answer — because a test that only exercises one proves
  // nothing about the distinction.

  /** What ethers v6 rejects a timed-out `wait()` with. */
  function waitTimeoutError(): Error {
    const err = new Error('wait for transaction timeout')
    ;(err as unknown as { code: string }).code = 'TIMEOUT'
    return err
  }

  /** What ethers v6 rejects a mined-and-reverted `wait()` with. */
  function callExceptionError(): Error {
    const err = new Error('transaction execution reverted')
    ;(err as unknown as { code: string }).code = 'CALL_EXCEPTION'
    return err
  }

  /**
   * The Safe-bound onboarding passkey, answered by WHAT the route asks rather
   * than by call order — the #1227 ratchet's rule. These tests own the
   * DECISION taken after the wait, not the queries.
   */
  function stubSingleOwnerPasskey(): void {
    stubPasskeyQueries({
      bound: [{
        public_key_x: Buffer.from(
          '11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff',
          'hex',
        ),
        public_key_y: Buffer.from(
          'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
          'hex',
        ),
        signer_address: signerAddress,
      }],
    })
  }

  function execRequest(token: string) {
    return app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })
  }

  it('POST /safe/exec bounds the confirmation wait instead of waiting indefinitely', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubSingleOwnerPasskey()
    const wait = vi.fn().mockResolvedValue({})
    mockExecTransaction.mockResolvedValue({ hash: '0xtxhash', wait })

    const response = await execRequest(token)

    expect(response.statusCode).toBe(201)
    // The whole defect starts here: no second argument means no deadline.
    expect(wait.mock.calls).toEqual([[1, SAFE_EXEC_CONFIRM_TIMEOUT_MS]])
  })

  it('POST /safe/exec reports a confirmation TIMEOUT as pending, not as a revert', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubSingleOwnerPasskey()
    mockExecTransaction.mockResolvedValue({
      hash: '0xpendinghash',
      wait: vi.fn().mockRejectedValue(waitTimeoutError()),
    })

    const response = await execRequest(token)

    expect(response.statusCode).toBe(202)
    const body = response.json()
    expect(body.status).toBe('pending')
    // The hash is the whole hand-off: nothing else on this path can reconcile
    // the submission, so the caller must leave with it.
    expect(body.tx_hash).toBe('0xpendinghash')
    expect(body.chain_id).toBe(100)
    // The named assertion this issue exists for: the user must NOT be told
    // their transaction reverted when it may still confirm.
    expect(JSON.stringify(body).toLowerCase()).not.toContain('revert')
    expect(body.error).toContain('has not confirmed yet')
  })

  it('POST /safe/exec reports a null receipt as pending too (#690 lagging RPC)', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubSingleOwnerPasskey()
    mockExecTransaction.mockResolvedValue({
      hash: '0xnullreceipt',
      wait: vi.fn().mockResolvedValue(null),
    })

    const response = await execRequest(token)

    expect(response.statusCode).toBe(202)
    expect(response.json().status).toBe('pending')
    expect(response.json().tx_hash).toBe('0xnullreceipt')
  })

  it('POST /safe/exec still reports a real on-chain revert as 502 reverted', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubSingleOwnerPasskey()
    mockExecTransaction.mockResolvedValue({
      hash: '0xreverthash',
      wait: vi.fn().mockRejectedValue(callExceptionError()),
    })

    const response = await execRequest(token)

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Safe execution reverted on-chain')
    expect(response.json().status).toBeUndefined()
  })

  it('POST /safe/exec does not widen the timeout branch to any other wait failure', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubSingleOwnerPasskey()
    const replaced = new Error('transaction was replaced')
    ;(replaced as unknown as { code: string }).code = 'TRANSACTION_REPLACED'
    mockExecTransaction.mockResolvedValue({
      hash: '0xreplaced',
      wait: vi.fn().mockRejectedValue(replaced),
    })

    const response = await execRequest(token)

    // Not a timeout. Deliberately unchanged behaviour — this guards
    // `isWaitTimeout` against being widened into "never fail anything".
    expect(response.statusCode).toBe(502)
  })

  it('POST /safe/exec reports an unconfirmed passkey signer deploy as 504, not a revert (#1755)', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubSingleOwnerPasskey()
    mockGetRelayer.mockReturnValue({
      address: '0xrelayer',
      provider: { getCode: vi.fn().mockResolvedValue('0x') },
    })
    const signerWait = vi.fn().mockRejectedValue(waitTimeoutError())
    mockCreateSigner.mockResolvedValue({ hash: '0xsignerpending', wait: signerWait })

    const response = await execRequest(token)

    // The helper's own wait must carry a deadline; a bare `wait()` in ethers
    // v6 arms no timer and so can never produce the TIMEOUT this branch maps.
    expect(signerWait.mock.calls).toEqual([[1, PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS]])
    expect(response.statusCode).toBe(504)
    const body = response.json()
    expect(body.status).toBe('signer_deploy_pending')
    expect(body.signer_deploy_tx_hash).toBe('0xsignerpending')
    // The asymmetry that makes this a different answer from the 202: the
    // prerequisite did not confirm, so the user's Safe transaction was never
    // broadcast. Nothing of theirs is in flight.
    expect(mockExecTransaction).not.toHaveBeenCalled()
    expect(body.error).toContain('NOT submitted')
    expect(JSON.stringify(body).toLowerCase()).not.toContain('revert')
  })

  it('POST /safe/exec still reports a reverted passkey signer deploy as 502 (#1755)', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubSingleOwnerPasskey()
    mockGetRelayer.mockReturnValue({
      address: '0xrelayer',
      provider: { getCode: vi.fn().mockResolvedValue('0x') },
    })
    mockCreateSigner.mockResolvedValue({
      hash: '0xsignerrevert',
      wait: vi.fn().mockRejectedValue(callExceptionError()),
    })

    const response = await execRequest(token)

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Safe execution reverted on-chain')
  })

  it('the exec and signer-deploy deadlines both sit under the bump worker stale threshold', () => {
    expect(SAFE_EXEC_CONFIRM_TIMEOUT_MS).toBeLessThan(STALE_BROADCAST_SECONDS * 1_000)
    expect(PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS).toBeLessThan(STALE_BROADCAST_SECONDS * 1_000)
    // One user action, three legs (relayed exec, its prerequisite deploy, and
    // the frontend's own direct-signing wait in `lib/safe-tx.ts`). They must
    // not disagree about how long "not yet confirmed" takes.
    expect(PASSKEY_SIGNER_DEPLOY_CONFIRM_TIMEOUT_MS).toBe(SAFE_EXEC_CONFIRM_TIMEOUT_MS)
  })

  // ── Multi-passkey resolution (#1229) ──────────────────────────────────

  const passkeyKeys = {
    public_key_x: Buffer.from(
      '11223344556677889900aabbccddeeff00112233445566778899aabbccddeeff',
      'hex',
    ),
    public_key_y: Buffer.from(
      'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
      'hex',
    ),
    signer_address: signerAddress,
  }

  it('POST /safe/exec resolves the named credential without an owner read', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // The row is already bound to this Safe — the onboarding passkey. No RPC.
    stubPasskeyQueries({
      byCredential: [
        { ...passkeyKeys, credential_id: 'cred-primary', safe_address: validBody.safe_address },
      ],
    })
    mockExecTransaction.mockResolvedValue({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'cred-primary' },
    })

    expect(response.statusCode).toBe(201)
    expect(mockGetSafeDetails).not.toHaveBeenCalled()
    expect(bindCallParams()).toBeNull()
  })

  it('POST /safe/exec authorises an unbound backup passkey that owns the Safe', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // A backup enrolled later carries no Safe binding. On-chain ownership is
    // the authoritative answer, and the row is claimed on the way through so
    // the next exec skips the read.
    stubPasskeyQueries({
      byCredential: [{ ...passkeyKeys, credential_id: 'cred-backup', safe_address: null }],
    })
    mockGetSafeDetails.mockResolvedValue({
      owners: ['0xSomeoneElse', signerAddress],
      threshold: 1,
      nonce: 1,
    })
    mockExecTransaction.mockResolvedValue({
      hash: '0xtxhash',
      wait: vi.fn().mockResolvedValue({}),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'cred-backup' },
    })

    expect(response.statusCode).toBe(201)
    expect(mockGetSafeDetails).toHaveBeenCalledWith(validBody.safe_address, 100)
    expect(bindCallParams()).toEqual(['user-1', 'cred-backup', validBody.safe_address])
  })

  it('POST /safe/exec returns 403 when the passkey does not own the Safe', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    stubPasskeyQueries({
      byCredential: [{ ...passkeyKeys, credential_id: 'cred-backup', safe_address: null }],
    })
    mockGetSafeDetails.mockResolvedValue({
      owners: ['0xSomeoneElse'],
      threshold: 1,
      nonce: 1,
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'cred-backup' },
    })

    expect(response.statusCode).toBe(403)
    expect(mockExecTransaction).not.toHaveBeenCalled()
  })

  it('POST /safe/exec refuses to guess when the chain holds several passkeys', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    // Nothing bound to this Safe, two candidates: relaying for the wrong one
    // would fail on-chain with a signature error that reads like a broken
    // passkey, so ask instead.
    stubPasskeyQueries({
      forChain: [
        { ...passkeyKeys, credential_id: 'cred-primary', safe_address: null },
        { ...passkeyKeys, credential_id: 'cred-backup', safe_address: null },
      ],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toContain('credential_id is required')
    expect(mockExecTransaction).not.toHaveBeenCalled()
  })

  it('POST /safe/exec rejects a malformed credential_id', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, credential_id: 'not base64url!' },
    })

    expect(response.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('POST /safe/exec requires auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/safe/exec',
      payload: validBody,
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Unauthorized')
  })
})
