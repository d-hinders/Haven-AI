import { describe, expect, it } from 'vitest'
import { INACTIVE_AGENT_GROUP, agentFacetOptions, type AgentFacetSource } from '@/lib/agent-facet'

function agent(overrides: Partial<AgentFacetSource> = {}): AgentFacetSource {
  return {
    id: overrides.id ?? overrides.name ?? 'a',
    name: 'Research agent',
    status: 'active',
    ...overrides,
  }
}

/** The option's label, in the order the builder returned them. */
const labels = (options: ReturnType<typeof agentFacetOptions>) => options.map((o) => o.label)

describe('agentFacetOptions — order', () => {
  it('lists active, then paused, then needs setup, then the rest', () => {
    const options = agentFacetOptions([
      agent({ id: 'r', name: 'Revoked one', status: 'revoked' }),
      agent({ id: 'p', name: 'Paused one', status: 'paused' }),
      agent({ id: 'n', name: 'Needs setup one', status: 'pending_approval' }),
      agent({ id: 'a', name: 'Active one', status: 'active' }),
    ])
    expect(labels(options)).toEqual(['Active one', 'Paused one', 'Needs setup one', 'Revoked one'])
  })

  it('sorts names A–Z inside each status', () => {
    const options = agentFacetOptions([
      agent({ id: 'a2', name: 'Zoe', status: 'active' }),
      agent({ id: 'a1', name: 'Ada', status: 'active' }),
      agent({ id: 'p2', name: 'Yara', status: 'paused' }),
      agent({ id: 'p1', name: 'Bea', status: 'paused' }),
    ])
    expect(labels(options)).toEqual(['Ada', 'Zoe', 'Bea', 'Yara'])
  })

  it('puts an unrecognised status in the tail, after needs setup', () => {
    const options = agentFacetOptions([
      agent({ id: 'x', name: 'Odd one', status: 'suspended' }),
      agent({ id: 'n', name: 'Needs setup one', status: 'pending_approval' }),
    ])
    expect(labels(options)).toEqual(['Needs setup one', 'Odd one'])
  })

  it('does not mutate the caller’s array', () => {
    const agents = [agent({ id: 'b', name: 'Bea' }), agent({ id: 'a', name: 'Ada' })]
    agentFacetOptions(agents)
    expect(agents.map((a) => a.name)).toEqual(['Bea', 'Ada'])
  })
})

describe('agentFacetOptions — meta', () => {
  it('names every non-active status through agentStatusPresentation', () => {
    const options = agentFacetOptions([
      agent({ id: 'a', name: 'Active one', status: 'active' }),
      agent({ id: 'p', name: 'Paused one', status: 'paused' }),
      agent({ id: 'n', name: 'Needs setup one', status: 'pending_approval' }),
      agent({ id: 'r', name: 'Revoked one', status: 'revoked' }),
    ])
    expect(options.map((o) => o.meta)).toEqual([undefined, 'Paused', 'Needs setup', 'Revoked'])
  })

  it('leaves the label alone — the status never rides in it', () => {
    const [option] = agentFacetOptions([agent({ id: 'r', name: 'Data-feed agent', status: 'revoked' })])
    expect(option.label).toBe('Data-feed agent')
    expect(option.meta).toBe('Revoked')
  })

  it('echoes an unrecognised status neutrally rather than dropping it', () => {
    const [option] = agentFacetOptions([agent({ id: 'x', name: 'Odd one', status: 'suspended' })])
    expect(option.meta).toBe('Suspended')
  })
})

describe('agentFacetOptions — the inactive group', () => {
  it('groups revoked agents', () => {
    const options = agentFacetOptions([
      agent({ id: 'a', name: 'Active one' }),
      agent({ id: 'r', name: 'Revoked one', status: 'revoked' }),
    ])
    expect(options[0].group).toBeUndefined()
    expect(options[1].group).toEqual(INACTIVE_AGENT_GROUP)
  })

  it('groups archived agents, even where the source carries no revoked status', () => {
    const options = agentFacetOptions([
      agent({ id: 'a', name: 'Active one' }),
      agent({ id: 'z', name: 'Archived one', status: 'paused', archived_at: '2026-06-01T00:00:00Z' }),
    ])
    expect(options[1].group).toEqual(INACTIVE_AGENT_GROUP)
    // The status still rides in `meta`: archived is not a status.
    expect(options[1].meta).toBe('Paused')
  })

  it('leaves needs-setup agents ungrouped — they are about to become usable', () => {
    const options = agentFacetOptions([
      agent({ id: 'n', name: 'Needs setup one', status: 'pending_approval' }),
    ])
    expect(options[0].group).toBeUndefined()
  })

  it('leaves paused agents ungrouped', () => {
    const options = agentFacetOptions([agent({ id: 'p', name: 'Paused one', status: 'paused' })])
    expect(options[0].group).toBeUndefined()
  })

  it('uses one group id and label for every inactive agent', () => {
    const options = agentFacetOptions([
      agent({ id: 'r1', name: 'Revoked one', status: 'revoked' }),
      agent({ id: 'r2', name: 'Revoked two', status: 'revoked' }),
      agent({ id: 'z', name: 'Archived one', status: 'revoked', archived_at: '2026-06-01T00:00:00Z' }),
    ])
    expect(options.map((o) => o.group)).toEqual([
      INACTIVE_AGENT_GROUP,
      INACTIVE_AGENT_GROUP,
      INACTIVE_AGENT_GROUP,
    ])
    expect(INACTIVE_AGENT_GROUP).toEqual({ id: 'inactive', label: 'inactive' })
  })
})

describe('agentFacetOptions — leading options', () => {
  it('puts the page’s own options first, ungrouped and in the given order', () => {
    const options = agentFacetOptions(
      [agent({ id: 'a', name: 'Active one' }), agent({ id: 'r', name: 'Revoked one', status: 'revoked' })],
      [{ value: 'user', label: 'User (manual)' }],
    )
    expect(options.map((o) => o.value)).toEqual(['user', 'a', 'r'])
    expect(options[0]).toEqual({ value: 'user', label: 'User (manual)' })
  })

  it('returns the agents alone when there are no leading options', () => {
    const options = agentFacetOptions([agent({ id: 'a', name: 'Active one' })])
    expect(options).toEqual([{ value: 'a', label: 'Active one' }])
  })

  it('returns nothing for an empty list', () => {
    expect(agentFacetOptions([])).toEqual([])
  })
})
