/**
 * #1464 — malformed uuid path params must be a documented 4xx, not a 500.
 *
 * The handler is exercised through a real Fastify instance rather than by
 * calling the function directly: the defect lived in the wiring (an uncaught
 * pg error reaching the generic 500 path), so the test goes through the same
 * wiring.
 */
import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'
import { httpErrorHandler } from '../http-error-handler.js'

function appThrowing(error: unknown) {
  const app = Fastify({ logger: false })
  app.setErrorHandler(httpErrorHandler)
  app.get('/boom', async () => {
    throw error
  })
  return app
}

/** The exact shape node-postgres raises for invalid_text_representation. */
function pg22P02() {
  const err = new Error(
    'invalid input syntax for type uuid: "not-a-uuid"',
  ) as Error & { code: string }
  err.code = '22P02'
  return err
}

describe('httpErrorHandler (#1464)', () => {
  it('maps Postgres 22P02 to a 400 naming the problem, not a 500', async () => {
    const app = appThrowing(pg22P02())
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ statusCode: 400 })
    expect(res.json().error).toMatch(/Invalid identifier format/)
    // The raw Postgres message must NOT leak — it names column types and is
    // the kind of internals a 500 body was already hiding.
    expect(JSON.stringify(res.json())).not.toMatch(/invalid input syntax/)
    await app.close()
  })

  it('still returns 500 with a generic body for an unknown error — unchanged', async () => {
    // Characterization of the pre-#1464 behaviour for everything else: the
    // extraction must not have changed the generic path.
    const app = appThrowing(new Error('database exploded'))
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'Internal server error', statusCode: 500 })
    await app.close()
  })

  it('still passes through a statusCode-carrying client error — unchanged', async () => {
    const err = new Error('Payment intent not found') as Error & { statusCode: number }
    err.statusCode = 404
    const app = appThrowing(err)
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'Payment intent not found', statusCode: 404 })
    await app.close()
  })

  it('a 22P02 from a NON-uuid cast stays a 500 — scoped on purpose', async () => {
    // #1464 review: an int/enum/jsonb 22P02 can come from a SERVER-computed
    // value, and mapping it to 400 would blame the client for a server bug.
    const err = new Error('invalid input syntax for type integer: "abc"') as Error & { code: string }
    err.code = '22P02'
    const app = appThrowing(err)
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    await app.close()
  })

  it('does not treat a NON-pg error that happens to have a code as 22P02', async () => {
    const err = new Error('some lib error') as Error & { code: string }
    err.code = 'ERR_SOMETHING'
    const app = appThrowing(err)
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    await app.close()
  })
})
