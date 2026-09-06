import { describe, expect, it } from 'vitest'
import { sanitizeInstallStatus } from '../agent-connection-setup.js'

/**
 * Characterization tests for `sanitizeInstallStatus` (money-path rule,
 * CLAUDE.md — pin what exists BEFORE changing anything).
 *
 * These assert TODAY's behaviour, not the behaviour #2561 wants. #2561 carries
 * `superseded_agent_ids` from the connector to the dashboard so an owner can
 * be offered a one-click revoke of the agents a new setup superseded, and that
 * means teaching this function a shape it has never handled: an array. The
 * route it guards is on the money-path globs, so what it already refuses is
 * pinned here first — a widening that quietly also widened something else
 * would otherwise be invisible.
 *
 * Two of these are the ones the change must not break:
 *
 * - the allowlist DROPS what it does not recognise, silently. That is the
 *   property the whole function exists for, and adding a key must not turn it
 *   into a pass-through for neighbouring shapes.
 * - `error_code` is the one field where `null` means something. #2561 needs a
 *   second meaningful null (absent/null = "the credential scan did not run",
 *   `[]` = "it ran and found nothing"), so the existing precedent is recorded
 *   here rather than rediscovered.
 */

describe('sanitizeInstallStatus — characterization across #2561', () => {
  it('drops every key it does not recognise, silently', () => {
    const out = sanitizeInstallStatus({
      runtime: 'claude-code',
      not_a_real_field: 'kept?',
      superseded_agent_ids: ['agt_old'],
    })
    expect(out.runtime).toBe('claude-code')
    expect(out).not.toHaveProperty('not_a_real_field')
    // This is the ONE line #2561 moved, and the test predicted it: before the
    // change `superseded_agent_ids` was dropped like any unknown key, and it
    // now survives. Everything else in this file still asserts the untouched
    // behaviour, which is what makes the widening provably narrow.
    expect(out.superseded_agent_ids).toEqual(['agt_old'])
  })

  it('accepts no array of any kind today', () => {
    const out = sanitizeInstallStatus({
      runtime: ['claude-code'],
      probe_result: [],
      retired_agent_ids: ['agt_a'],
    })
    // Still true after #2561: `superseded_agent_ids` is the only array the
    // allowlist takes. `retired_agent_ids` is a real connector field and is
    // deliberately NOT carried — nothing in the dashboard offer needs it, and
    // widening by association is how an allowlist stops being one.
    expect(out).not.toHaveProperty('retired_agent_ids')
    // An array in a STRING slot is refused by the typeof check rather than
    // coerced — worth pinning, because a naive `String(field)` would have
    // turned `['claude-code']` into a plausible-looking `claude-code`.
    expect(out).not.toHaveProperty('runtime')
    expect(out).not.toHaveProperty('probe_result')
  })

  it('keeps error_code null, the one meaningful null', () => {
    // The precedent #2561's tri-state follows: a null that MEANS something,
    // written as its own branch above the string loop because the loop's
    // `typeof === 'string'` test would drop it.
    expect(sanitizeInstallStatus({ error_code: null }).error_code).toBeNull()
    expect(sanitizeInstallStatus({ error_code: 'runtime_undetermined' }).error_code).toBe(
      'runtime_undetermined',
    )
    // Any OTHER null is dropped, not preserved.
    expect(sanitizeInstallStatus({ probe_result: null })).not.toHaveProperty('probe_result')
    expect(sanitizeInstallStatus({ restart_required: null })).not.toHaveProperty('restart_required')
  })

  it('trims, refuses secret-shaped strings, and caps length at 120', () => {
    expect(sanitizeInstallStatus({ runtime: '  claude-code  ' }).runtime).toBe('claude-code')
    expect(sanitizeInstallStatus({ runtime: '   ' })).not.toHaveProperty('runtime')
    // The guard that matters on a money-path file: a value that looks like a
    // credential never reaches the row.
    expect(
      sanitizeInstallStatus({ probe_result: 'sk_agent_deadbeef01' }),
    ).not.toHaveProperty('probe_result')
    expect(sanitizeInstallStatus({ probe_result: `0x${'a'.repeat(64)}` })).not.toHaveProperty(
      'probe_result',
    )
    expect(String(sanitizeInstallStatus({ next_user_action: 'x'.repeat(500) }).next_user_action))
      .toHaveLength(120)
  })

  it('takes booleans only as booleans, never as truthy strings', () => {
    expect(sanitizeInstallStatus({ restart_required: true }).restart_required).toBe(true)
    expect(sanitizeInstallStatus({ restart_required: false }).restart_required).toBe(false)
    expect(sanitizeInstallStatus({ restart_required: 'true' })).not.toHaveProperty(
      'restart_required',
    )
  })

  it('always stamps last_probe_at, even for an empty body', () => {
    // So an empty report is still evidence that the connector reported.
    const out = sanitizeInstallStatus({})
    expect(Object.keys(out)).toEqual(['last_probe_at'])
    expect(typeof out.last_probe_at).toBe('string')
  })

  it('survives a non-object body without throwing', () => {
    for (const body of [null, undefined, 'string', 42, ['a']]) {
      expect(() => sanitizeInstallStatus(body), String(body)).not.toThrow()
      expect(Object.keys(sanitizeInstallStatus(body))).toEqual(['last_probe_at'])
    }
  })
})
