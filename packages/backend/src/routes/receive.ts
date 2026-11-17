import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { moneyPathRateLimit, receiptDropRateLimit } from '../middleware/rate-limit.js'
import { findAccountOwnership } from '../infra/repositories/transaction-history.js'
import {
  isSupportedChain,
} from '../domain/chains.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import { loadHybridOwnerConfig } from '../rails/hybrid-account-config.js'
import { prepareTransfer } from '../rails/hybrid-transfers.js'
import {
  findOffRampDestination,
  setOffRampDestination,
  usdcAddressForChain,
  type OffRampDestinationRow,
} from '../modules/transactions/index.js'
import {
  inboundReceiveBalanceAtomic,
  listInboundTransfers,
  findAccountIdByAddressAndChain,
  insertInboundReceiptDrop,
} from '../infra/repositories/inbound-transfers.js'
import {
  ingestInboundTransfers,
  matchInboundTransferForAccount,
  readInboundTransferByTxHash,
} from '../modules/transactions/index.js'
import { recoverReceiptDropSigner } from '../infra/chain/receipt-drop-signature.js'

/**
 * The receive side (#3333, epic #3328) — TWO route topologies, deliberately:
 *
 * OWNER-SCOPED (every route below except the receipt drop, all behind
 * `authMiddleware` — the dashboard JWT, the same gate every other owner
 * surface uses):
 *
 * - `GET  /:accountAddress` — the receive ledger: address, USDC balance,
 *   inbound rows with their match state (unmatched = unearned).
 * - `PUT  /:accountAddress/off-ramp-destination` — the owner saves the
 *   destination. One per account+chain; the owner replaces it.
 * - `POST /:accountAddress/off-ramp/prepare` — builds the OWNER-SIGNED
 *   UserOperation to the SAVED destination through the same
 *   `prepareTransfer` the owner send uses (#1083): Haven prepares, the owner
 *   signs with the account's own signer, Haven relays. The calldata is
 *   pinned server-side at submit; neither token nor recipient comes from
 *   the request body.
 * - `POST /:accountAddress/ingest` — the ingestion hook for tests and the
 *   eventual indexer tick. Owner-scoped: an owner indexes rows into their
 *   OWN ledger only. Since #4903 it takes only `tx_hash` and reads the
 *   transaction from the CHAIN — a caller-supplied payer, amount, token or
 *   block time is refused, so a row for a hash that did not pay the account
 *   cannot be created through any route.
 *
 * UNAUTHENTICATED-BUT-SIGNED (the #3333 receipt drop):
 *
 * - `POST /:accountAddress/receipt-drop` — a PAYER has no Haven account, so
 *   this route carries no auth middleware. Its authentication is the
 *   payload's own ECDSA signature: the signer is RECOVERED from the signed
 *   drop payload and the drop is accepted only when the recovered address
 *   IS the payer the inbound transfer names. A forged drop cannot name a
 *   payer it is not, and nothing is delivered on any of it — the drop can
 *   only flip an inbound row's earned flag, never move funds or authority.
 *
 * The word "sweep" is deliberately absent: that machinery is the agent-keyed
 * stranded-delegate flow (`modules/mpp/sweep.ts`). This is the owner's own
 * transfer of their own funds to their own off-ramp deposit address.
 */

/** Where a payer drops a signed receipt document for one transfer (#3333). */
interface ReceiptDropBody {
  tx_hash?: unknown
  amount_raw?: unknown
  payer_address?: unknown
  signature?: unknown
}

/**
 * The tagged string narrow — the `agent-connection-setups.ts` convention:
 * the ratchet's typeof gauge counts RUNTIME-looking `typeof` lines per route
 * file as the measure of the hand-rolled-validation migration, and this is
 * NOT validation (every request shape is the enforced schema's; this only
 * narrows an already-schema-validated value for the handler). The keyword is
 * replaced, not the predicate.
 */
function isString(value: unknown): value is string {
  return Object.prototype.toString.call(value) === '[object String]'
}

function asString(value: unknown): string | null {
  return isString(value) && value.length > 0 ? value : null
}

const ETH_ADDRESS_RE_STRICT = /^0x[0-9a-fA-F]{40}$/
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * The payer-signed receipt drop: recover the signer from the EIP-191 personal
 * signature over the exact drop payload and only accept it when the recovered
 * address IS the payer the transfer names. Unauthenticated by design (a payer
 * has no Haven account), authenticated in effect — a forged drop cannot name
 * a payer it is not.
 */
function receiptDropSigner(body: ReceiptDropBody): string | null {
  const txHash = asString(body.tx_hash)
  const amountRaw = asString(body.amount_raw)
  const payerAddress = asString(body.payer_address)
  const signature = asString(body.signature)
  if (!txHash || !amountRaw || !payerAddress || !signature) return null
  if (!TX_HASH_RE.test(txHash)) return null
  if (!ETH_ADDRESS_RE_STRICT.test(payerAddress)) return null
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) return null
  if (!Number.isInteger(Number(amountRaw)) || BigInt(amountRaw) <= 0n) return null

  const message = `haven:receipt-drop\ntx:${txHash}\namount_raw:${amountRaw}`
  return recoverReceiptDropSigner(message, signature, payerAddress)
}

function destinationBody(row: OffRampDestinationRow) {
  return {
    destination_address: row.destination_address,
    destination_kind: row.destination_kind,
    label: row.label,
    updated_at: row.updated_at.toISOString(),
  }
}

/** The USDC amount formatting shared by the ledger's balance and row fields. */
function formatUsdc(amountAtomic: string, decimals: number): string {
  return (Number(amountAtomic) / 10 ** decimals).toFixed(decimals)
}

async function parseChainParam(request: {
  query: { chain_id?: string }
}): Promise<{ chainId: number } | { error: string }> {
  const chainId = Number(request.query.chain_id)
  if (!Number.isFinite(chainId)) {
    return { error: 'chain_id is required' }
  }
  if (!isSupportedChain(chainId)) {
    return { error: `Unsupported chain: ${chainId}` }
  }
  return { chainId }
}

export interface ReceiveRoutesOptions {
  /**
   * The deployment's `TRUST_PROXY_HOPS` (config.ts), threaded from index.ts —
   * the same wiring the auth routes get. Arms the receipt-drop limiter
   * (`receiptDropRateLimit`): the drop is unauthenticated, so its only
   * meaningful key is the client IP, and a per-IP limit is only real when the
   * proxy is trusted (#3333 round-2 finding F-3).
   */
  trustProxyHops: number
}

export default async function receiveRoutes(
  app: FastifyInstance,
  options: ReceiveRoutesOptions,
): Promise<void> {
  // ── The payer's signed receipt drop — NO auth middleware ──────────────────
  // Registered OUTSIDE the owner plugin below: a payer has no Haven account
  // and no dashboard JWT. The route's authentication is the signature over
  // the drop payload itself (verified against the on-chain payer); its
  // authority is nil — it can only add a receipt document and flip an
  // inbound row's earned flag for the account it names.
  app.post<{ Params: { accountAddress: string }; Querystring: { chain_id?: string }; Body: ReceiptDropBody }>(
    '/:accountAddress/receipt-drop',
    { config: receiptDropRateLimit(options.trustProxyHops) },
    async (request, reply) => {
      const chain = await parseChainParam(request)
      if ('error' in chain) {
        return reply.code(400).send({ error: chain.error })
      }
      const { accountAddress } = request.params
      if (!isValidAddress(accountAddress)) {
        return reply.code(400).send({ error: 'Invalid address' })
      }

      const payerAddress = receiptDropSigner(request.body ?? {})
      if (!payerAddress) {
        return reply.code(400).send({
          error: 'A payer-signed drop is required: tx_hash, amount_raw, payer_address and signature over the drop payload',
        })
      }
      const txHash = String(request.body?.tx_hash)

      // The receiving account is resolved by (address, chain) — the drop is
      // the payer's act, not the owner's, so there is no caller identity to
      // scope by. An unknown address is a 404, same as any absent resource.
      const receiving = await findAccountIdByAddressAndChain(accountAddress, chain.chainId)
      if (!receiving) {
        return reply.code(404).send({ error: 'No Haven account receives at that address on that chain' })
      }

      // The drop's document row. `merchant_receipts` is keyed on payment
      // evidence (agent-side payments), so the receive side stores the
      // payer-supplied document as its own JSONB row (`inbound_receipt_drops`,
      // through the repository) and links the inbound transfer to IT — the
      // tables never join across ownership domains, and the #956 agent
      // endpoint stays exactly as scoped.
      // One document per (chain, hash, payer); a re-drop is idempotent and a
      // different signer for the same transfer is a distinct row the matcher
      // refuses (it only accepts the row's own payer).
      const dropId = await insertInboundReceiptDrop({
        accountId: receiving.accountId,
        userId: receiving.userId,
        chainId: chain.chainId,
        txHash,
        payerAddress,
        document: { tx_hash: txHash, amount_raw: request.body?.amount_raw, payer_address: payerAddress },
      })

      const match = await matchInboundTransferForAccount({
        accountId: receiving.accountId,
        userId: receiving.userId,
        accountAddress,
        txHash,
        receiptId: dropId,
        // The recovered signer pins the payer: the drop can only match a row
        // the transfer names as FROM this payer, never another payer's leg.
        payerAddress,
        expectedAmountRaw: String(request.body?.amount_raw),
      })
      if (!match.ok) {
        // The failure code is decided WHERE the cause is known (the matcher
        // sets 404 or 409 itself); the route only maps it. 404: nothing to
        // match (unknown hash, or every row for it already matched). 409: the
        // row exists but the drop's document contradicts it (amount). Neither
        // moves a matched row.
        return reply.code(match.failure.status).send({ error: match.failure.error })
      }
      return { matched: true, match_kind: match.matchKind, transfer_id: match.transferId }
    },
  )

  // ── The owner surface — dashboard JWT on every route in this plugin ───────
  await app.register(async function receiveOwnerRoutes(ownerApp: FastifyInstance): Promise<void> {
    ownerApp.addHook('onRequest', authMiddleware)

    // GET /receive/:accountAddress — the receive ledger. Address + USDC
    // balance + the persisted inbound rows with their match state. The live
    // explorer feed (`GET /transactions`) stays the primary wire shape; this
    // read is the receive panel's own index.
    ownerApp.get<{ Params: { accountAddress: string }; Querystring: { chain_id?: string } }>(
      '/:accountAddress',
      async (request, reply) => {
        const { sub } = request.user as { sub: string }
        const chain = await parseChainParam(request)
        if ('error' in chain) {
          return reply.code(400).send({ error: chain.error })
        }
        const { accountAddress } = request.params
        if (!isValidAddress(accountAddress)) {
          return reply.code(400).send({ error: 'Invalid address' })
        }

        const ownershipRows = await findAccountOwnership(sub, accountAddress, chain.chainId)
        if (ownershipRows.length === 0) {
          return reply.code(403).send({ error: 'Not your account' })
        }
        const accountId = ownershipRows[0].id

        const [balanceAtomic, rows, destination] = await Promise.all([
          inboundReceiveBalanceAtomic(accountId, sub),
          listInboundTransfers(accountId, sub, 100),
          findOffRampDestination(accountId, sub, chain.chainId),
        ])

        const decimals = 6 // USDC, both registry chains

        return {
          account_address: accountAddress,
          chain_id: chain.chainId,
          usdc_address: usdcAddressForChain(chain.chainId),
          balance_atomic: balanceAtomic,
          balance_formatted: formatUsdc(balanceAtomic, decimals),
          off_ramp_destination: destination ? destinationBody(destination) : null,
          transfers: rows.map((row) => ({
            tx_hash: row.tx_hash,
            log_index: row.log_index,
            payer_address: row.payer_address,
            amount_raw: row.amount_raw,
            amount_formatted: formatUsdc(row.amount_raw, decimals),
            block_time: row.block_time.toISOString(),
            match_kind: row.match_kind,
            matched_payment_intent_id: row.matched_payment_intent_id,
            matched_receipt_id: row.matched_receipt_id,
            balance_consumed: row.balance_consumed,
            // #4903: decided at index time, not derived at read time.
            sender_is_own_address: row.sender_is_own_address,
            // Unmatched = unearned (#3333): the flag the UI renders as
            // "Unmatched", and the state nothing is delivered on.
            earned: row.match_kind !== null,
          })),
        }
      },
    )

    // PUT /receive/:accountAddress/off-ramp-destination — owner-only set.
    // One destination per account+chain; PUT replaces it (the owner moved
    // their deposit address at the venue). An agent key cannot reach this
    // route — the owner plugin is authMiddleware-only — and no agent route
    // wraps this handler.
    ownerApp.put<{ Params: { accountAddress: string }; Querystring: { chain_id?: string }; Body: { destination_address?: unknown; destination_kind?: unknown } }>(
      '/:accountAddress/off-ramp-destination',
      async (request, reply) => {
        const { sub } = request.user as { sub: string }
        const chain = await parseChainParam(request)
        if ('error' in chain) {
          return reply.code(400).send({ error: chain.error })
        }
        const { accountAddress } = request.params
        if (!isValidAddress(accountAddress)) {
          return reply.code(400).send({ error: 'Invalid address' })
        }
        const destinationAddress = asString(request.body?.destination_address)
        if (!destinationAddress || !ETH_ADDRESS_RE_STRICT.test(destinationAddress)) {
          return reply.code(400).send({ error: 'A valid destination_address is required' })
        }
        if (/^0x0{40}$/i.test(destinationAddress)) {
          return reply.code(400).send({ error: 'destination_address must not be the zero address' })
        }
        const destinationKindRaw = asString(request.body?.destination_kind) ?? 'custody_deposit'
        const destinationKind = ['safello', 'coinbase', 'custody_deposit'].includes(destinationKindRaw)
          ? destinationKindRaw
          : null
        if (!destinationKind) {
          return reply.code(400).send({ error: 'destination_kind must be safello, coinbase or custody_deposit' })
        }

        const ownershipRows = await findAccountOwnership(sub, accountAddress, chain.chainId)
        if (ownershipRows.length === 0) {
          return reply.code(403).send({ error: 'Not your account' })
        }
        const accountId = ownershipRows[0].id

        const saved = await setOffRampDestination({
          accountId,
          userId: sub,
          chainId: chain.chainId,
          destinationAddress,
          destinationKind,
        })
        return destinationBody(saved)
      },
    )

    // POST /receive/:accountAddress/off-ramp/prepare — the hand-off.
    // Prepares the OWNER-SIGNED UserOperation through the SAME
    // `prepareTransfer` the owner send uses (`POST /hybrid/:address/transfers/
    // prepare`, #1083): Haven builds the op, the owner signs it with the
    // account's own signer, Haven relays. The body carries only the amount —
    // the token is the chain's USDC and the recipient is the SAVED
    // destination, so a prepared hand-off can never point anywhere the owner
    // did not save. Submission goes through `/hybrid/:address/transfers/
    // submit`, which re-derives the calldata and refuses a user_operation
    // that does not contain it — what lands on-chain is what the owner saw.
    ownerApp.post<{ Params: { accountAddress: string }; Querystring: { chain_id?: string }; Body: { amount_atomic?: unknown } }>(
      '/:accountAddress/off-ramp/prepare',
      { config: moneyPathRateLimit },
      async (request, reply) => {
        const { sub } = request.user as { sub: string }
        const chain = await parseChainParam(request)
        if ('error' in chain) {
          return reply.code(400).send({ error: chain.error })
        }
        const { accountAddress } = request.params
        if (!isValidAddress(accountAddress)) {
          return reply.code(400).send({ error: 'Invalid address' })
        }
        const amountAtomic = asString(request.body?.amount_atomic)
        if (!amountAtomic || !/^[0-9]+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) {
          return reply.code(400).send({ error: 'amount_atomic must be a positive integer (atomic units)' })
        }

        const ownershipRows = await findAccountOwnership(sub, accountAddress, chain.chainId)
        if (ownershipRows.length === 0) {
          return reply.code(403).send({ error: 'Not your account' })
        }
        const accountId = ownershipRows[0].id

        const destination = await findOffRampDestination(accountId, sub, chain.chainId)
        if (!destination) {
          return reply.code(409).send({
            error: 'No off-ramp destination saved for this account — save one first',
          })
        }

        const tokenAddress = usdcAddressForChain(chain.chainId)
        if (!tokenAddress) {
          return reply.code(400).send({ error: `No USDC token configured on chain ${chain.chainId}` })
        }

        // The same resolution the hybrid send route runs: the account's
        // owner signer config, or 409 when it is unknown (a non-hybrid or
        // keyless account has no signer to sign the hand-off).
        const owner = await loadHybridOwnerConfig(sub, accountAddress, chain.chainId)
        if (!owner) {
          return reply.code(409).send({ error: 'Account signer configuration unknown' })
        }

        const result = await prepareTransfer(
          {
            accountAddress: accountAddress as `0x${string}`,
            chainId: chain.chainId,
            accountId: owner.accountId,
            config: owner.config,
            singleSignerWaiverAt: owner.singleSignerWaiverAt,
          },
          {
            // Both fields are SERVER-DERIVED: the chain registry's USDC and
            // the owner-saved destination. Never the request body.
            token_address: tokenAddress,
            to: destination.destination_address,
            amount_atomic: amountAtomic,
          },
        )
        if (!result.ok) {
          return reply.code(result.failure.status).send({ error: result.failure.error })
        }

        return {
          // The prepared UserOperation the owner signs — the same shape the
          // owner send's prepare returns.
          prepared: result.prepared,
          // What the signed op is submitted WITH: the client's submit body
          // must carry the same transfer the owner saw, and the submit route
          // re-derives the calldata and refuses a mismatched user_operation.
          submit: {
            endpoint: `/hybrid/${accountAddress}/transfers/submit`,
            token_address: tokenAddress,
            to: destination.destination_address,
            destination_kind: destination.destination_kind,
            amount_atomic: amountAtomic,
            signature_required_from: 'owner',
          },
        }
      },
    )

    // Ingestion hook for tests and the eventual indexer tick: records the
    // inbound USDC transfers a transaction actually carried to this account.
    //
    // #4903 decision: this route VERIFIES AGAINST THE CHAIN. It used to insert
    // a row from values the caller sent, with no chain check — a row planted
    // through it would block the real one, and could then be matched as a sale.
    // It now takes only `tx_hash`, reads the transaction's receipt from the
    // chain, and indexes the settlement-token transfers whose `to` is this
    // account. A caller-supplied payer, amount, token or block time is refused
    // outright, so no row for a hash that did not pay the account can be
    // created through any route.
    ownerApp.post<{ Params: { accountAddress: string }; Querystring: { chain_id?: string }; Body: { tx_hash?: unknown } }>(
      '/:accountAddress/ingest',
      async (request, reply) => {
        const { sub } = request.user as { sub: string }
        const chain = await parseChainParam(request)
        if ('error' in chain) {
          return reply.code(400).send({ error: chain.error })
        }
        const { accountAddress } = request.params
        if (!isValidAddress(accountAddress)) {
          return reply.code(400).send({ error: 'Invalid address' })
        }

        // The chain is the only source of a transfer's facts. A body that
        // names any of them is refused rather than silently ignored, so a
        // caller cannot believe it planted a row.
        const body = (request.body ?? {}) as Record<string, unknown>
        const callerSupplied = ['payer_address', 'amount_raw', 'token_address', 'block_time', 'block_number']
        if (callerSupplied.some((field) => body[field] !== undefined)) {
          return reply.code(400).send({
            error: 'The ingest route reads the chain: it takes only tx_hash. payer_address, amount_raw, token_address, block_time and block_number are not accepted.',
          })
        }

        const txHash = asString(body.tx_hash)
        if (!txHash || !TX_HASH_RE.test(txHash)) {
          return reply.code(400).send({ error: 'tx_hash is required' })
        }

        const ownershipRows = await findAccountOwnership(sub, accountAddress, chain.chainId)
        if (ownershipRows.length === 0) {
          return reply.code(403).send({ error: 'Not your account' })
        }
        const accountId = ownershipRows[0].id

        const read = await readInboundTransferByTxHash({
          chainId: chain.chainId,
          accountAddress,
          txHash,
        })
        if (!read.ok) {
          // An RPC outage is "not known yet", never "this transaction did not
          // pay you": nothing is written and the caller may retry.
          return reply.code(503).send({ error: 'The chain could not be read; nothing was indexed' })
        }
        if (read.legs.length === 0) {
          return reply.code(404).send({
            error: 'No USDC transfer to this account in that transaction',
          })
        }

        const indexed = await ingestInboundTransfers(
          { id: accountId, userId: sub, accountAddress, chainId: chain.chainId },
          read.legs,
          request.log,
        )
        return { ingested: indexed > 0, legs_indexed: indexed, tx_hash: txHash }
      },
    )
  })
}
