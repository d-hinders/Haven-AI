import { FastifyInstance } from 'fastify'
import { Contract } from 'ethers'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isSupportedChain } from '../lib/chains.js'
import { predictSafePasskeySignerAddress } from '../lib/passkey-signer.js'
import { getRelayer, warnIfRelayerLow } from '../lib/relayer.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/
const DECIMAL_RE = /^\d+$/

const SAFE_EXEC_ABI = [
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
] as const

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

interface SafeContract {
  execTransaction(
    to: string,
    value: bigint,
    data: string,
    operation: number,
    safeTxGas: bigint,
    baseGas: bigint,
    gasPrice: bigint,
    gasToken: string,
    refundReceiver: string,
    signatures: string,
  ): Promise<{
    hash: string
    wait(): Promise<unknown>
  }>
}

function parseHexCoordinate(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}` as `0x${string}`
}

function isInsufficientFundsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('insufficient funds')
}

function isValidAddress(value: string): boolean {
  return ETH_ADDRESS_RE.test(value)
}

function isValidDecimal(value: string): boolean {
  return DECIMAL_RE.test(value)
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
    const expectedSignerAddress = predictSafePasskeySignerAddress({
      x: parseHexCoordinate(passkey.public_key_x),
      y: parseHexCoordinate(passkey.public_key_y),
      chainId: body.chain_id,
    })

    if (expectedSignerAddress.toLowerCase() !== passkey.signer_address.toLowerCase()) {
      request.log.error({ userId: sub, chainId: body.chain_id }, 'Stored passkey signer mismatch')
      return reply.code(500).send({ error: 'Internal server error' })
    }

    try {
      await warnIfRelayerLow(body.chain_id)
      const relayer = getRelayer(body.chain_id)
      const safe = new Contract(
        body.safe_address,
        SAFE_EXEC_ABI,
        relayer,
      ) as unknown as SafeContract

      const tx = await safe.execTransaction(
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
      )
      await tx.wait()

      return reply.code(201).send({
        tx_hash: tx.hash,
        chain_id: body.chain_id,
      })
    } catch (error) {
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
