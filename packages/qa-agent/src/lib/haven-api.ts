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
  sign_data?: { hash: string; components?: Record<string, unknown> }
  expires_at?: string
  message?: string
  error?: string
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
}

export interface X402AuthorizeBody {
  url: string
  payTo: string
  amount: string // atomic units
  asset: string // token contract address
  network: string // CAIP-2 (e.g. eip155:84532) or x402 network name
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

export class HavenApi {
  constructor(private readonly cfg: QaConfig) {}

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.agentApiKey}`,
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
