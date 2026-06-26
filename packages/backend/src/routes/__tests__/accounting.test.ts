import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

/**
 * Route-level invariants for the accounting surface (`/accounting`).
 *
 * Covers auth, the legacy-export gate, ISO-date validation, BAS-account
 * validation, and per-user scoping of the merchant override CRUD. The accounting
 * lib seams (entry builder, SIE exporter, reconciler) are stubbed — this suite
 * asserts the route wiring, not the lib internals. `/export` is the legacy SIE
 * surface (gated off by default, superseded by the reporting feed), so it is
 * covered only at the auth + gate boundary, not its serialized body.
 */

const { configMock } = vi.hoisted(() => ({
  configMock: { legacyBookkeepingEnabled: false },
}))
vi.mock('../../config.js', () => ({ config: configMock }))

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))

const { buildAccountingEntries } = vi.hoisted(() => ({ buildAccountingEntries: vi.fn() }))
vi.mock('../../lib/accounting-entry.js', () => ({ buildAccountingEntries }))

const { sieExport } = vi.hoisted(() => ({ sieExport: vi.fn() }))
vi.mock('../../lib/sie-exporter.js', () => ({ sieExporter: { export: sieExport } }))

const { reconcileEntries } = vi.hoisted(() => ({ reconcileEntries: vi.fn() }))
vi.mock('../../lib/reconcile.js', () => ({ reconcileEntries }))

import accountingRoutes from '../accounting.js'

const USER = 'user-1'

// Faithful to the real `ReconcileReport` shape (lib/reconcile.ts): the route
// returns this verbatim, so the mock must mirror it or the suite documents a
// contract the implementation never produces.
const EMPTY_REPORT = {
  total: 0,
  ok: 0,
  issues: 0,
  byStatus: { ok: 0, missing_fx: 0, missing_tx: 0, unbalanced: 0 },
  items: [],
}

describe('accounting routes — route-level invariants', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(accountingRoutes, { prefix: '/accounting' })
    token = app.jwt.sign({ sub: USER, email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    configMock.legacyBookkeepingEnabled = false
    mockQuery.mockReset().mockResolvedValue({ rows: [] })
    buildAccountingEntries.mockReset().mockResolvedValue([])
    sieExport.mockReset().mockReturnValue({
      content: 'SIE-CONTENT',
      mimeType: 'text/plain; charset=utf-8',
      filename: 'haven.sie',
      entryCount: 0,
      skipped: 0,
    })
    reconcileEntries.mockReset().mockReturnValue(EMPTY_REPORT)
  })

  const authed = (method: 'GET' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as never })

  // --- auth boundary -------------------------------------------------------

  it.each([
    ['GET', '/accounting/export'],
    ['GET', '/accounting/reconcile'],
    ['GET', '/accounting/categories'],
    ['PUT', '/accounting/categories'],
    ['DELETE', '/accounting/categories'],
  ] as const)('%s %s requires authentication', async (method, url) => {
    const res = await app.inject({ method, url })
    expect(res.statusCode).toBe(401)
  })

  // --- GET /export (legacy: auth + gate only) ------------------------------

  it('GET /export returns 410 while legacy bookkeeping is disabled (default)', async () => {
    const res = await authed('GET', '/accounting/export')
    expect(res.statusCode).toBe(410)
    expect(buildAccountingEntries).not.toHaveBeenCalled()
  })

  it('GET /export rejects an unsupported format with 400 once enabled', async () => {
    configMock.legacyBookkeepingEnabled = true
    const res = await authed('GET', '/accounting/export?format=csv')
    expect(res.statusCode).toBe(400)
  })

  it('GET /export rejects a malformed "from" date with 400 once enabled', async () => {
    configMock.legacyBookkeepingEnabled = true
    const res = await authed('GET', '/accounting/export?from=not-a-date')
    expect(res.statusCode).toBe(400)
    expect(buildAccountingEntries).not.toHaveBeenCalled()
  })

  // --- GET /reconcile ------------------------------------------------------

  it('GET /reconcile rejects a malformed "to" date with 400 before building entries', async () => {
    const res = await authed('GET', '/accounting/reconcile?to=2026/01/01')
    expect(res.statusCode).toBe(400)
    expect(buildAccountingEntries).not.toHaveBeenCalled()
  })

  it('GET /reconcile builds entries scoped to the caller and returns the reconcile result', async () => {
    const res = await authed('GET', '/accounting/reconcile?from=2026-01-01&to=2026-03-31')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(EMPTY_REPORT)
    expect(buildAccountingEntries).toHaveBeenCalledWith({ userId: USER, from: '2026-01-01', to: '2026-03-31' })
  })

  // --- GET /categories (user scoping) --------------------------------------

  it('GET /categories returns the caller-scoped overrides', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ resource_url: 'https://api.x', bas_account: '4000' }] })
    const res = await authed('GET', '/accounting/categories')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ overrides: [{ resource_url: 'https://api.x', bas_account: '4000' }] })
    // Scoped by the JWT subject — never a client-supplied id.
    const [, params] = mockQuery.mock.calls[0]
    expect(params).toEqual([USER])
  })

  it('GET /categories scopes the query to the *calling* user, not a shared id', async () => {
    // A different JWT subject must drive a different SQL scope — proving one
    // user can never read another's overrides through this route.
    const otherToken = app.jwt.sign({ sub: 'user-2', email: 'grace@example.com' })
    const res = await app.inject({
      method: 'GET',
      url: '/accounting/categories',
      headers: { authorization: `Bearer ${otherToken}` },
    })
    expect(res.statusCode).toBe(200)
    const [, params] = mockQuery.mock.calls[0]
    expect(params).toEqual(['user-2'])
  })

  // --- PUT /categories -----------------------------------------------------

  it('PUT /categories requires a resourceUrl', async () => {
    const res = await authed('PUT', '/accounting/categories', { account: '4000' })
    expect(res.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('PUT /categories rejects a non-BAS account number', async () => {
    const res = await authed('PUT', '/accounting/categories', { resourceUrl: 'https://api.x', account: 'nope' })
    expect(res.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('PUT /categories upserts the override scoped to the caller', async () => {
    const res = await authed('PUT', '/accounting/categories', { resourceUrl: ' https://api.x ', account: ' 4000 ' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ resourceUrl: 'https://api.x', account: '4000' })
    const [, params] = mockQuery.mock.calls[0]
    expect(params).toEqual([USER, 'https://api.x', '4000'])
  })

  // --- DELETE /categories --------------------------------------------------

  it('DELETE /categories requires a resourceUrl', async () => {
    const res = await authed('DELETE', '/accounting/categories')
    expect(res.statusCode).toBe(400)
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('DELETE /categories clears the override scoped to the caller and returns 204', async () => {
    const res = await authed('DELETE', '/accounting/categories?resourceUrl=https://api.x')
    expect(res.statusCode).toBe(204)
    const [, params] = mockQuery.mock.calls[0]
    expect(params).toEqual([USER, 'https://api.x'])
  })
})
