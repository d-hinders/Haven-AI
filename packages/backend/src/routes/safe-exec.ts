import { assertRelayerBudget, recordRelayerSpend, finishRelayerSpend, RelayerBudgetExceededError } from '../infra/relayer-spend-guard.js'
import { FastifyInstance } from 'fastify'
import {
  bindPasskeyToSafe,
  findPasskeyForSafe,
  findUserPasskeyByCredential,
  listPasskeySignersForChain,
  type StoredPasskeySafeRow,
} from '../infra/repositories/user-passkeys.js'
import { authMiddleware } from '../middleware/auth.js'
import { getChain, isSupportedChain } from '../domain/chains.js'
import { getSafeDetails, predictSafePasskeySignerAddress } from '../modules/accounts/index.js'
import { getRelayer, warnIfRelayerLow, withRelayerSendLock } from '../infra/relayer.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  computeSafeTxHash,
  ensurePasskeySignerDeployed,
  getSafeExecContract,
} from '../infra/chain/safe-exec-contract.js'

const HEX_RE = /^0x([0-9a-fA-F]{2})*$/
const DECIMAL_RE = /^\d+$/
// Same shape `POST /passkeys` accepts, so a credential that enrolled can also
// be named here. Kept local rather than shared: the two routes validate the
// same wire format, not a shared domain concept.
const BASE64URL_RE = /^[A-Za-z0-9_-]{1,1024}$/

// The provider estimate has been reliable once the signer contract exists, but
// passkey-backed Safe admin flows still need a little headroom beyond the raw
// estimate. These values were tuned against the live Gnosis passkey smoke tests
// that previously failed with under-gassed relayed execTransaction calls.
const RELAY_EXEC_GAS_BUFFER = 150_000n
// Fallback only when estimateGas itself fails; keep it high enough for module
// enablement + allowance setup + passkey signature verification in one tx.
const RELAY_EXEC_GAS_LIMIT_FALLBACK = 5_000_000n
// Upper bound to avoid accidentally submitting an unbounded relayer tx.
const RELAY_EXEC_GAS_LIMIT_MAX = 8_000_000n

interface ExecSafeBody {
  chain_id: number
  safe_address: string
  to: string
  value: string
  data: string
  operation: 0 | 1
  safe_tx_gas: string
  base_gas: string
  gas_price: string
  gas_token: string
  refund_receiver: string
  nonce: string
  signatures: string
  /**
   * Which of the user's passkeys signed. Optional for compatibility with
   * clients built before a user could hold more than one passkey per chain
   * (#1229) — see `resolveSigningPasskey` for how absence is handled.
   */
  credential_id?: string
}

/** Neither a resolution nor a refusal fits in a return type, so both are modelled. */
type PasskeyResolution =
  | { ok: true; passkey: StoredPasskeySafeRow }
  | { ok: false; status: 400 | 403 | 502; error: string }

/**
 * Which passkey is signing, and may it act for this Safe? (#1229)
 *
 * Two questions, and the second is the one that matters: this route makes
 * Haven's RELAYER pay gas, so it must not relay for a Safe the caller has no
 * relationship with. (The Safe itself still verifies the signature on-chain —
 * a wrong answer here cannot move funds, only waste gas.)
 *
 * Resolution order:
 *  - `credential_id` given → that row, scoped to the authenticated user.
 *  - absent, and the user holds exactly one passkey on the chain → that one.
 *    This is every pre-#1229 client and every user who never added a backup.
 *  - absent and ambiguous → 400 rather than a guess. Picking the oldest row
 *    would silently relay for the wrong signer and fail on-chain with a
 *    signature error that reads like a bug in the passkey, not a missing field.
 *
 * Authorisation, once resolved:
 *  - the row is already bound to this Safe (`safe_address`) → done, no RPC.
 *    This is the onboarding passkey, which is bound at deploy time.
 *  - otherwise the signer must be an on-chain OWNER of the Safe. This is the
 *    backup-signer case: a passkey enrolled later carries no binding until it
 *    is added as an approver. On-chain ownership is the authoritative answer,
 *    so an unbound row is checked rather than refused — and claimed on success
 *    so the next exec takes the fast path even if the approver-add's
 *    best-effort metadata write never landed.
 */
async function resolveSigningPasskey(args: {
  userId: string
  safeAddress: string
  chainId: number
  credentialId?: string
}): Promise<PasskeyResolution> {
  const { userId, safeAddress, chainId, credentialId } = args

  let passkey: StoredPasskeySafeRow | null
  if (typeof credentialId === 'string' && credentialId.length > 0) {
    passkey = await findUserPasskeyByCredential(userId, chainId, credentialId)
  } else {
    const bound = await findPasskeyForSafe(userId, safeAddress, chainId)
    if (bound) {
      return { ok: true, passkey: bound }
    }
    const candidates = await listPasskeySignersForChain(userId, chainId)
    if (candidates.length > 1) {
      return {
        ok: false,
        status: 400,
        error: 'credential_id is required when the account has more than one passkey on this chain',
      }
    }
    passkey = candidates[0] ?? null
  }

  if (passkey === null) {
    return { ok: false, status: 403, error: 'Safe is not associated with the authenticated user' }
  }

  if (passkey.safe_address && passkey.safe_address.toLowerCase() === safeAddress.toLowerCase()) {
    return { ok: true, passkey }
  }

  let owners: string[]
  try {
    ;({ owners } = await getSafeDetails(safeAddress, chainId))
  } catch {
    return { ok: false, status: 502, error: 'Could not read owners from the network. Try again.' }
  }

  const isOwner = owners.some((o) => o.toLowerCase() === passkey.signer_address.toLowerCase())
  if (!isOwner) {
    return { ok: false, status: 403, error: 'Safe is not associated with the authenticated user' }
  }

  // Fast-path hint for next time; a no-op when the row is bound elsewhere.
  await bindPasskeyToSafe(userId, passkey.credential_id, safeAddress)

  return { ok: true, passkey }
}

function parseHexCoordinate(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}` as `0x${string}`
}

function isInsufficientFundsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('insufficient funds')
}

function isValidDecimal(value: string): boolean {
  return DECIMAL_RE.test(value)
}

function isBase64Url(value: unknown): value is string {
  return typeof value === 'string' && BASE64URL_RE.test(value)
}

function getRelayExecGasLimit(estimatedGas: bigint | null): bigint {
  if (estimatedGas === null) {
    return RELAY_EXEC_GAS_LIMIT_FALLBACK
  }

  const buffered = estimatedGas + RELAY_EXEC_GAS_BUFFER
  return buffered > RELAY_EXEC_GAS_LIMIT_MAX ? RELAY_EXEC_GAS_LIMIT_MAX : buffered
}

export default async function safeExecRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.post<{ Body: ExecSafeBody }>('/exec', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const body = request.body ?? {} as ExecSafeBody

    if (!isSupportedChain(body.chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${body.chain_id}` })
    }

    if (
      !isValidAddress(body.safe_address) ||
      !isValidAddress(body.to) ||
      !isValidAddress(body.gas_token) ||
      !isValidAddress(body.refund_receiver)
    ) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    if (!HEX_RE.test(body.data) || !HEX_RE.test(body.signatures)) {
      return reply.code(400).send({ error: 'data and signatures must be 0x-prefixed hex strings' })
    }

    if (body.operation !== 0 && body.operation !== 1) {
      return reply.code(400).send({ error: 'operation must be 0 or 1' })
    }

    if (
      !isValidDecimal(body.value) ||
      !isValidDecimal(body.safe_tx_gas) ||
      !isValidDecimal(body.base_gas) ||
      !isValidDecimal(body.gas_price) ||
      !isValidDecimal(body.nonce)
    ) {
      return reply.code(400).send({ error: 'Numeric fields must be decimal strings' })
    }

    if (body.credential_id !== undefined && !isBase64Url(body.credential_id)) {
      return reply.code(400).send({ error: 'credential_id must be a non-empty base64url string' })
    }

    // Which passkey signed, and may it act for this Safe (#1229, #999).
    const resolved = await resolveSigningPasskey({
      userId: sub,
      safeAddress: body.safe_address,
      chainId: body.chain_id,
      credentialId: body.credential_id,
    })

    if (!resolved.ok) {
      return reply.code(resolved.status).send({ error: resolved.error })
    }
    const passkey = resolved.passkey
    const chain = getChain(body.chain_id)
    const x = parseHexCoordinate(passkey.public_key_x)
    const y = parseHexCoordinate(passkey.public_key_y)
    const expectedSignerAddress = predictSafePasskeySignerAddress({
      x,
      y,
      chainId: body.chain_id,
    })

    if (expectedSignerAddress.toLowerCase() !== passkey.signer_address.toLowerCase()) {
      request.log.error({ userId: sub, chainId: body.chain_id }, 'Stored passkey signer mismatch')
      return reply.code(500).send({ error: 'Internal server error' })
    }

    try {
      // #717: exec budget per user, checked before the relayer signs.
      await assertRelayerBudget('safe_exec', { userId: sub })
      await warnIfRelayerLow(body.chain_id)
      const relayer = getRelayer(body.chain_id)
      await ensurePasskeySignerDeployed({
        chainId: body.chain_id,
        relayer,
        factoryAddress: chain.passkey.factoryAddress,
        signerAddress: expectedSignerAddress,
        x,
        y,
        verifierAddress: chain.passkey.verifier,
      })
      const safe = getSafeExecContract(body.safe_address, relayer)

      const execArgs = [
        body.to,
        BigInt(body.value),
        body.data,
        body.operation,
        BigInt(body.safe_tx_gas),
        BigInt(body.base_gas),
        BigInt(body.gas_price),
        body.gas_token,
        body.refund_receiver,
        body.signatures,
      ] as const
      const currentNonce = await safe.nonce()
      const requestedNonce = BigInt(body.nonce)
      if (currentNonce !== requestedNonce) {
        request.log.warn(
          {
            userId: sub,
            chainId: body.chain_id,
            safeAddress: body.safe_address,
            requestedNonce: requestedNonce.toString(),
            currentNonce: currentNonce.toString(),
          },
          'Safe execution request used a stale nonce',
        )
        return reply.code(409).send({ error: 'Safe nonce changed; refresh and try again' })
      }

      const safeTxHash = computeSafeTxHash(body)
      const txHashData = await safe.encodeTransactionData(
        body.to,
        BigInt(body.value),
        body.data,
        body.operation,
        BigInt(body.safe_tx_gas),
        BigInt(body.base_gas),
        BigInt(body.gas_price),
        body.gas_token,
        body.refund_receiver,
        requestedNonce,
      )

      try {
        await safe.checkSignatures(safeTxHash, txHashData, body.signatures)
      } catch (error) {
        request.log.error(
          {
            err: error,
            userId: sub,
            chainId: body.chain_id,
            safeAddress: body.safe_address,
            safeTxHash,
            requestedNonce: requestedNonce.toString(),
          },
          'Safe rejected the full signature package before execution',
        )
        return reply.code(502).send({ error: 'Safe rejected the signed transaction payload' })
      }

      // Validate the execution path without spending relayer gas. This catches
      // invalid signatures or failing Safe inner transactions before we submit.
      await safe.execTransaction.staticCall(...execArgs)

      let estimatedGas: bigint | null = null
      try {
        estimatedGas = await safe.execTransaction.estimateGas(...execArgs)
      } catch (error) {
        request.log.warn(
          { err: error, userId: sub, chainId: body.chain_id, safeAddress: body.safe_address },
          'Safe execution gas estimation failed; falling back to a conservative gas limit',
        )
      }

      // Contract-signature validation plus module setup calls can be expensive.
      // Use the provider estimate when available, otherwise fall back to a high
      // explicit gas limit so relayed batched admin flows don't under-gas.
      // Broadcast under the per-chain send lock so the exec can't race another
      // relayer submission for the same EOA nonce (#692/#718).
      // #717: attempt row BEFORE broadcast; the signer-deploy tx above shares
      // the cap but is not gas-itemised (known attribution undercount).
      const spendId = await recordRelayerSpend({ operation: 'safe_exec', chainId: body.chain_id, userId: sub })
      const tx = await withRelayerSendLock(body.chain_id, () =>
        safe.execTransaction(...execArgs, {
          gasLimit: getRelayExecGasLimit(estimatedGas),
        }),
      )
      type GasReceipt = { gasUsed?: { toString(): string }; gasPrice?: { toString(): string } }
      let execReceipt: GasReceipt | null = null
      try {
        execReceipt = (await tx.wait()) as unknown as GasReceipt | null
      } finally {
        await finishRelayerSpend(spendId, {
          txHash: tx.hash,
          gasUsed: execReceipt?.gasUsed != null ? BigInt(execReceipt.gasUsed.toString()) : null,
          effectiveGasPrice: execReceipt?.gasPrice != null ? BigInt(execReceipt.gasPrice.toString()) : null,
        })
      }

      return reply.code(201).send({
        tx_hash: tx.hash,
        chain_id: body.chain_id,
      })
    } catch (error) {
      if (error instanceof RelayerBudgetExceededError) {
        return reply.code(429).send({ error: error.message })
      }
      if (isInsufficientFundsError(error)) {
        return reply.code(503).send({ error: 'Relayer is temporarily unfunded; please try again later' })
      }

      request.log.error(
        { err: error, userId: sub, chainId: body.chain_id, safeAddress: body.safe_address },
        'Safe execution reverted on-chain',
      )
      return reply.code(502).send({ error: 'Safe execution reverted on-chain' })
    }
  })
}
