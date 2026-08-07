import { assertRelayerBudget, recordRelayerSpend, finishRelayerSpend, RelayerBudgetExceededError } from '../lib/relayer-spend-guard.js'
import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getChain, isSupportedChain } from '../lib/chains.js'
import { predictSafePasskeySignerAddress } from '../lib/passkey-signer.js'
import { getRelayer, warnIfRelayerLow, withRelayerSendLock } from '../lib/relayer.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  computeSafeTxHash,
  ensurePasskeySignerDeployed,
  getSafeExecContract,
} from '../infra/chain/safe-exec-contract.js'

const HEX_RE = /^0x([0-9a-fA-F]{2})*$/
const DECIMAL_RE = /^\d+$/

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
}

interface StoredPasskeySafeRow {
  public_key_x: Buffer
  public_key_y: Buffer
  signer_address: string
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

    const result = await pool.query<StoredPasskeySafeRow>(
      `SELECT public_key_x, public_key_y, signer_address
       FROM user_passkeys
       WHERE user_id = $1
         AND LOWER(safe_address) = LOWER($2)
         AND chain_id = $3`,
      [sub, body.safe_address, body.chain_id],
    )

    if (result.rows.length === 0) {
      return reply.code(403).send({ error: 'Safe is not associated with the authenticated user' })
    }

    const passkey = result.rows[0]
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
