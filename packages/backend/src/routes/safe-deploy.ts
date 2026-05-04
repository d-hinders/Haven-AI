import { FastifyInstance } from 'fastify'
import {
  Contract,
  Interface,
  ZeroAddress,
  getAddress,
  getCreate2Address,
  keccak256,
  solidityPacked,
  solidityPackedKeccak256,
} from 'ethers'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getChain, isSupportedChain } from '../lib/chains.js'
import { predictSafePasskeySignerAddress } from '../lib/passkey-signer.js'
import { getRelayer, warnIfRelayerLow } from '../lib/relayer.js'

const SAFE_SETUP_ABI = [
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
] as const

const PROXY_FACTORY_ABI = [
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'function proxyCreationCode() view returns (bytes)',
  'event ProxyCreation(address proxy, address singleton)',
] as const
const PASSKEY_SIGNER_FACTORY_ABI = [
  'function createSigner(uint256 x, uint256 y, uint176 verifiers) returns (address signer)',
] as const

const SAFE_SETUP_IFACE = new Interface(SAFE_SETUP_ABI)
const PROXY_FACTORY_IFACE = new Interface(PROXY_FACTORY_ABI)

interface DeploySafeBody {
  chain_id: number
  salt_nonce?: string
}

interface StoredPasskeyRow {
  id: string
  public_key_x: Buffer
  public_key_y: Buffer
  signer_address: string
  safe_address: string | null
}

interface SafeProxyFactoryContract {
  createProxyWithNonce(singleton: string, initializer: string, saltNonce: bigint): Promise<{
    hash: string
    wait(): Promise<{ logs: Array<{ address?: string; topics?: string[]; data?: string }> } | null>
  }>
  proxyCreationCode(): Promise<string>
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

function isRetriableDeployError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('already deployed') || message.includes('create2')
}

function extractSafeAddressFromReceipt(
  factoryAddress: string,
  receipt: { logs: Array<{ address?: string; topics?: string[]; data?: string }> },
): string {
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== factoryAddress.toLowerCase()) {
      continue
    }

    try {
      const parsed = PROXY_FACTORY_IFACE.parseLog({
        topics: log.topics ?? [],
        data: log.data ?? '0x',
      })
      if (parsed?.name === 'ProxyCreation') {
        return getAddress(parsed.args[0])
      }
    } catch {
      // Ignore unrelated logs from the same tx.
    }
  }

  throw new Error('Safe deployment transaction succeeded but ProxyCreation event not found')
}

function predictSafeProxyAddress(args: {
  factoryAddress: string
  singletonAddress: string
  initializer: string
  saltNonce: bigint
  proxyCreationCode: string
}): string {
  const deploymentData = solidityPacked(
    ['bytes', 'uint256'],
    [args.proxyCreationCode, BigInt(args.singletonAddress)],
  )
  const salt = solidityPackedKeccak256(
    ['bytes32', 'uint256'],
    [keccak256(args.initializer), args.saltNonce],
  )

  return getCreate2Address(
    args.factoryAddress,
    salt,
    keccak256(deploymentData),
  )
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

export default async function safeDeployRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.post<{ Body: DeploySafeBody }>('/deploy', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { chain_id, salt_nonce } = request.body ?? {}

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    if (salt_nonce !== undefined && !/^\d+$/.test(salt_nonce)) {
      return reply.code(400).send({ error: 'salt_nonce must be a decimal string' })
    }

    const chain = getChain(chain_id)
    const saltNonce = salt_nonce
      ? BigInt(salt_nonce)
      : BigInt(Math.floor(Math.random() * 1_000_000_000))

    const client = await pool.connect()
    let transactionOpen = false

    try {
      await client.query('BEGIN')
      transactionOpen = true

      const passkeyResult = await client.query<StoredPasskeyRow>(
        `SELECT id, public_key_x, public_key_y, signer_address, safe_address
         FROM user_passkeys
         WHERE user_id = $1 AND chain_id = $2
         FOR UPDATE`,
        [sub, chain_id],
      )

      if (passkeyResult.rows.length === 0) {
        await client.query('ROLLBACK')
        transactionOpen = false
        return reply.code(404).send({ error: 'No passkey enrolled for this chain' })
      }

      const passkey = passkeyResult.rows[0]
      if (passkey.safe_address) {
        await client.query('ROLLBACK')
        transactionOpen = false
        return reply.code(409).send({ error: 'A Safe is already deployed for this passkey' })
      }

      const expectedSignerAddress = predictSafePasskeySignerAddress({
        x: parseHexCoordinate(passkey.public_key_x),
        y: parseHexCoordinate(passkey.public_key_y),
        chainId: chain_id,
      })

      if (expectedSignerAddress.toLowerCase() !== passkey.signer_address.toLowerCase()) {
        request.log.error({ userId: sub, chainId: chain_id }, 'Stored passkey signer mismatch')
        await client.query('ROLLBACK')
        transactionOpen = false
        return reply.code(500).send({ error: 'Internal server error' })
      }

      const deploymentInitializer = SAFE_SETUP_IFACE.encodeFunctionData('setup', [
        [expectedSignerAddress],
        1n,
        ZeroAddress,
        '0x',
        chain.contracts.fallbackHandler,
        ZeroAddress,
        0n,
        ZeroAddress,
      ])

      await warnIfRelayerLow(chain_id)
      const relayer = getRelayer(chain_id)
      await ensurePasskeySignerDeployed({
        relayer,
        factoryAddress: chain.passkey.factoryAddress,
        signerAddress: expectedSignerAddress,
        x: parseHexCoordinate(passkey.public_key_x),
        y: parseHexCoordinate(passkey.public_key_y),
        verifierAddress: chain.passkey.verifier,
      })
      const factory = new Contract(
        chain.contracts.safeProxyFactory,
        PROXY_FACTORY_ABI,
        relayer,
      ) as unknown as SafeProxyFactoryContract

      const proxyCreationCode = await factory.proxyCreationCode()
      const predictedSafeAddress = predictSafeProxyAddress({
        factoryAddress: chain.contracts.safeProxyFactory,
        singletonAddress: chain.contracts.safeSingletonL2,
        initializer: deploymentInitializer,
        saltNonce,
        proxyCreationCode,
      })

      const provider = relayer.provider
      const existingCode = provider ? await provider.getCode(predictedSafeAddress) : '0x'
      if (existingCode !== '0x') {
        await client.query('ROLLBACK')
        transactionOpen = false
        return reply.code(503).send({ error: 'Safe deployment collided; please try again later' })
      }

      const tx = await factory.createProxyWithNonce(
        chain.contracts.safeSingletonL2,
        deploymentInitializer,
        saltNonce,
      )
      const receipt = await tx.wait()
      if (!receipt) {
        throw new Error('Safe deployment transaction did not return a receipt')
      }

      const safeAddress = extractSafeAddressFromReceipt(chain.contracts.safeProxyFactory, receipt)

      await client.query(
        `UPDATE user_passkeys
         SET safe_address = $1
         WHERE id = $2`,
        [safeAddress, passkey.id],
      )

      await client.query('COMMIT')
      transactionOpen = false

      return reply.code(201).send({
        safe_address: safeAddress,
        tx_hash: tx.hash,
        chain_id,
      })
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          request.log.error({ err: rollbackError }, 'Failed to roll back passkey safe deployment transaction')
        }
      }
      if (isInsufficientFundsError(error)) {
        return reply.code(503).send({ error: 'Relayer is temporarily unfunded; please try again later' })
      }
      if (isRetriableDeployError(error)) {
        return reply.code(503).send({ error: 'Safe deployment collided; please try again later' })
      }
      throw error
    } finally {
      client.release()
    }
  })
}
