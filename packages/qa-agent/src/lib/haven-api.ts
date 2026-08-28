/**
 * Minimal typed client for the Haven money-movement API, used by the
 * deterministic QA scenarios (#575). Mirrors the proven flow in
 * `packages/backend/scripts/test-payment-flow.ts`:
 *   POST /payments → sign the returned hash with the delegate key →
 *   POST /payments/:id/sign → poll GET /payments/:id.
 *
 * Server-to-server (Node → API, Bearer agent key) — no browser, no CORS.
 */

import { ethers } from 'ethers'
import type { QaConfig } from '../config.js'

export interface CreatePaymentResult {
  payment_id: string
  status: string
  sign_data?: {
    hash: string
    /** Delegation rail (#2016): `eip712_userop` — the account validates the typed data. */
    signature_scheme?: string
    typed_data?: TypedDataPayload
    components?: Record<string, unknown>
  }
  expires_at?: string
  message?: string
  error?: string
  /** Present on a delegation-rail 502: the bundler/simulation failure (#2016). */
  details?: string
}

export interface PaymentStatus {
  status: string
  tx_hash?: string
  error_message?: string
  /** Present on a 502 from /sign — the on-chain execution failure reason. */
  error?: string
  details?: string
}

export interface X402AuthorizeResult {
  /** Present only when the request produced a signable/executable intent. */
  payment_id?: string
  status?: string
  error?: string
  error_code?: string
  phase?: string
  shortfall?: number | string
  remaining_allowance?: number | string
  /**
   * Present on the #2082 erc7710 over-budget refusal (403
   * `delegation_budget_exceeded`): the live remaining period budget and the
   * shortfall, atomic units. The leg compares `remaining_atomic` against the
   * number it derived the request from — a refusal quoting some other budget
   * is a refusal about some other delegation.
   */
  remaining_atomic?: string
  shortfall_atomic?: string
  /** Present on a delegation-rail 502: the bundler/simulation failure (#2016). */
  details?: string
  /** erc7710 direct settlement (#1064): the child-delegation typed data the delegate signs. */
  sign_data?: { signature_scheme?: string; typed_data?: TypedDataPayload }
}

export interface TypedDataPayload {
  domain: Record<string, unknown>
  types: Record<string, Record<string, unknown>[]>
  primaryType: string
  message: Record<string, unknown>
}

export interface X402AuthorizeBody {
  url: string
  payTo: string
  /**
   * EIP-3009 bridge shape (#946): `payTo` is the agent's own delegate EOA (the
   * funding target) and this is the real merchant. The pair is how a client
   * SAYS which settlement scheme it wants.
   */
  merchantPayTo?: string
  /** Validated against the payTo shape; sent explicitly rather than inferred (#1360). */
  settlementScheme?: string
  amount: string // atomic units
  asset: string // token contract address
  network: string // CAIP-2 (e.g. eip155:84532) or x402 network name
  /** Echoed to the merchant in the v2 header — pass the QUOTED value (#1064). */
  maxTimeoutSeconds?: number
  /** #1058: the challenge entry's extra.facilitatorAddresses, forwarded
   *  VERBATIM — pins the settlement child's redeemer caveat and rides the
   *  header echo (the v2 matcher requires it as a subset). */
  facilitatorAddresses?: string[]
}

export interface ApiResponse<T> {
  ok: boolean
  status: number
  data: T
}

/**
 * Sign a 32-byte hash with raw ECDSA (no Ethereum message prefix) — what the
 * AllowanceModule's signature check expects. Serialized as r‖s‖v (v = 27/28).
 */
export function signHash(privateKey: string, hash: string): string {
  return new ethers.SigningKey(privateKey).sign(hash).serialized
}

/** One `machine_payment_evidence` row as `GET /machine-payments/receipts` returns it. */
export interface MachinePaymentReceipt {
  payment_id?: string
  rail?: string
  tx_hash?: string
  resource_url?: string
  merchant_address?: string | null
  /**
   * The address Haven's own transfer went TO — which is the whole point on the
   * x402 two-leg: it is the FUNDING target (the delegate EOA), not the
   * merchant. The security model requires these be recorded separately
   * precisely so a funding hop can never be mistaken for a merchant payment.
   */
  settlement_address?: string | null
  payer_address?: string | null
  amount_human?: string
  /** Which settlement branch ran (eip3009 | erc7710) — the intent's recorded scheme (#946), joined into the evidence row. */
  settlement_scheme?: string | null
  /** The RAW x402 402-challenge body the merchant sent (error/accepts/resource/x402Version) — NOT Haven metadata. */
  challenge_payload?: Record<string, unknown> | null
  created_at?: string
}

/**
 * One `GET /catalog` row (#1299) as far as the guided-catalog-purchase QA
 * scenario needs it — chain-scoped for free by the backend when the request
 * is agent-authenticated, same as every other agent-facing catalog read.
 */
export interface CatalogEntry {
  id: string
  name: string
  resource_url: string
  protocol?: string | null
  tool_name?: string | null
  tool_arguments?: Record<string, unknown> | null
  status?: string
}

/** `GET /machine-payments/allowances` as the over-budget legs need it (#2016). */
export interface AgentAllowancesResponse {
  allowances?: {
    token_symbol?: string
    configured_amount?: string
    onchain?: {
      /** Atomic units. */
      remaining?: string
      /** False when the live enforcer read failed and this is a fallback. */
      remaining_is_from_chain?: boolean
    }
  }[]
  error?: string
}

export class HavenApi {
  /**
   * @param apiKey delegation-agent identity; API identity is never inferred
   *   from the QA config because every scenario chooses its own rail identity.
   */
  constructor(
    private readonly cfg: QaConfig,
    private readonly apiKey: string,
  ) {}

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: T
    try {
      data = (text ? JSON.parse(text) : {}) as T
    } catch {
      data = { raw: text } as unknown as T
    }
    return { ok: res.ok, status: res.status, data }
  }

  createPayment(token: string, amount: string, to: string): Promise<ApiResponse<CreatePaymentResult>> {
    return this.call('POST', '/payments', { token, amount, to })
  }

  signPayment(id: string, signature: string): Promise<ApiResponse<PaymentStatus>> {
    return this.call('POST', `/payments/${id}/sign`, { signature })
  }

  getPayment(id: string): Promise<ApiResponse<PaymentStatus>> {
    return this.call('GET', `/payments/${id}`)
  }

  authorizeX402(body: X402AuthorizeBody): Promise<ApiResponse<X402AuthorizeResult>> {
    return this.call('POST', '/x402/authorize', body as unknown as Record<string, unknown>)
  }

  /** erc7710 step 2 (#1064): exchange the signed child delegation for the merchant header. */
  settleX402(id: string, signature: string): Promise<ApiResponse<{ payment_header?: string; error?: string }>> {
    return this.call('POST', `/x402/${id}/settle`, { signature })
  }

  /** Payment evidence for this agent, newest first. */
  listReceipts(limit = 5): Promise<ApiResponse<{ receipts?: MachinePaymentReceipt[] }>> {
    return this.call('GET', `/machine-payments/receipts?limit=${limit}`)
  }

  /**
   * The agent's chain-scoped merchant catalog (#1299). Read-only; used by the
   * guided-catalog-purchase scenario to RESOLVE a catalog_id by matching
   * resource_url/tool_name/tool_arguments, rather than hardcoding a UUID that
   * would silently go stale the moment the seed migration is re-run.
   */
  getCatalog(): Promise<ApiResponse<{ entries?: CatalogEntry[] }>> {
    return this.call('GET', '/catalog')
  }

  /**
   * The agent's on-chain budget as the backend reads it (#2016).
   *
   * `onchain.remaining` on the delegation rail comes from a live
   * ERC20PeriodTransferEnforcer read, and `remaining_is_from_chain` says so.
   * An over-budget scenario needs both: the number to build an amount that is
   * genuinely over the budget, and the provenance flag to know the number is
   * the chain's rather than a fallback echo of the configured budget.
   */
  getAllowances(): Promise<ApiResponse<AgentAllowancesResponse>> {
    return this.call('GET', '/machine-payments/allowances')
  }

  /** This agent's own identity, including the account holding the funds. */
  getAgent(): Promise<
    ApiResponse<{ id?: string; safe_address?: string; delegate_address?: string; chain_id?: number }>
  > {
    return this.call('GET', '/machine-payments/agent')
  }

  /** Poll a payment to a terminal state (confirmed / failed / expired). */
  async pollUntilSettled(id: string, timeoutMs = 90_000, intervalMs = 3_000): Promise<PaymentStatus> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const { ok, data } = await this.getPayment(id)
      if (ok && ['confirmed', 'failed', 'expired'].includes(data.status)) return data
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for payment ${id} to settle`)
  }
}
