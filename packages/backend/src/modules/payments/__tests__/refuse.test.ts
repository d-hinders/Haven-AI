/**
 * The refuse() choke point (#3053, slice 2 of epic #3056) — the contract
 * tests for modules/payments/refuse.ts.
 *
 * The one rule under test: a ledger write must never be able to change,
 * delay, or block the refusal response it records (#2945's invariant,
 * re-proven at the choke point every writer now goes through). refuse()
 * records fire-and-forget and returns the caller's already-decided response
 * untouched — identity-pinned here with the recorder succeeding, rejecting,
 * and throwing synchronously (the last one guards the recorder's OWN
 * detach discipline: if someone un-detaches the write inside
 * refusal-ledger.ts, the choke point still cannot let it surface).
 *
 * The recorder is mocked; the recorder's own contract (sync return, detached
 * write, swallowed failure) is refusal-ledger.test.ts's subject on the real
 * harness — this file owns what the choke point adds on top: the two
 * response shapes, the null-ledger escape for allowlisted sites, and the
 * already-sent reply case.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { FastifyReply } from 'fastify'

const { mockRecordRefusal } = vi.hoisted(() => ({ mockRecordRefusal: vi.fn() }))

vi.mock('../refusal-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../refusal-ledger.js')>()
  return { ...actual, recordRefusalFireAndForget: (...a: unknown[]) => mockRecordRefusal(...a) }
})

import { refuse } from '../refuse.js'
import type { RefusalReplyLike } from '../refuse.js'

const ledger = {
  userId: 'u-1',
  agentId: 'a-1',
  chainId: 8453,
  tokenSymbol: 'USDC',
  amountAtomic: '1000000',
  accountAddress: '0xabc',
  merchantTo: '0xmerch',
  resourceUrl: 'https://resource.example/x',
  reason: 'no_delegation_for_target' as const,
  source: 'payment' as const,
  detail: { error_code: 'no_delegation_for_target' },
}

/** A minimal coded-not-sent reply shaped like FastifyReply's relevant face. */
function fakeReply(sent = false): RefusalReplyLike & { codedStatus?: number; sentPayload?: unknown } {
  const reply: RefusalReplyLike & { codedStatus?: number; sentPayload?: unknown } = {
    sent,
    codedStatus: undefined,
    sentPayload: undefined,
    code(statusCode: number) {
      reply.codedStatus = statusCode
      return reply
    },
    send(payload?: unknown) {
      reply.sentPayload = payload
      return reply
    },
  }
  return reply
}

beforeEach(() => {
  mockRecordRefusal.mockReset()
  mockRecordRefusal.mockImplementation(() => undefined)
})

describe('refuse() — the decided { code, body } shape', () => {
  it('returns the SAME response object and records the ledger row once', () => {
    const response = { code: 403, body: { error: 'no active budget delegation' } }
    const returned = refuse(response, ledger)
    expect(returned).toBe(response)
    expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
    expect(mockRecordRefusal).toHaveBeenCalledWith(ledger)
  })

  it('returns the response unchanged when the ledger input is null (allowlisted site)', () => {
    const response = { code: 502, body: { error: 'Could not build the settlement delegation' } }
    const returned = refuse(response, null)
    expect(returned).toBe(response)
    expect(mockRecordRefusal).not.toHaveBeenCalled()
  })
})

describe('refuse() — the reply shape', () => {
  it('returns the coded reply untouched and records once', () => {
    const reply = fakeReply()
    reply.code(429)
    reply.send({ error: 'rate limited' })
    const returned = refuse(reply, ledger)
    expect(returned).toBe(reply)
    expect(reply.codedStatus).toBe(429)
    expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
    expect(mockRecordRefusal).toHaveBeenCalledWith(ledger)
  })

  it('records even when the reply reports sent — the send IS the caller\'s decision mechanism', () => {
    // Fastify flips `sent` synchronously inside `.send()`, and in the reply
    // form the handler sends INSIDE its own argument expression — so a reply
    // reaching refuse() always reports sent. Gating the write on
    // `!sent` would skip every real writer (caught by the #2945 route
    // characterization suite during #3053); the write is unconditional.
    const reply = fakeReply(true)
    const returned = refuse(reply, ledger)
    expect(returned).toBe(reply)
    expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
    expect(mockRecordRefusal).toHaveBeenCalledWith(ledger)
  })

  it('a Fastify reply satisfies the structural minimum (the #994 boundary, pinned from the type)', () => {
    // Compile-side pin: FastifyReply is assignable to RefusalReplyLike, so
    // refuse.ts needs no fastify import. Runtime runs the same path through
    // the structural fake.
    const fastifyLike = fakeReply() as unknown as FastifyReply
    const returned = refuse(fastifyLike, ledger)
    expect(returned).toBe(fastifyLike)
    expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
  })
})

describe('refuse() — the ledger can never change the refusal', () => {
  it('a recorder whose write rejects asynchronously cannot alter the response', () => {
    // The real recorder swallows its own failures; simulate the failure
    // reaching the choke point anyway. refuse() discards the recorder's
    // return, so nothing can propagate into the handler.
    mockRecordRefusal.mockImplementation(() => {
      void Promise.reject(new Error('ledger down')).catch(() => undefined)
    })
    const response = { code: 403, body: { error: 'refused' } }
    const returned = refuse(response, ledger)
    expect(returned).toBe(response)
  })

  it('a recorder that throws SYNCHRONOUSLY cannot alter the response either', () => {
    // Guards the detach discipline itself: refusal-ledger.ts's recorder is
    // `void writeRefusal(input).catch(...)` and cannot throw sync today, but
    // if that detach ever regresses, the choke point — not the refusal
    // response — is where the failure must stop. The throw is observed as
    // the swallowed console.error, nothing propagates to the caller.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockRecordRefusal.mockImplementation(() => {
      throw new Error('recorder detached its write and threw')
    })
    const response = { code: 429, body: { error: 'rate limited' } }
    const returned = refuse(response, ledger)
    expect(returned).toBe(response)
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0]?.[0])).toContain('threw synchronously')
    errSpy.mockRestore()
  })

  it('the write is issued synchronously — no await sits between decision and return', () => {
    // refuse() is not async and does not defer the record call: by the time
    // it returns, the recorder has already been invoked (fire-and-forget,
    // never awaited).
    let called = false
    mockRecordRefusal.mockImplementation(() => {
      called = true
    })
    const response = { code: 403, body: { error: 'refused' } }
    refuse(response, ledger)
    expect(called).toBe(true)
  })
})
