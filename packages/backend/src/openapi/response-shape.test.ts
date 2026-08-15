/**
 * Guards for the response-shape helper itself (#1444).
 *
 * The helper is a gate, so it needs the same treatment every gate in this repo
 * gets: proof that it can fail, and proof that it does not fail on things that
 * are actually valid. The second half is what these tests are mostly about —
 * a false failure in a contract test is expensive, because the natural
 * reaction is to loosen the spec until the noise stops.
 */

import { describe, expect, it } from 'vitest'
import { openapiSpec } from './spec.js'
import { __closeObjectsForTest, matchSpec, responseSchema } from './response-shape.js'

type Json = Record<string, unknown>

describe('closeObjects (#1444)', () => {
  it('closes a plain object schema that states no preference', () => {
    const closed = __closeObjectsForTest({
      type: 'object',
      properties: { a: { type: 'string' } },
    }) as Json
    expect(closed.additionalProperties).toBe(false)
  })

  it('keeps an explicitly open schema open', () => {
    const closed = __closeObjectsForTest({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: true,
    }) as Json
    expect(closed.additionalProperties).toBe(true)
  })

  it('never closes an allOf member — the composition trap', () => {
    // Each member declares only its own half. Closing either one makes it
    // reject the other's property, and a valid payload fails.
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    }
    const closed = __closeObjectsForTest(schema) as { allOf: Json[] }
    expect(closed.allOf[0].additionalProperties).toBeUndefined()
    expect(closed.allOf[1].additionalProperties).toBeUndefined()

    // The property that actually matters: the composed payload validates.
    expect(matchSpec(schema as Json, { a: 'x', b: 'y' })).toEqual([])
  })

  it('leaves a schema that composes with allOf at its own level open', () => {
    const closed = __closeObjectsForTest({
      type: 'object',
      properties: { a: { type: 'string' } },
      allOf: [{ type: 'object', properties: { b: { type: 'string' } } }],
    }) as Json
    expect(closed.additionalProperties).toBeUndefined()
  })

  it('still catches what the schema does promise inside an allOf', () => {
    // Leaving allOf members open must not turn the whole branch into a shrug:
    // required fields and types are still enforced.
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    }
    expect(matchSpec(schema as Json, { a: 'x' })).not.toEqual([])
    expect(matchSpec(schema as Json, { a: 'x', b: 'not-a-number' })).not.toEqual([])
  })

  it('does not mutate the shared spec object', () => {
    // `openapiSpec` is the object served at /openapi.json. A test helper that
    // mutated it would be a production bug, not a test bug.
    const before = JSON.stringify(openapiSpec)
    matchSpec(responseSchema('GET', '/agents'), { agents: [] })
    expect(JSON.stringify(openapiSpec)).toBe(before)
  })
})

describe('responseSchema (#1444)', () => {
  it('throws for an undocumented path rather than passing vacuously', () => {
    expect(() => responseSchema('GET', '/not-a-real-path')).toThrow(/no path/)
  })

  it('throws for a documented path with no such operation', () => {
    expect(() => responseSchema('PATCH', '/agents')).toThrow(/no PATCH operation/)
  })

  it('throws for an undeclared status code', () => {
    expect(() => responseSchema('GET', '/agents', '418')).toThrow(/no '418' response/)
  })
})
