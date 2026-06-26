import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import {
  fetchNormalTransactions,
  fetchInternalTransactions,
  fetchERC20Transfers,
  fetchSafeServiceTransfers,
} from '../lib/explorer-api.js'
import { getChain, isSupportedChain } from '../lib/chains.js'
import { formatTokenValue } from '../lib/tokens.js'
import { createCache } from '../lib/cache.js'
import { machinePaymentLifecycle } from '../lib/machine-payment-lifecycle.js'
import { ETH_ADDRESS_RE } from '../lib/address.js'
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface Transaction {
  hash: string
  type: 'native' | 'erc20' | 'internal'
  from: string
  to: string
  value: string
  valueFormatted: string
  asset: string
  decimals: number
  direction: 'in' | 'out'
  timestamp: number
  blockNumber: number
  isError: boolean
  tokenAddress?: string
  tokenSymbol?: string
  source?: string
  x402ResourceUrl?: string | null
  x402MerchantAddress?: string | null
  paymentId?: string
  paymentProofStatus?: string | null
  paymentFlowStatus?: string | null
  paymentAttentionReason?: string | null
  activityType?: 'delegate_sweep'
  /** Book-time SEK value (P0 #463); null for non-machine / unpriced transactions. */
  amountSek?: string | null
}

interface UserSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
}

export interface EnrichedTransaction extends Transaction {
  chainId: number
  safeId: string
  safeAddress: string
  safeName: string
  agentId?: string
  agentName?: string
}

interface PaymentIntentAgentRow {
  id: string
  tx_hash: string
  safe_id: string
  chain_id: number
  agent_id: string
  agent_name: string
  source: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
}

interface ApprovalRequestAgentRow {
  id: string
  tx_hash: string
  safe_id: string
  chain_id: number
  agent_id: string
  agent_name: string
  source: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
}

interface DelegateSweepAgentRow {
  id: string
  tx_hash: string
  safe_id: string
  chain_id: number
  agent_id: string
  agent_name: string
  from_address: string
  to_address: string
}

interface X402PaymentIntentRow {
  id: string
  tx_hash: string
  agent_id: string
  agent_name: string
  safe_id: string
  safe_address: string
  safe_name: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  x402_merchant_address: string | null
  x402_resource_url: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
  confirmed_at: string | null
  created_at: string
}

interface X402ApprovalRequestRow {
  id: string
  tx_hash: string
  agent_id: string
  agent_name: string
  safe_id: string
  safe_address: string
  safe_name: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  merchant_address: string | null
  payment_resource_url: string | null
  payment_proof_status: string | null
  payment_reconciliation_event_type: string | null
  amount_sek: string | null
  executed_at: string | null
  created_at: string
}

interface MachinePaymentEvidenceDetailRow {
  id: string
  payment_intent_id: string | null
  approval_request_id: string | null
  rail: string
  proof_status: string
  tx_hash: string
  chain_id: number
  resource_url: string
  merchant_address: string | null
  payer_address: string
  settlement_address: string
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  challenge_id: string | null
  idempotency_key: string | null
  challenge_payload: Record<string, unknown> | null
  selected_payment: Record<string, unknown> | null
  payment_proof_header_name: string | null
  payment_proof_header: string | null
  protocol_receipt_header_name: string | null
  protocol_receipt_header: string | null
  protocol_receipt_payload: Record<string, unknown> | null
  merchant_status: number | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
}

interface FetchSafeTransactionsParams {
  safeId: string
  safeAddress: string
  chainId: number
  log: FastifyBaseLogger
  fresh?: boolean
}

interface FetchSafeTransactionsResult {
  transactions: Transaction[]
  hadFailures: boolean
}

interface ParsedTokenFilter {
  chainId: number
  address: string | null
}

const txCache = createCache<Transaction[]>(30_000)
const txInflight = new Map<string, Promise<FetchSafeTransactionsResult>>()

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return null
  }
  return parsed
}

function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  if (Array.isArray(value)) return Number.NaN

  const raw = String(value).trim()
  if (!/^[1-9]\d*$/.test(raw)) return Number.NaN

  const chainId = Number(raw)
  return Number.isSafeInteger(chainId) ? chainId : Number.NaN
}

function parseFreshFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function parseTokenKey(tokenKey: string | undefined): ParsedTokenFilter | null {
  if (!tokenKey) return null

  const [chainPart, assetPart, ...rest] = tokenKey.split(':')
  if (!chainPart || !assetPart || rest.length > 0) return null

  const chainId = parseInt(chainPart, 10)
  if (Number.isNaN(chainId)) return null

  try {
    getChain(chainId)
  } catch {
    return null
  }

  if (assetPart === 'native') {
    return { chainId, address: null }
  }

  if (!ETH_ADDRESS_RE.test(assetPart)) {
    return null
  }

  return { chainId, address: assetPart.toLowerCase() }
}

function parseIsoTimestamp(iso: string): number {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

function transactionDedupKey(tx: Transaction): string {
  return [
    tx.hash,
    tx.type,
    tx.from.toLowerCase(),
    tx.to.toLowerCase(),
    tx.value,
    tx.tokenAddress?.toLowerCase() ?? 'native',
  ].join(':')
}

export async function fetchSafeTransactions({
  safeId,
  safeAddress,
  chainId,
  log,
  fresh = false,
}: FetchSafeTransactionsParams): Promise<FetchSafeTransactionsResult> {
  const chain = getChain(chainId)
  const nativeToken = Object.values(chain.tokens).find((token) => token.address === null)!
  const cacheKey = `tx:${chainId}:${safeAddress.toLowerCase()}`

  if (fresh) {
    txCache.delete(cacheKey)
  }

  const cached = txCache.get(cacheKey)
  if (cached !== undefined) {
    return { transactions: cached, hadFailures: false }
  }

  const inflight = txInflight.get(cacheKey)
  if (inflight) {
    return inflight
  }

  const requestPromise = (async () => {
    const addrLower = safeAddress.toLowerCase()
    let hadFailures = false
    const logFail = (kind: string) => (err: unknown) => {
      hadFailures = true
      log.warn({ err, chainId, safeId, safeAddress, kind }, 'Explorer API fetch failed')
      return []
    }

    const normalTxs = await fetchNormalTransactions(chainId, safeAddress).catch(
      logFail('normal'),
    )
    const internalTxs = await fetchInternalTransactions(chainId, safeAddress).catch(
      logFail('internal'),
    )
    const erc20Txs = await fetchERC20Transfers(chainId, safeAddress).catch(
      logFail('erc20'),
    )
    const safeTransfers = await fetchSafeServiceTransfers(chainId, safeAddress).catch(
      logFail('safe-transfers'),
    )

    const transactions: Transaction[] = []

    for (const tx of normalTxs) {
      if (tx.value === '0' && tx.functionName) continue

      transactions.push({
        hash: tx.hash,
        type: 'native',
        from: tx.from,
        to: tx.to,
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
        asset: nativeToken.symbol,
        decimals: nativeToken.decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: parseInt(tx.timeStamp, 10),
        blockNumber: parseInt(tx.blockNumber, 10),
        isError: tx.isError === '1',
      })
    }

    for (const tx of internalTxs) {
      if (tx.value === '0') continue

      transactions.push({
        hash: tx.hash,
        type: 'internal',
        from: tx.from,
        to: tx.to,
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
        asset: nativeToken.symbol,
        decimals: nativeToken.decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: parseInt(tx.timeStamp, 10),
        blockNumber: parseInt(tx.blockNumber, 10),
        isError: tx.isError === '1',
      })
    }

    for (const tx of erc20Txs) {
      const knownToken = chain.tokenByAddress[tx.contractAddress.toLowerCase()]
      const symbol = knownToken?.symbol ?? tx.tokenSymbol ?? tx.contractAddress
      const decimals = knownToken?.decimals ?? (parseInt(tx.tokenDecimal, 10) || 18)

      transactions.push({
        hash: tx.hash,
        type: 'erc20',
        from: tx.from,
        to: tx.to,
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, decimals),
        asset: symbol,
        decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: parseInt(tx.timeStamp, 10),
        blockNumber: parseInt(tx.blockNumber, 10),
        isError: false,
        tokenAddress: tx.contractAddress,
        tokenSymbol: symbol,
      })
    }

    for (const transfer of safeTransfers) {
      if (transfer.type === 'ETHER_TRANSFER') {
        if (!transfer.value || transfer.value === '0') continue

        transactions.push({
          hash: transfer.transactionHash,
          type: 'native',
          from: transfer.from ?? '',
          to: transfer.to ?? '',
          value: transfer.value,
          valueFormatted: formatTokenValue(transfer.value, nativeToken.decimals),
          asset: nativeToken.symbol,
          decimals: nativeToken.decimals,
          direction: transfer.to?.toLowerCase() === addrLower ? 'in' : 'out',
          timestamp: parseIsoTimestamp(transfer.executionDate),
          blockNumber: transfer.blockNumber,
          isError: false,
        })
      }

      if (transfer.type === 'ERC20_TRANSFER') {
        if (!transfer.value || !transfer.tokenAddress) continue

        const knownToken = chain.tokenByAddress[transfer.tokenAddress.toLowerCase()]
        const symbol =
          knownToken?.symbol ?? transfer.tokenInfo?.symbol ?? transfer.tokenAddress
        const decimals = knownToken?.decimals ?? transfer.tokenInfo?.decimals ?? 18

        transactions.push({
          hash: transfer.transactionHash,
          type: 'erc20',
          from: transfer.from ?? '',
          to: transfer.to ?? '',
          value: transfer.value,
          valueFormatted: formatTokenValue(transfer.value, decimals),
          asset: symbol,
          decimals,
          direction: transfer.to?.toLowerCase() === addrLower ? 'in' : 'out',
          timestamp: parseIsoTimestamp(transfer.executionDate),
          blockNumber: transfer.blockNumber,
          isError: false,
          tokenAddress: transfer.tokenAddress,
          tokenSymbol: symbol,
        })
      }
    }

    transactions.sort(compareTransactions)

    const seen = new Set<string>()
    const deduped = transactions.filter((tx) => {
      const key = transactionDedupKey(tx)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    txCache.set(cacheKey, deduped)

    return {
      transactions: deduped,
      hadFailures,
    }
  })().finally(() => {
    txInflight.delete(cacheKey)
  })

  txInflight.set(cacheKey, requestPromise)
  return requestPromise
}

export function compareTransactions(a: Transaction, b: Transaction): number {
  return (
    b.timestamp - a.timestamp ||
    b.blockNumber - a.blockNumber ||
    a.hash.localeCompare(b.hash) ||
    a.type.localeCompare(b.type) ||
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to)
  )
}

function compareEnrichedTransactions(
  a: EnrichedTransaction,
  b: EnrichedTransaction,
): number {
  return compareTransactions(a, b) || a.safeAddress.localeCompare(b.safeAddress)
}

export function enrichedTransactionIdentityKey(tx: EnrichedTransaction): string {
  return [
    tx.chainId,
    tx.safeId,
    transactionDedupKey(tx),
  ].join(':')
}

function paymentAgentIdentityKey(
  txHash: string,
  safeId: string,
  chainId: number,
): string {
  return `${txHash.toLowerCase()}:${safeId}:${chainId}`
}

function x402FundingIdentityKey(tx: EnrichedTransaction): string {
  return paymentAgentIdentityKey(tx.hash, tx.safeId, tx.chainId)
}

export async function enrichTransactionsWithAgents(
  userId: string,
  transactions: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const txHashes = Array.from(
    new Set(transactions.map((tx) => tx.hash.toLowerCase())),
  )
  const safeIds = Array.from(
    new Set(transactions.map((tx) => tx.safeId).filter(Boolean)),
  )
  if (txHashes.length === 0 || safeIds.length === 0) return transactions

  try {
    const piResult = await pool.query<PaymentIntentAgentRow>(
      `SELECT pi.id,
              LOWER(pi.tx_hash) AS tx_hash,
              us.id AS safe_id,
              us.chain_id AS chain_id,
              pi.agent_id,
              a.name AS agent_name,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS payment_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS merchant_address,
              mpe.proof_status AS payment_proof_status,
              mpe.amount_sek AS amount_sek,
              mpre.event_type AS payment_reconciliation_event_type
       FROM payment_intents pi
       JOIN agents a ON a.id = pi.agent_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.payment_intent_id = pi.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       JOIN user_safes us
         ON us.user_id = pi.user_id
        AND us.id = ANY($3)
        AND LOWER(us.safe_address) = LOWER(pi.safe_address)
        AND pi.chain_id IS NOT NULL
        AND us.chain_id = pi.chain_id
       WHERE LOWER(pi.tx_hash) = ANY($1)
         AND pi.user_id = $2
         AND pi.status = 'confirmed'`,
      [txHashes, userId, safeIds],
    )

    const agentByTransactionIdentity = new Map<
      string,
      {
        id: string
        name: string
        source: string | null
        resourceUrl: string | null
        merchantAddress: string | null
        paymentId: string
        paymentProofStatus: string | null
        paymentFlowStatus: string | null
        paymentAttentionReason: string | null
        activityType?: 'delegate_sweep'
        amountSek: string | null
      }
    >()
    for (const row of piResult.rows) {
      const lifecycle = machinePaymentLifecycle({
        rail: row.source,
        paymentProofStatus: row.payment_proof_status,
        reconciliationEventType: row.payment_reconciliation_event_type,
      })
      agentByTransactionIdentity.set(
        paymentAgentIdentityKey(row.tx_hash, row.safe_id, row.chain_id),
        {
          id: row.agent_id,
          name: row.agent_name,
          source: row.source,
          resourceUrl: row.payment_resource_url,
          merchantAddress: row.merchant_address,
          paymentId: row.id,
          paymentProofStatus: row.payment_proof_status,
          paymentFlowStatus: lifecycle.paymentFlowStatus,
          paymentAttentionReason: lifecycle.paymentAttentionReason,
          amountSek: row.amount_sek,
        },
      )
    }

    const approvalResult = await pool.query<ApprovalRequestAgentRow>(
      `SELECT ar.id,
              LOWER(ar.tx_hash) AS tx_hash,
              us.id AS safe_id,
              us.chain_id AS chain_id,
              ar.agent_id,
              a.name AS agent_name,
              COALESCE(ar.payment_rail, ar.source, 'direct') AS source,
              COALESCE(ar.payment_resource_url, ar.x402_resource_url) AS payment_resource_url,
              ar.merchant_address,
              mpe.proof_status AS payment_proof_status,
              mpe.amount_sek AS amount_sek,
              mpre.event_type AS payment_reconciliation_event_type
       FROM approval_requests ar
       JOIN agents a ON a.id = ar.agent_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.approval_request_id = ar.id
       LEFT JOIN machine_payment_reconciliation_events mpre
         ON mpre.approval_request_id = ar.id
        AND mpre.status = 'open'
        AND mpre.event_type = 'merchant_retry_rejected_after_payment'
       JOIN user_safes us
         ON us.user_id = ar.user_id
        AND us.id = ANY($3)
        AND LOWER(us.safe_address) = LOWER(ar.safe_address)
        AND ar.chain_id IS NOT NULL
        AND us.chain_id = ar.chain_id
       WHERE LOWER(ar.tx_hash) = ANY($1)
         AND ar.user_id = $2
         AND COALESCE(ar.payment_rail, ar.source) = 'x402'
         AND ar.status = 'executed'`,
      [txHashes, userId, safeIds],
    )

    for (const row of approvalResult.rows) {
      const identityKey = paymentAgentIdentityKey(
        row.tx_hash,
        row.safe_id,
        row.chain_id,
      )
      if (agentByTransactionIdentity.has(identityKey)) continue
      const proofStatus = row.payment_proof_status ?? 'payment_confirmed'
      const lifecycle = machinePaymentLifecycle({
        rail: row.source,
        paymentProofStatus: proofStatus,
        reconciliationEventType: row.payment_reconciliation_event_type,
      })
      agentByTransactionIdentity.set(identityKey, {
        id: row.agent_id,
        name: row.agent_name,
        source: row.source,
        resourceUrl: row.payment_resource_url,
        merchantAddress: row.merchant_address,
        paymentId: row.id,
        paymentProofStatus: proofStatus,
        paymentFlowStatus: lifecycle.paymentFlowStatus,
        paymentAttentionReason: lifecycle.paymentAttentionReason,
        amountSek: row.amount_sek,
      })
    }

    const sweepResult = await pool.query<DelegateSweepAgentRow>(
      `SELECT ds.id,
              LOWER(ds.tx_hash) AS tx_hash,
              us.id AS safe_id,
              us.chain_id AS chain_id,
              ds.agent_id,
              a.name AS agent_name,
              ds.from_address,
              ds.to_address
       FROM delegate_sweeps ds
       JOIN agents a ON a.id = ds.agent_id
       JOIN user_safes us
         ON us.user_id = ds.user_id
        AND us.id = ANY($3)
        AND LOWER(us.safe_address) = LOWER(ds.to_address)
        AND us.chain_id = ds.chain_id
       WHERE LOWER(ds.tx_hash) = ANY($1)
         AND ds.user_id = $2
         AND ds.status = 'submitted'
         AND ds.tx_hash IS NOT NULL`,
      [txHashes, userId, safeIds],
    )

    for (const row of sweepResult.rows) {
      agentByTransactionIdentity.set(
        paymentAgentIdentityKey(row.tx_hash, row.safe_id, row.chain_id),
        {
          id: row.agent_id,
          name: row.agent_name,
          source: null,
          resourceUrl: null,
          merchantAddress: null,
          paymentId: row.id,
          paymentProofStatus: null,
          paymentFlowStatus: null,
          paymentAttentionReason: null,
          activityType: 'delegate_sweep',
          amountSek: null,
        },
      )
    }

    return transactions.map((tx) => {
      const agent = agentByTransactionIdentity.get(
        paymentAgentIdentityKey(tx.hash, tx.safeId, tx.chainId),
      )
      return {
        ...tx,
        agentId: agent?.id ?? tx.agentId,
        agentName: agent?.name ?? tx.agentName,
        source: agent?.source ?? tx.source,
        x402ResourceUrl: agent?.resourceUrl ?? tx.x402ResourceUrl,
        x402MerchantAddress: agent?.merchantAddress ?? tx.x402MerchantAddress,
        paymentId: agent?.paymentId ?? tx.paymentId,
        paymentProofStatus: agent?.paymentProofStatus ?? tx.paymentProofStatus,
        paymentFlowStatus: agent?.paymentFlowStatus ?? tx.paymentFlowStatus,
        paymentAttentionReason: agent?.paymentAttentionReason ?? tx.paymentAttentionReason,
        activityType: agent?.activityType ?? tx.activityType,
        amountSek: agent?.amountSek ?? tx.amountSek,
      }
    })
  } catch {
    return transactions
  }
}

export async function fetchConfirmedX402Transactions(
  userId: string,
  safes: UserSafeRow[],
): Promise<EnrichedTransaction[]> {
  if (safes.length === 0) return []

  const safeIds = safes.map((safe) => safe.id)
  const paymentIntentResult = await pool.query<X402PaymentIntentRow>(
    `SELECT pi.id,
            pi.tx_hash,
            pi.agent_id,
            a.name AS agent_name,
            us.id AS safe_id,
            us.safe_address,
            us.name AS safe_name,
            COALESCE(pi.chain_id, us.chain_id) AS chain_id,
            pi.token_symbol,
            pi.token_address,
            pi.to_address,
            pi.amount_raw,
            pi.amount_human,
            pi.x402_merchant_address,
            pi.x402_resource_url,
            mpe.proof_status AS payment_proof_status,
            mpe.amount_sek AS amount_sek,
            mpre.event_type AS payment_reconciliation_event_type,
            pi.confirmed_at,
            pi.created_at
     FROM payment_intents pi
     JOIN agents a ON a.id = pi.agent_id
     LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
     LEFT JOIN machine_payment_reconciliation_events mpre
       ON mpre.payment_intent_id = pi.id
      AND mpre.status = 'open'
      AND mpre.event_type = 'merchant_retry_rejected_after_payment'
     JOIN user_safes us
       ON us.user_id = pi.user_id
      AND us.id = ANY($2)
      AND LOWER(us.safe_address) = LOWER(pi.safe_address)
      AND pi.chain_id IS NOT NULL
      AND us.chain_id = pi.chain_id
     WHERE pi.user_id = $1
       AND pi.source = 'x402'
       AND pi.status = 'confirmed'
       AND pi.tx_hash IS NOT NULL
     ORDER BY COALESCE(pi.confirmed_at, pi.created_at) DESC`,
    [userId, safeIds],
  )

  const approvalResult = await pool.query<X402ApprovalRequestRow>(
    `SELECT ar.id,
            ar.tx_hash,
            ar.agent_id,
            a.name AS agent_name,
            us.id AS safe_id,
            us.safe_address,
            us.name AS safe_name,
            COALESCE(ar.chain_id, us.chain_id) AS chain_id,
            ar.token_symbol,
            ar.token_address,
            ar.to_address,
            ar.amount_raw,
            ar.amount_human,
            ar.merchant_address,
            COALESCE(ar.payment_resource_url, ar.x402_resource_url) AS payment_resource_url,
            mpe.proof_status AS payment_proof_status,
            mpe.amount_sek AS amount_sek,
            mpre.event_type AS payment_reconciliation_event_type,
            ar.executed_at,
            ar.created_at
     FROM approval_requests ar
     JOIN agents a ON a.id = ar.agent_id
     LEFT JOIN machine_payment_evidence mpe ON mpe.approval_request_id = ar.id
     LEFT JOIN machine_payment_reconciliation_events mpre
       ON mpre.approval_request_id = ar.id
      AND mpre.status = 'open'
      AND mpre.event_type = 'merchant_retry_rejected_after_payment'
     JOIN user_safes us
       ON us.user_id = ar.user_id
      AND us.id = ANY($2)
      AND LOWER(us.safe_address) = LOWER(ar.safe_address)
      AND ar.chain_id IS NOT NULL
      AND us.chain_id = ar.chain_id
     WHERE ar.user_id = $1
       AND COALESCE(ar.payment_rail, ar.source) = 'x402'
       AND ar.status = 'executed'
       AND ar.tx_hash IS NOT NULL
     ORDER BY COALESCE(ar.executed_at, ar.created_at) DESC`,
    [userId, safeIds],
  )

  const paymentIntentTransactions: EnrichedTransaction[] = paymentIntentResult.rows.map((row) => {
    const chain = getChain(row.chain_id)
    const tokenAddress = row.token_address.toLowerCase()
    const tokenConfig =
      chain.tokenByAddress[tokenAddress] ??
      Object.values(chain.tokens).find((token) => token.symbol === row.token_symbol)
    const merchantAddress = row.x402_merchant_address ?? row.to_address
    const proofStatus = row.payment_proof_status ?? 'payment_confirmed'
    const lifecycle = machinePaymentLifecycle({
      rail: 'x402',
      paymentProofStatus: proofStatus,
      reconciliationEventType: row.payment_reconciliation_event_type,
    })

    return {
      hash: row.tx_hash,
      type: 'erc20',
      from: row.safe_address,
      to: merchantAddress,
      value: row.amount_raw,
      valueFormatted: row.amount_human,
      asset: row.token_symbol,
      decimals: tokenConfig?.decimals ?? 18,
      direction: 'out',
      timestamp: parseIsoTimestamp(row.confirmed_at ?? row.created_at),
      blockNumber: 0,
      isError: false,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      source: 'x402',
      x402ResourceUrl: row.x402_resource_url,
      x402MerchantAddress: row.x402_merchant_address,
      chainId: row.chain_id,
      safeId: row.safe_id,
      safeAddress: row.safe_address,
      safeName: row.safe_name,
      agentId: row.agent_id,
      agentName: row.agent_name,
      paymentId: row.id,
      paymentProofStatus: proofStatus,
      paymentFlowStatus: lifecycle.paymentFlowStatus,
      paymentAttentionReason: lifecycle.paymentAttentionReason,
      amountSek: row.amount_sek,
    }
  })

  const approvalTransactions = approvalResult.rows.map((row) => {
    const chain = getChain(row.chain_id)
    const tokenAddress = row.token_address.toLowerCase()
    const tokenConfig =
      chain.tokenByAddress[tokenAddress] ??
      Object.values(chain.tokens).find((token) => token.symbol === row.token_symbol)
    const merchantAddress = row.merchant_address ?? row.to_address
    const proofStatus = row.payment_proof_status ?? 'payment_confirmed'
    const lifecycle = machinePaymentLifecycle({
      rail: 'x402',
      paymentProofStatus: proofStatus,
      reconciliationEventType: row.payment_reconciliation_event_type,
    })

    return {
      hash: row.tx_hash,
      type: 'erc20' as const,
      from: row.safe_address,
      to: merchantAddress,
      value: row.amount_raw,
      valueFormatted: row.amount_human,
      asset: row.token_symbol,
      decimals: tokenConfig?.decimals ?? 18,
      direction: 'out' as const,
      timestamp: parseIsoTimestamp(row.executed_at ?? row.created_at),
      blockNumber: 0,
      isError: false,
      tokenAddress: row.token_address,
      tokenSymbol: row.token_symbol,
      source: 'x402',
      x402ResourceUrl: row.payment_resource_url,
      x402MerchantAddress: row.merchant_address,
      chainId: row.chain_id,
      safeId: row.safe_id,
      safeAddress: row.safe_address,
      safeName: row.safe_name,
      agentId: row.agent_id,
      agentName: row.agent_name,
      paymentId: row.id,
      paymentProofStatus: proofStatus,
      paymentFlowStatus: lifecycle.paymentFlowStatus,
      paymentAttentionReason: lifecycle.paymentAttentionReason,
      amountSek: row.amount_sek,
    }
  })

  return [...paymentIntentTransactions, ...approvalTransactions]
}

export async function mergeX402Transactions(
  userId: string,
  safes: UserSafeRow[],
  transactions: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const x402Transactions = await fetchConfirmedX402Transactions(userId, safes)
  if (x402Transactions.length === 0) return transactions

  const x402FundingKeys = new Set(
    x402Transactions.map(x402FundingIdentityKey),
  )

  return [
    ...transactions.filter(
      (tx) => !x402FundingKeys.has(x402FundingIdentityKey(tx)),
    ),
    ...x402Transactions,
  ]
}

export default async function transactionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{
    Querystring: {
      safeId?: string
      agentId?: string
      tokenKey?: string
      offset?: string
      limit?: string
      fresh?: string
    }
  }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const offset = parsePositiveInt(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)

    if (offset === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (request.query.safeId && !UUID_RE.test(request.query.safeId)) {
      return reply.code(400).send({ error: 'Invalid safeId' })
    }

    if (
      request.query.agentId &&
      request.query.agentId !== 'user' &&
      !UUID_RE.test(request.query.agentId)
    ) {
      return reply.code(400).send({ error: 'Invalid agentId' })
    }

    const tokenFilter = parseTokenKey(request.query.tokenKey)
    if (request.query.tokenKey && !tokenFilter) {
      return reply.code(400).send({ error: 'Invalid tokenKey' })
    }

    const safeResult = await pool.query<UserSafeRow>(
      `SELECT id, safe_address, chain_id, name
       FROM user_safes
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [sub],
    )

    let safes = safeResult.rows

    if (request.query.safeId) {
      safes = safes.filter((safe) => safe.id === request.query.safeId)
      if (safes.length === 0) {
        return reply.code(400).send({ error: 'Invalid safeId' })
      }
    }

    if (request.query.agentId && request.query.agentId !== 'user') {
      const agentResult = await pool.query<{ id: string }>(
        'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
        [request.query.agentId, sub],
      )
      if (agentResult.rows.length === 0) {
        return reply.code(400).send({ error: 'Invalid agentId' })
      }
    }

    if (safes.length === 0) {
      return {
        transactions: [],
        total: 0,
        offset,
        limit,
        hasMore: false,
        partialFailure: false,
        failedSafeIds: [],
      }
    }

    const merged: EnrichedTransaction[] = []
    const failedSafeIds: string[] = []

    for (const safe of safes) {
      try {
        const { transactions, hadFailures } = await fetchSafeTransactions({
          safeId: safe.id,
          safeAddress: safe.safe_address,
          chainId: safe.chain_id,
          log: request.log,
          fresh,
        })

        if (hadFailures) {
          failedSafeIds.push(safe.id)
        }

        for (const tx of transactions) {
          merged.push({
            ...tx,
            chainId: safe.chain_id,
            safeId: safe.id,
            safeAddress: safe.safe_address,
            safeName: safe.name,
          })
        }
      } catch (err) {
        failedSafeIds.push(safe.id)
        request.log.warn(
          { err, safeId: safe.id, safeAddress: safe.safe_address, chainId: safe.chain_id },
          'Safe transaction aggregation failed',
        )
      }
    }

    const mergedWithX402 = await mergeX402Transactions(sub, safes, merged)

    mergedWithX402.sort(compareEnrichedTransactions)

    const seen = new Set<string>()
    const deduped = mergedWithX402.filter((tx) => {
      const key = enrichedTransactionIdentityKey(tx)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    const enriched = await enrichTransactionsWithAgents(sub, deduped)

    const filtered = enriched.filter((tx) => {
      if (request.query.agentId === 'user') {
        return tx.direction === 'out' && !tx.agentId
      }

      if (request.query.agentId && request.query.agentId !== 'user' && tx.agentId !== request.query.agentId) {
        return false
      }

      if (tokenFilter) {
        if (tx.chainId !== tokenFilter.chainId) return false
        if (tokenFilter.address === null) {
          if (tx.type === 'erc20') return false
        } else if (tx.type !== 'erc20' || tx.tokenAddress?.toLowerCase() !== tokenFilter.address) {
          return false
        }
      }

      return true
    })

    const paginated = filtered.slice(offset, offset + limit)

    return {
      transactions: paginated,
      total: filtered.length,
      offset,
      limit,
      hasMore: filtered.length > offset + paginated.length,
      partialFailure: failedSafeIds.length > 0,
      failedSafeIds: Array.from(new Set(failedSafeIds)),
    }
  })

  app.get<{ Params: { paymentId: string } }>(
    '/payment-intents/:paymentId/evidence',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { paymentId } = request.params

      if (!UUID_RE.test(paymentId)) {
        return reply.code(400).send({ error: 'Invalid paymentId' })
      }

      const result = await pool.query<MachinePaymentEvidenceDetailRow>(
        `SELECT mpe.id,
                mpe.payment_intent_id,
                mpe.approval_request_id,
                mpe.rail,
                mpe.proof_status,
                mpe.tx_hash,
                mpe.chain_id,
                mpe.resource_url,
                mpe.merchant_address,
                mpe.payer_address,
                mpe.settlement_address,
                mpe.token_symbol,
                mpe.token_address,
                mpe.amount_raw,
                mpe.amount_human,
                mpe.challenge_id,
                mpe.idempotency_key,
                mpe.challenge_payload,
                mpe.selected_payment,
                mpe.payment_proof_header_name,
                mpe.payment_proof_header,
                mpe.protocol_receipt_header_name,
                mpe.protocol_receipt_header,
                mpe.protocol_receipt_payload,
                mpe.merchant_status,
                mpe.confirmed_at,
                mpe.created_at,
                mpe.updated_at
         FROM machine_payment_evidence mpe
         LEFT JOIN payment_intents pi ON pi.id = mpe.payment_intent_id
         LEFT JOIN approval_requests ar ON ar.id = mpe.approval_request_id
         WHERE (mpe.payment_intent_id = $1 OR mpe.approval_request_id = $1)
           AND COALESCE(pi.user_id, ar.user_id) = $2
         LIMIT 1`,
        [paymentId, sub],
      )

      const evidence = result.rows[0]
      if (!evidence) {
        return reply.code(404).send({ error: 'Payment evidence not found' })
      }

      return {
        evidence: {
          id: evidence.id,
          payment_id: evidence.payment_intent_id ?? evidence.approval_request_id,
          payment_intent_id: evidence.payment_intent_id,
          approval_request_id: evidence.approval_request_id,
          rail: evidence.rail,
          proof_status: evidence.proof_status,
          tx_hash: evidence.tx_hash,
          chain_id: evidence.chain_id,
          resource_url: evidence.resource_url,
          merchant_address: evidence.merchant_address,
          payer_address: evidence.payer_address,
          settlement_address: evidence.settlement_address,
          token_symbol: evidence.token_symbol,
          token_address: evidence.token_address,
          amount_raw: evidence.amount_raw,
          amount_human: evidence.amount_human,
          challenge_id: evidence.challenge_id,
          idempotency_key: evidence.idempotency_key,
          challenge_payload: evidence.challenge_payload,
          selected_payment: evidence.selected_payment,
          payment_proof_header_name: evidence.payment_proof_header_name,
          payment_proof_header: evidence.payment_proof_header,
          protocol_receipt_header_name: evidence.protocol_receipt_header_name,
          protocol_receipt_header: evidence.protocol_receipt_header,
          protocol_receipt_payload: evidence.protocol_receipt_payload,
          merchant_status: evidence.merchant_status,
          confirmed_at: evidence.confirmed_at,
          created_at: evidence.created_at,
          updated_at: evidence.updated_at,
        },
      }
    },
  )

  app.get<{ Querystring: { fresh?: string } }>('/filters', async (request) => {
    const { sub } = request.user as { sub: string }
    const fresh = parseFreshFlag(request.query.fresh)

    const [safeResult, agentResult] = await Promise.all([
      pool.query<UserSafeRow>(
        `SELECT id, safe_address, chain_id, name
         FROM user_safes
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [sub],
      ),
      pool.query<{ id: string; name: string; status: string }>(
        `SELECT id, name, status
         FROM agents
         WHERE user_id = $1
         ORDER BY
           CASE status
             WHEN 'active' THEN 0
             WHEN 'paused' THEN 1
             ELSE 2
           END,
           created_at DESC`,
        [sub],
      ),
    ])

    const tokenOptions = new Map<
      string,
      { key: string; symbol: string; address: string | null; chainId: number; isNative: boolean }
    >()

    for (const safe of safeResult.rows) {
      const chain = getChain(safe.chain_id)
      const nativeToken = Object.values(chain.tokens).find((token) => token.address === null)!
      const nativeKey = `${safe.chain_id}:native`
      tokenOptions.set(nativeKey, {
        key: nativeKey,
        symbol: nativeToken.symbol,
        address: null,
        chainId: safe.chain_id,
        isNative: true,
      })
    }

    const tokenResults = await Promise.all(
      safeResult.rows.map(async (safe) => {
        try {
          const { transactions } = await fetchSafeTransactions({
            safeId: safe.id,
            safeAddress: safe.safe_address,
            chainId: safe.chain_id,
            log: request.log,
            fresh,
          })

          return { safe, transactions }
        } catch (err) {
          request.log.warn(
            { err, safeId: safe.id, safeAddress: safe.safe_address, chainId: safe.chain_id },
            'Transaction filter token collection failed',
          )
          return { safe, transactions: [] as Transaction[] }
        }
      }),
    )

    for (const { safe, transactions } of tokenResults) {
      for (const tx of transactions) {
        if (tx.type !== 'erc20' || !tx.tokenAddress) continue
        const key = `${safe.chain_id}:${tx.tokenAddress.toLowerCase()}`
        if (tokenOptions.has(key)) continue

        tokenOptions.set(key, {
          key,
          symbol: tx.asset,
          address: tx.tokenAddress.toLowerCase(),
          chainId: safe.chain_id,
          isNative: false,
        })
      }
    }

    try {
      const x402Transactions = await fetchConfirmedX402Transactions(sub, safeResult.rows)
      for (const tx of x402Transactions) {
        if (tx.type !== 'erc20' || !tx.tokenAddress) continue
        const key = `${tx.chainId}:${tx.tokenAddress.toLowerCase()}`
        if (tokenOptions.has(key)) continue

        tokenOptions.set(key, {
          key,
          symbol: tx.asset,
          address: tx.tokenAddress.toLowerCase(),
          chainId: tx.chainId,
          isNative: false,
        })
      }
    } catch (err) {
      request.log.warn(
        { err },
        'Transaction filter x402 token collection failed',
      )
    }

    const tokens = Array.from(tokenOptions.values()).sort((a, b) => {
      if (a.chainId !== b.chainId) return a.chainId - b.chainId
      if (a.isNative !== b.isNative) return a.isNative ? -1 : 1
      return a.symbol.localeCompare(b.symbol)
    })

    return {
      safes: safeResult.rows.map((safe) => ({
        id: safe.id,
        name: safe.name,
        address: safe.safe_address,
        chainId: safe.chain_id,
      })),
      agents: agentResult.rows,
      tokens,
    }
  })

  app.get<{
    Params: { safeAddress: string }
    Querystring: { page?: string; limit?: string; fresh?: string; chain_id?: string }
  }>('/:safeAddress', async (request, reply) => {
    const { safeAddress } = request.params
    const { sub } = request.user as { sub: string }
    const page = parsePositiveInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)
    const requestedChainId = parseChainId(request.query.chain_id)

    if (page === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (!ETH_ADDRESS_RE.test(safeAddress)) {
      return reply.code(400).send({ error: 'Invalid address' })
    }

    if (Number.isNaN(requestedChainId)) {
      return reply.code(400).send({ error: 'Invalid chain_id' })
    }

    if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
      return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
    }

    const ownershipSql = requestedChainId === null
      ? 'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)'
      : 'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3'
    const ownershipParams = requestedChainId === null
      ? [sub, safeAddress]
      : [sub, safeAddress, requestedChainId]
    const userResult = await pool.query<{ id: string; chain_id: number }>(
      ownershipSql,
      ownershipParams,
    )
    if (userResult.rows.length === 0) {
      return reply.code(403).send({ error: 'Not your Safe' })
    }
    if (requestedChainId === null && userResult.rows.length > 1) {
      return reply.code(400).send({ error: 'chain_id required' })
    }

    const safeId = userResult.rows[0].id
    const chainId = requestedChainId ?? userResult.rows[0].chain_id
    const { transactions: allTransactions } = await fetchSafeTransactions({
      safeId,
      safeAddress,
      chainId,
      log: request.log,
      fresh,
    })

    const userSafe = {
      id: safeId,
      safe_address: safeAddress,
      chain_id: chainId,
      name: '',
    }
    const enrichedAllTransactions = await mergeX402Transactions(
      sub,
      [userSafe],
      allTransactions.map((tx) => ({
        ...tx,
        chainId,
        safeId,
        safeAddress,
        safeName: '',
      })),
    )

    enrichedAllTransactions.sort(compareEnrichedTransactions)

    const total = enrichedAllTransactions.length
    const start = (page - 1) * limit
    const paginated = enrichedAllTransactions.slice(start, start + limit)

    const enriched = await enrichTransactionsWithAgents(
      sub,
      paginated,
    )

    return {
      transactions: enriched.map(
        ({ chainId: _chainId, safeId: _safeId, safeAddress: _safeAddress, safeName: _safeName, agentId: _agentId, ...tx }) => tx,
      ),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })
}
