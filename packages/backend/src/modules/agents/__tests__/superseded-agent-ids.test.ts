import { describe, expect, it } from 'vitest'
import { sanitizeInstallStatus } from '../agent-connection-setup.js'

/**
 * `superseded_agent_ids` on the install-status report (#2561).
 *
 * The connector reports which OTHER agent directories a machine holds, so the
 * dashboard can offer the owner a one-click revoke of what a new setup
 * superseded. Two properties carry it, and both are about not overclaiming.
 *
 * **It is a tri-state.** `[]` means the scan ran and found nothing; `null`
 * means the scan could not run. Before this change the connector returned `[]`
 * for both and its own doc comment had to warn readers that emptiness was not
 * a guarantee — a warning that cannot reach a dashboard. Rendering "nothing to
 * revoke" for a machine nobody managed to read is Haven asserting something it
 * does not know.
 *
 * **The ids are not trusted, only shaped.** The connector falls back to the
 * directory name when an `identity.json` exists but does not parse, so this
 * list can legitimately hold strings that are not agent ids at all. Whether an
 * id is one of the caller's agents is decided where that is known — never by
 * believing the report.
 */

describe('sanitizeInstallStatus — superseded_agent_ids (#2561)', () => {
  it('keeps the three states apart', () => {
    expect(sanitizeInstallStatus({ superseded_agent_ids: ['agt_a', 'agt_b'] }).superseded_agent_ids)
      .toEqual(['agt_a', 'agt_b'])
    // Scanned, found none.
    expect(sanitizeInstallStatus({ superseded_agent_ids: [] }).superseded_agent_ids).toEqual([])
    // The scan could not run — a fact the report is MAKING, distinct from...
    expect(sanitizeInstallStatus({ superseded_agent_ids: null }).superseded_agent_ids).toBeNull()
    // ...a report that says nothing about it at all, which the jsonb merge
    // leaves untouched rather than overwriting.
    expect(sanitizeInstallStatus({ runtime: 'claude-code' })).not.toHaveProperty(
      'superseded_agent_ids',
    )
  })

  it('never lets a credential-shaped string through, the same as every other field', () => {
    // The ids arrive from a machine Haven cannot see, on a money-path route.
    const out = sanitizeInstallStatus({
      superseded_agent_ids: ['agt_ok', 'sk_agent_deadbeef01', `0x${'a'.repeat(64)}`],
    })
    expect(out.superseded_agent_ids).toEqual(['agt_ok'])
  })

  it('drops non-strings and blanks rather than coercing them', () => {
    const out = sanitizeInstallStatus({
      superseded_agent_ids: ['agt_ok', 42, null, { id: 'agt_x' }, ['agt_y'], '   ', 'agt_two'],
    })
    expect(out.superseded_agent_ids).toEqual(['agt_ok', 'agt_two'])
  })

  it('caps each id and the count, so a hostile report cannot grow the row', () => {
    const out = sanitizeInstallStatus({
      superseded_agent_ids: [
        'x'.repeat(500),
        ...Array.from({ length: 80 }, (_, i) => `agt_${i}`),
      ],
    })
    const ids = out.superseded_agent_ids as string[]
    expect(ids).toHaveLength(50)
    expect(ids[0]).toHaveLength(120)
  })

  it('refuses a non-array, non-null value instead of wrapping it', () => {
    // A bare string is the mistake most likely to be made by a future client,
    // and silently turning it into a one-element list would invent a fact.
    for (const bad of ['agt_a', 42, true, { ids: [] }]) {
      expect(sanitizeInstallStatus({ superseded_agent_ids: bad }), JSON.stringify(bad))
        .not.toHaveProperty('superseded_agent_ids')
    }
  })

  it('trims, because a directory name can arrive padded', () => {
    expect(sanitizeInstallStatus({ superseded_agent_ids: ['  agt_a  '] }).superseded_agent_ids)
      .toEqual(['agt_a'])
  })
})
