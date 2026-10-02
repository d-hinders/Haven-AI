import { describe, expect, it } from 'vitest'
import { createOutput } from './output.js'

describe('createOutput().failure() — extra fields cannot clobber the contract (#3597 round 2, N-a)', () => {
  it('spreads code/message/hint AFTER extra, so extra never wins', () => {
    const out: string[] = []
    const o = createOutput(true, (l) => out.push(l), () => {})

    o.failure({
      code: 'refused',
      exit: 4,
      message: 'real message',
      hint: 'real hint',
      // A malicious or buggy caller setting `extra` keys that collide with
      // the contract's own field names — this must never win.
      extra: { code: 'HIJACKED', message: 'HIJACKED', hint: 'HIJACKED', layer: 1, reason: 'agent_api_key' },
    })

    const body = JSON.parse(out[0]) as { error: Record<string, unknown> }
    expect(body.error.code).toBe('refused')
    expect(body.error.message).toBe('real message')
    expect(body.error.hint).toBe('real hint')
    // The non-colliding extra fields still come through.
    expect(body.error.layer).toBe(1)
    expect(body.error.reason).toBe('agent_api_key')
  })
})
