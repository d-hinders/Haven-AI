/**
 * #4790 (epic #4788 slice 2) — the LOCAL ↔ HOSTED refusal parity test.
 *
 * The hosted MCP's `normalizeError` (`packages/mcp-server/src/tools/support/
 * errors.ts`) types 20 backend `error_code`s: the ten payment-scope codes
 * through `PAYMENT_SCOPE_REFUSAL_ANSWERS`, and ten more through hand-written
 * branches whose answers depend on the body (`submission_outcome_unknown`
 * names the status read only when the body carries a `payment_id`;
 * `prepare_reverted` changes its step on `revert_cause`; `delegation_expired`
 * is guarded on status 403). The local MCP's mapper
 * (`packages/mcp/src/tools.ts`) typed none of them: every one reached the
 * agent as `API_ERROR` with no reason.
 *
 * This test drives BOTH mappers with the fixture bodies the hosted suite
 * already keeps (`REFUSAL_SITES` in `test-support/next-step-fixtures.ts`) and
 * fails unless they agree on the five compared fields. It lives here, not in
 * `packages/mcp`, because only this package can import both `@haven_ai/mcp`
 * and `@haven_ai/core`; the reverse is not possible.
 *
 * What is compared: `code`, `next_action`, `next_tool_name`, `next_arguments`
 * and `next_tool_omitted_reason`. Deliberately NOT compared: `next_tool`,
 * `next_tool_server` and `next_tool_server_role` (the hosted surface qualifies
 * a tool by server; the local one does not), and hosted-only body projections
 * such as `remaining_atomic`.
 *
 * The allowlist below holds any legitimate difference on a compared field,
 * each with a reason. An unlisted difference fails, and so does a stale entry.
 * It is empty at this commit: the only tool any of the 20 answers names is
 * `haven_get_payment_status`, which the local package has.
 */
import { describe, expect, it } from 'vitest'
import { HavenApiError } from '@haven_ai/sdk'
import { PAYMENT_SCOPE_REFUSAL_CODES } from '@haven_ai/core'
import { createToolHandlers as createLocalToolHandlers } from '@haven_ai/mcp'
import { normalizeError } from './tools/support/errors.js'
import { REFUSAL_SITES } from './test-support/next-step-fixtures.js'

/** The five fields the two mappers must agree on. */
const COMPARED_FIELDS = [
  'code',
  'next_action',
  'next_tool_name',
  'next_arguments',
  'next_tool_omitted_reason',
] as const
type ComparedField = (typeof COMPARED_FIELDS)[number]
type Compared = Record<ComparedField, unknown>

/**
 * Legitimate differences on a compared field, keyed by fixture site name and
 * then by field, each with the reason it is allowed. Empty at this commit.
 */
const ALLOWLIST: Record<string, Partial<Record<ComparedField, string>>> = {}

/** Valid `haven_send` arguments — the local mapper is shared by every handler. */
const LOCAL_SEND_ARGS = { asset: 'USDC', recipient: `0x${'1'.repeat(40)}`, amount: '1' }

/**
 * The local answer for a thrown error: the built local package's `haven_send`
 * handler given a client whose `pay` throws it. The SDK delivers these
 * refusals as `HavenApiError`, and every local handler funnels its errors
 * through the same `normalizeError`.
 */
async function localAnswer(thrown: unknown): Promise<Record<string, unknown>> {
  const client = new Proxy(
    {},
    {
      get: (_target, prop) => async () => {
        if (prop === 'pay') throw thrown
        throw new Error(`the local haven_send handler reached the client (${String(prop)})`)
      },
    },
  )
  const handlers = createLocalToolHandlers(client as never) as Record<string, (input: unknown) => Promise<unknown>>
  return (await handlers.haven_send(LOCAL_SEND_ARGS)) as Record<string, unknown>
}

/** The five compared fields of an answer, with an absent field normalised to null. */
function compared(answer: Record<string, unknown>): Compared {
  return {
    code: answer.code ?? null,
    next_action: answer.next_action ?? null,
    next_tool_name: answer.next_tool_name ?? null,
    next_arguments: answer.next_arguments ?? null,
    next_tool_omitted_reason: answer.next_tool_omitted_reason ?? null,
  }
}

/**
 * The fixture sites whose `thrown` is a `HavenApiError` the hosted mapper
 * answers with a typed code. Deriving the set from the hosted answer (rather
 * than a second hand-kept list of the 20 codes) is what keeps this test
 * honest: a fixture added for a new typed code joins the comparison by
 * itself, and a code the hosted mapper stops typing leaves it.
 */
const TYPED_SITES = REFUSAL_SITES.filter((site) => {
  if (!(site.thrown instanceof HavenApiError)) return false
  return (normalizeError(site.thrown) as { code: string }).code !== 'API_ERROR'
})

describe('#4790 local ↔ hosted refusal parity on the fixture bodies', () => {
  it('compares a non-empty set of typed fixture sites', () => {
    // 22 at this commit: the ten payment-scope codes, plus rail_unavailable,
    // task_budget_exceeded, task_budget_exceeds_remaining,
    // delegation_budget_exceeded, delegation_expired, the two
    // submission_outcome_unknown variants, account_validation_failed,
    // signature_rejected, the two prepare_reverted variants and
    // onchain_execution_failed.
    expect(TYPED_SITES.length).toBeGreaterThan(0)
    expect(TYPED_SITES.length).toBe(22)
  })

  it('agrees on every compared field, or the difference is allowlisted', async () => {
    const consumed = new Set<string>()
    const failures: string[] = []
    for (const site of TYPED_SITES) {
      const hosted = compared(normalizeError(site.thrown) as unknown as Record<string, unknown>)
      const local = compared(await localAnswer(site.thrown))
      for (const field of COMPARED_FIELDS) {
        if (JSON.stringify(hosted[field]) === JSON.stringify(local[field])) continue
        const reason = ALLOWLIST[site.site]?.[field]
        if (reason) {
          consumed.add(`${site.site}::${field}`)
          continue
        }
        failures.push(
          `${site.site} — ${field}: hosted ${JSON.stringify(hosted[field])} vs local ${JSON.stringify(local[field])}`,
        )
      }
    }
    expect(failures).toEqual([])
    // A stale entry — one that no longer corresponds to a real difference —
    // fails too, so the allowlist shrinks when the surfaces converge.
    const stale = Object.entries(ALLOWLIST).flatMap(([site, fields]) =>
      Object.keys(fields).map((field) => `${site}::${field}`),
    ).filter((key) => !consumed.has(key))
    expect(stale).toEqual([])
  })

  it('answers every code the hosted mapper types with a typed local code', async () => {
    const hostedCodes = new Set<string>()
    const localCodes = new Set<string>()
    for (const site of TYPED_SITES) {
      hostedCodes.add((normalizeError(site.thrown) as { code: string }).code)
      localCodes.add(String((await localAnswer(site.thrown)).code))
    }
    // 20 distinct codes at this commit — the ten payment-scope keys and the
    // ten branch codes.
    expect(hostedCodes.size).toBe(20)
    expect([...hostedCodes].filter((code) => !localCodes.has(code))).toEqual([])
    expect(localCodes.has('API_ERROR')).toBe(false)
  })

  it('covers the body-dependent variants by name', async () => {
    const byName = (name: string) => {
      const site = REFUSAL_SITES.find((s) => s.site === name)
      if (!site) throw new Error(`no fixture site named ${name}`)
      return site
    }

    // submission_outcome_unknown WITH a payment_id: the status read is named,
    // its argument carried, and no omitted reason is emitted.
    const withId = await localAnswer(
      byName('errors.ts normalizeError: submission outcome unknown (typed 502, payment_id known)').thrown,
    )
    expect(withId.next_action).toBe('check_status_later')
    expect(withId.next_tool_name).toBe('haven_get_payment_status')
    expect(withId.next_arguments).toEqual({ payment_id: 'pay_1' })
    expect('next_tool_omitted_reason' in withId).toBe(false)

    // ... and WITHOUT one: no tool can be named, so it stops and says why.
    const withoutId = await localAnswer(
      byName('errors.ts normalizeError: submission outcome unknown (typed 502, no payment_id)').thrown,
    )
    expect(withoutId.next_action).toBe('stop_and_tell_user')
    expect(withoutId.next_tool_name).toBeUndefined()
    expect(typeof withoutId.next_tool_omitted_reason).toBe('string')

    // prepare_reverted WITH revert_cause: insufficient_balance names the
    // funding remedy; WITHOUT it, the caveat stop.
    const funding = await localAnswer(
      byName('errors.ts normalizeError: prepare reverted, insufficient balance (typed 502, #3731)').thrown,
    )
    expect(funding.next_action).toBe('fund_account_or_raise_allowance')
    const caveat = await localAnswer(
      byName('errors.ts normalizeError: prepare reverted (typed 502, #3609)').thrown,
    )
    expect(caveat.next_action).toBe('stop_and_tell_user')
    expect(funding.next_tool_omitted_reason).not.toBe(caveat.next_tool_omitted_reason)

    // delegation_expired at a status other than 403 — built here, because no
    // fixture carries it and the fixtures file's site count is pinned
    // elsewhere. BOTH sides fall back to the generic API_ERROR.
    const offStatus = new HavenApiError('refused', 400, { error_code: 'delegation_expired' })
    expect((normalizeError(offStatus) as { code: string }).code).toBe('API_ERROR')
    expect((await localAnswer(offStatus)).code).toBe('API_ERROR')
  })

  it('answers every core payment-scope code with a typed local code', async () => {
    // The hosted table is keyed off `@haven_ai/core`'s union, so a member
    // added there cannot go unanswered hosted. The local table is written by
    // hand (this package cannot import core), so this walk is what holds it:
    // a new core code with no local row answers API_ERROR and fails here.
    expect(PAYMENT_SCOPE_REFUSAL_CODES.length).toBe(10)
    const unanswered: string[] = []
    for (const code of PAYMENT_SCOPE_REFUSAL_CODES) {
      const err = new HavenApiError('refused', 409, { error: 'refused', error_code: code })
      const local = await localAnswer(err)
      if (local.code === 'API_ERROR') unanswered.push(code)
    }
    expect(unanswered).toEqual([])
  })
})
