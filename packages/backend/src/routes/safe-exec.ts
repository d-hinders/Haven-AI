import { FastifyInstance } from 'fastify'
import { Contract, TypedDataEncoder } from 'ethers'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getChain, isSupportedChain } from '../lib/chains.js'
import { predictSafePasskeySignerAddress } from '../lib/passkey-signer.js'
import { getRelayer, warnIfRelayerLow } from '../lib/relayer.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/
const DECIMAL_RE = /^\d+$/

const SAFE_EXEC_ABI = [
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'function nonce() view returns (uint256)',
  'function encodeTransactionData(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes)',
  'function checkSignatures(bytes32 dataHash,bytes data,bytes signatures) view',
] as const
const ERC1271_ABI = [
  'function isValidSignature(bytes32,bytes) view returns (bytes4)',
] as const
const PASSKEY_SIGNER_FACTORY_ABI = [
  'function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address signer)',
] as const

const ERC1271_MAGIC_VALUE = '0x1626ba7e'

const RELAY_EXEC_GAS_BUFFER = 150_000n
const RELAY_EXEC_GAS_LIMIT_FALLBACK = 5_000_000n
const RELAY_EXEC_GAS_LIMIT_MAX = 8_000_000n
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
}

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
  nonce(): Promise<bigint>
  encodeTransactionData(
    to: string,
    value: bigint,
    data: string,
    operation: number,
    safeTxGas: bigint,
    baseGas: bigint,
    gasPrice: bigint,
    gasToken: string,
    refundReceiver: string,
    nonce: bigint,
  ): Promise<string>
  checkSignatures(dataHash: string, data: string, signatures: string): Promise<void>
  execTransaction: {
    (
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
      overrides?: { gasLimit?: bigint },
    ): Promise<{
      hash: string
      wait(): Promise<unknown>
    }>
    staticCall(
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
    ): Promise<boolean>
    estimateGas(
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
    ): Promise<bigint>
  }
}

interface SignatureValidatorContract {
  isValidSignature(message: string, signature: string): Promise<string>
}

interface PasskeySignerFactoryContract {
  createSigner(x: bigint, y: bigint, verifiers: bigint): Promise<{
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

function computeSafeTxHash(body: ExecSafeBody): string {
  return TypedDataEncoder.hash(
    {
      chainId: body.chain_id,
      verifyingContract: body.safe_address,
    },
    SAFE_TX_TYPES,
    {
      to: body.to,
      value: BigInt(body.value),
      data: body.data,
      operation: body.operation,
      safeTxGas: BigInt(body.safe_tx_gas),
      baseGas: BigInt(body.base_gas),
      gasPrice: BigInt(body.gas_price),
      gasToken: body.gas_token,
      refundReceiver: body.refund_receiver,
      nonce: BigInt(body.nonce),
    },
  )
}

function parsePasskeyInnerSignature(signatures: string, expectedSignerAddress: string): string | null {
  const hex = signatures.startsWith('0x') ? signatures.slice(2) : signatures
  if (hex.length < 194) {
    return null
  }

  const encodedSigner = `0x${hex.slice(24, 64)}`
  if (encodedSigner.toLowerCase() !== expectedSignerAddress.toLowerCase()) {
    return null
  }

  const offset = Number(BigInt(`0x${hex.slice(64, 128)}`))
  const signatureType = hex.slice(128, 130)
  if (!Number.isFinite(offset) || signatureType !== '00') {
    return null
  }

  const lengthWordStart = offset * 2
  const lengthWordEnd = lengthWordStart + 64
  if (hex.length < lengthWordEnd) {
    return null
  }

  const innerLength = Number(BigInt(`0x${hex.slice(lengthWordStart, lengthWordEnd)}`))
  if (!Number.isFinite(innerLength) || innerLength < 0) {
    return null
  }

  const innerStart = lengthWordEnd
  const innerEnd = innerStart + innerLength * 2
  if (hex.length < innerEnd) {
    return null
  }

  return `0x${hex.slice(innerStart, innerEnd)}`
}

function getRelayExecGasLimit(estimatedGas: bigint | null): bigint {
  if (estimatedGas === null) {
    return RELAY_EXEC_GAS_LIMIT_FALLBACK
  }

  const buffered = estimatedGas + RELAY_EXEC_GAS_BUFFER
  return buffered > RELAY_EXEC_GAS_LIMIT_MAX ? RELAY_EXEC_GAS_LIMIT_MAX : buffered
}

async function ensurePasskeySignerDeployed(args: {
  relayer: ReturnType<typeof getRelayer>
  factoryAddress: string
  signerAddress: string
  x: `0x${string}`
  y: `0x${string}`
  verifierAddress: string
}): Promise<void> {
  const provider = args.relayer.provider
  const code = provider ? await provider.getCode(args.signerAddress) : '0x'
  if (code !== '0x') {
    return
  }

  const signerFactory = new Contract(
    args.factoryAddress,
    PASSKEY_SIGNER_FACTORY_ABI,
    args.relayer,
  ) as unknown as PasskeySignerFactoryContract

  const tx = await signerFactory.createSigner(
    BigInt(args.x),
    BigInt(args.y),
    BigInt(args.verifierAddress),
  )
  await tx.wait()
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
      await warnIfRelayerLow(body.chain_id)
      const relayer = getRelayer(body.chain_id)
      await ensurePasskeySignerDeployed({
        relayer,
        factoryAddress: chain.passkey.factoryAddress,
        signerAddress: expectedSignerAddress,
        x,
        y,
        verifierAddress: chain.passkey.verifier,
      })
      const safe = new Contract(
        body.safe_address,
        SAFE_EXEC_ABI,
        relayer,
      ) as unknown as SafeContract
      const ownerValidator = new Contract(
        expectedSignerAddress,
        ERC1271_ABI,
        relayer,
      ) as unknown as SignatureValidatorContract

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
      const innerSignature = parsePasskeyInnerSignature(body.signatures, expectedSignerAddress)

      if (!innerSignature) {
        request.log.error(
          { userId: sub, chainId: body.chain_id, safeAddress: body.safe_address },
          'Malformed passkey contract signature payload',
        )
        return reply.code(502).send({ error: 'Passkey signature payload is malformed' })
      }

      const signatureMagicValue = await ownerValidator.isValidSignature(safeTxHash, innerSignature)
      if (signatureMagicValue.toLowerCase() !== ERC1271_MAGIC_VALUE) {
        request.log.error(
          { userId: sub, chainId: body.chain_id, safeAddress: body.safe_address, safeTxHash },
          'Passkey signature validation failed for Safe execution',
        )
        return reply.code(502).send({ error: 'Passkey signature is invalid for this Safe transaction' })
      }

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
      const tx = await safe.execTransaction(...execArgs, {
        gasLimit: getRelayExecGasLimit(estimatedGas),
      })
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
