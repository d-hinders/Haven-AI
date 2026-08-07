import { assertRelayerBudget, recordRelayerSpend, finishRelayerSpend, RelayerBudgetExceededError } from '../infra/relayer-spend-guard.js'
import { FastifyInstance } from 'fastify'
// dep-lint-exempt: the deploy path runs one multi-statement transaction on a dedicated client (pool.connect) whose guards travel together (user upsert, safe insert, default promotion); a >100-line move deferred under #999
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getChain, isSupportedChain, isDeployableChain } from '../domain/chains.js'
import { predictSafePasskeySignerAddress } from '../modules/accounts/index.js'
import { getRelayer, warnIfRelayerLow, withRelayerSendLock } from '../infra/relayer.js'
import { emitFunnelEvent } from '../infra/repositories/onboarding-funnel.js'
import {
  encodeSafeSetupCalldata,
  ensurePasskeySignerDeployed,
  extractSafeAddressFromReceipt,
  getProxyFactoryContract,
  getRelayerProviderCode,
  predictSafeProxyAddress,
} from '../infra/chain/safe-proxy-deployer.js'

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

function parseHexCoordinate(value: Buffer): `0x${string}` {
  return `0x${value.toString('hex')}` as `0x${string}`
}

function isInsufficientFundsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return message.includes('insufficient funds')
}

export default async function safeDeployRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.post<{ Body: DeploySafeBody }>('/deploy', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { chain_id, salt_nonce } = request.body ?? {}

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    // Served-chains guard (#679): a chain this environment doesn't deploy on
    // would otherwise fail later on an empty relayer with a misleading transient
    // "relayer unfunded". Reject up front with a clear, non-transient message.
    if (!isDeployableChain(chain_id)) {
      return reply.code(422).send({
        error: `Haven isn't creating accounts on ${getChain(chain_id).name} in this environment. Choose a supported network.`,
      })
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

      const deploymentInitializer = encodeSafeSetupCalldata({
        owner: expectedSignerAddress,
        fallbackHandler: chain.contracts.fallbackHandler,
      })

      // #717: one deploy budget per user covers the whole route (signer
      // deploy + proxy deploy ride the same cap) — checked before the
      // relayer signs anything.
      await assertRelayerBudget('safe_deploy', { userId: sub })
      await warnIfRelayerLow(chain_id)
      const relayer = getRelayer(chain_id)
      await ensurePasskeySignerDeployed({
        chainId: chain_id,
        relayer,
        factoryAddress: chain.passkey.factoryAddress,
        signerAddress: expectedSignerAddress,
        x: parseHexCoordinate(passkey.public_key_x),
        y: parseHexCoordinate(passkey.public_key_y),
        verifierAddress: chain.passkey.verifier,
      })
      const factory = getProxyFactoryContract(chain.contracts.safeProxyFactory, relayer)

      const proxyCreationCode = await factory.proxyCreationCode()
      const predictedSafeAddress = predictSafeProxyAddress({
        factoryAddress: chain.contracts.safeProxyFactory,
        singletonAddress: chain.contracts.safeSingletonL2,
        initializer: deploymentInitializer,
        saltNonce,
        proxyCreationCode,
      })

      const existingCode = await getRelayerProviderCode(relayer, predictedSafeAddress)
      if (existingCode !== '0x') {
        await client.query('ROLLBACK')
        transactionOpen = false
        return reply.code(503).send({ error: 'Safe deployment collided; please try again later' })
      }

      // #717: attempt row BEFORE broadcast (bursts see each other; the row
      // survives a throw-on-revert wait). NOTE: the passkey-signer factory tx
      // above shares this row's cap but its own gas is not itemised — a known
      // undercount in attribution, not in the cap.
      const spendId = await recordRelayerSpend({ operation: 'safe_deploy', chainId: chain_id, userId: sub })
      // Broadcast under the per-chain send lock so the deploy can't race
      // another relayer submission for the same EOA nonce (#692/#718).
      const tx = await withRelayerSendLock(chain_id, () =>
        factory.createProxyWithNonce(
          chain.contracts.safeSingletonL2,
          deploymentInitializer,
          saltNonce,
        ),
      )
      let receipt
      try {
        receipt = await tx.wait()
      } finally {
        // The local receipt type only declares `logs` (address extraction);
        // the gas fields exist on the real ethers receipt.
        const gasReceipt = receipt as unknown as { gasUsed?: { toString(): string }; gasPrice?: { toString(): string } } | null
        await finishRelayerSpend(spendId, {
          txHash: tx.hash,
          gasUsed: gasReceipt?.gasUsed != null ? BigInt(gasReceipt.gasUsed.toString()) : null,
          effectiveGasPrice: gasReceipt?.gasPrice != null ? BigInt(gasReceipt.gasPrice.toString()) : null,
        })
      }
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

      emitFunnelEvent(sub, 'safe_deployed', { safe_address: safeAddress, chain_id })
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
      if (error instanceof RelayerBudgetExceededError) {
        return reply.code(429).send({ error: error.message })
      }
      if (isInsufficientFundsError(error)) {
        return reply.code(503).send({ error: 'Relayer is temporarily unfunded; please try again later' })
      }
      throw error
    } finally {
      client.release()
    }
  })
}
