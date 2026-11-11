/**
 * #4790 (epic #4788 slice 2): the local mapper's typed-refusal answers, and
 * the generic answer it must keep for everything else.
 *
 * The cross-package parity test
 * (`packages/mcp-server/src/local-hosted-refusal-parity.test.ts`) holds the
 * typed answers equal to the hosted mapper's on the fixture bodies. This file
 * pins the two behaviours that parity test deliberately does not cover: an
 * unknown `error_code` still produces today's generic local answer, and a body
 * carrying its own `next_action` with no typed code still has it passed
 * through.
 */
import { describe, expect, it } from 'vitest'
import { HavenApiError } from '@haven_ai/sdk'
import { createToolHandlers } from './tools.js'

const SEND_ARGS = { asset: 'USDC', recipient: `0x${'1'.repeat(40)}`, amount: '1' }

/** The local `haven_send` answer for a client whose `pay` throws `thrown`. */
async function sendAnswer(thrown: unknown): Promise<Record<string, unknown>> {
  const client = new Proxy(
    {},
    {
      get: (_target, prop) => async () => {
        if (prop === 'pay') throw thrown
        throw new Error(`the local haven_send handler reached the client (${String(prop)})`)
      },
    },
  )
  const handlers = createToolHandlers(client as never) as Record<string, (input: unknown) => Promise<unknown>>
  return (await handlers.haven_send(SEND_ARGS)) as Record<string, unknown>
}

describe('#4790 the local mapper types the backend refusal codes', () => {
  it('an unknown error_code keeps the generic API_ERROR answer', async () => {
    const out = await sendAnswer(new HavenApiError('refused', 409, { error: 'refused', error_code: 'not_a_known_code' }))
    expect(out.success).toBe(false)
    expect(out.code).toBe('API_ERROR')
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(out.next_tool_name).toBeUndefined()
    expect(out.next_tool_omitted_reason).toBeUndefined()
  })

  it('a body with its own next_action and no typed code still has it passed through', async () => {
    const out = await sendAnswer(
      new HavenApiError('refused', 409, { error: 'refused', next_action: 'retry_with_explicit_context' }),
    )
    expect(out.code).toBe('API_ERROR')
    expect(out.next_action).toBe('retry_with_explicit_context')
    expect(out.nextAction).toBe('retry_with_explicit_context')
  })

  it('a body-supplied next_tool_omitted_reason still rides the generic answer', async () => {
    const out = await sendAnswer(
      new HavenApiError('refused', 426, { error: 'refused', next_tool_omitted_reason: 'upgrade the client first' }),
    )
    expect(out.code).toBe('API_ERROR')
    expect(out.next_tool_omitted_reason).toBe('upgrade the client first')
  })

  it('a typed code answers with its typed code and reason instead of API_ERROR', async () => {
    const out = await sendAnswer(
      new HavenApiError('Task budget not found', 404, { error: 'Task budget not found', error_code: 'task_budget_not_found' }),
    )
    expect(out.code).toBe('TASK_BUDGET_NOT_FOUND')
    expect(out.next_action).toBe('stop_and_tell_user')
    expect(typeof out.next_tool_omitted_reason).toBe('string')
  })

  it('a prototype key in error_code is not mistaken for a table row', async () => {
    const out = await sendAnswer(new HavenApiError('refused', 409, { error: 'refused', error_code: 'constructor' }))
    expect(out.code).toBe('API_ERROR')
  })
})
