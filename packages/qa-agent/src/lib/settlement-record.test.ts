/**
 * #4119: the pure halves of the settlement-record check — where an SDK-direct
 * leg finds the merchant's settlement hash, and the attribution window. The
 * status/receipt/guidance halves are exercised through the four scenarios
 * that use them, against their own stubs.
 */

import { describe, expect, it } from 'vitest'
import {
  ATTRIBUTION_WINDOW_MS,
  SWEEP_MIN_AGE_MS,
  attributionDeadline,
  merchantSettlementHashFrom,
} from './settlement-record.js'

const TX = '0x' + 'f2'.repeat(32)
const OTHER = '0x' + 'e9'.repeat(32)
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const headers = (value?: string) => new Headers(value ? { 'PAYMENT-RESPONSE': value } : {})
const meta = (transaction: unknown) => ({ _meta: { 'x402/payment-response': { success: true, transaction } } })

describe('the attribution window', () => {
  it('is the sweep floor minus a 15 s margin — 45 s after the anchor', () => {
    expect(SWEEP_MIN_AGE_MS).toBe(60_000)
    expect(ATTRIBUTION_WINDOW_MS).toBe(45_000)
    expect(attributionDeadline(1_000)).toBe(46_000)
  })
})

describe('merchantSettlementHashFrom', () => {
  it('reads PAYMENT-RESPONSE with the SDK decoder', () => {
    expect(merchantSettlementHashFrom(headers(encode({ success: true, transaction: TX })), '')).toEqual({
      hash: TX,
      source: 'PAYMENT-RESPONSE',
    })
  })

  it('prefers the header over the tool result _meta', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: meta(OTHER) })
    expect(merchantSettlementHashFrom(headers(encode({ transaction: TX })), body)?.hash).toBe(TX)
  })

  it('falls back to _meta inside a JSON-RPC envelope', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: meta(TX) })
    expect(merchantSettlementHashFrom(headers(), body)).toEqual({ hash: TX, source: '_meta' })
  })

  it('falls back to _meta on the bare result the SDK surfaces from SSE', () => {
    expect(merchantSettlementHashFrom(headers(), JSON.stringify(meta(TX)))?.hash).toBe(TX)
  })

  it('falls back to _meta inside raw SSE data lines', () => {
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: meta(TX) })}\n\n`
    expect(merchantSettlementHashFrom(headers(), body)?.hash).toBe(TX)
  })

  it('falls back when the header names no well-formed transaction', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: meta(TX) })
    expect(merchantSettlementHashFrom(headers(encode({ transaction: '0x1234' })), body)?.source).toBe('_meta')
  })

  it('never takes the zero hash — the demo merchant marks delivered-not-settled with it', () => {
    const zero = '0x' + '0'.repeat(64)
    expect(merchantSettlementHashFrom(headers(encode({ transaction: zero })), JSON.stringify(meta(zero)))).toBeNull()
  })

  it('answers null when neither source names a transaction', () => {
    expect(merchantSettlementHashFrom(headers(), JSON.stringify({ content: [{ text: 'ok' }] }))).toBeNull()
    expect(merchantSettlementHashFrom(headers(), 'not json')).toBeNull()
  })
})
