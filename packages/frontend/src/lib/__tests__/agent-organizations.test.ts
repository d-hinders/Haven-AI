/**
 * The organization domain (#3164): tree build, flattening, subtree ids, the
 * #3165 facet. Pure functions — no rendering, no API.
 *
 * The facet is where the list-filter contract lives: selecting an
 * organization matches the WHOLE subtree (the folder metaphor's promise),
 * "Top level" matches unfiled agents, and every agent is reachable exactly
 * once across the options.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@/hooks/useAgents'
import type { Organization } from '@/hooks/useOrganizations'
import {
  TOP_LEVEL_OPTION,
  buildOrganizationTree,
  flattenOrganizationTree,
  organizationFacet,
  organizationPath,
  subtreeIds,
} from '@/lib/agent-organizations'

function org(id: string, name: string, parentId: string | null, agentCount = 0): Organization {
  return {
    id,
    parent_organization_id: parentId,
    name,
    created_at: '2026-09-22T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
    agent_count: agentCount,
  }
}

function agent(organizationId: string | null): Agent {
  return {
    id: 'a-' + (organizationId ?? 'top'),
    name: 'Agent',
    delegate_address: null,
    account_id: null,
    account_address: null,
    account_name: null,
    account_chain_id: null,
    api_key_prefix: null,
    status: 'active',
    created_at: '2026-09-22T00:00:00Z',
    allowances: [],
    labels: [],
    organization_id: organizationId,
  } as Agent
}

// Company A
// ├─ Tech Agents
// │  └─ DevOps
// └─ Marketing
const TREE = [
  org('company', 'Company A', null),
  org('tech', 'Tech Agents', 'company'),
  org('devops', 'DevOps', 'tech'),
  org('marketing', 'Marketing', 'company'),
]

describe('buildOrganizationTree', () => {
  it('nests children under parents and sorts siblings case-insensitively', () => {
    const roots = buildOrganizationTree([
      TREE[2], TREE[3], TREE[1], TREE[0], // deliberately unsorted
    ])
    expect(roots).toHaveLength(1)
    expect(roots[0].org.id).toBe('company')
    // Case-insensitive: "Marketing" before "Tech Agents".
    expect(roots[0].children.map((n) => n.org.id)).toEqual(['marketing', 'tech'])
    expect(roots[0].children[1].children[0].org.id).toBe('devops')
    expect(roots[0].children[1].depth).toBe(1)
    expect(roots[0].children[1].children[0].depth).toBe(2)
  })

  it('allows multiple roots', () => {
    const roots = buildOrganizationTree([
      org('a', 'Alpha', null),
      org('b', 'beta', null),
    ])
    expect(roots.map((r) => r.org.id)).toEqual(['a', 'b'])
  })

  it('degrades an orphaned row to a root instead of dropping it', () => {
    const roots = buildOrganizationTree([org('lost', 'Lost child', 'missing-parent')])
    expect(roots).toHaveLength(1)
    expect(roots[0].org.id).toBe('lost')
  })

  it('promotes cycle members to roots (defensive; the API refuses cycles)', () => {
    const a = org('a', 'A', 'b')
    const b = org('b', 'B', 'a')
    const roots = buildOrganizationTree([a, b])
    expect(roots).toHaveLength(2)
  })
})

describe('flattenOrganizationTree', () => {
  it('walks pre-order with depths', () => {
    const rows = flattenOrganizationTree(buildOrganizationTree(TREE))
    expect(rows.map((r) => `${r.org.id}:${r.depth}`)).toEqual([
      'company:0',
      'marketing:1',
      'tech:1',
      'devops:2',
    ])
  })
})

describe('subtreeIds', () => {
  it('returns the id and every descendant', () => {
    expect(subtreeIds(TREE, 'company')).toEqual(['company', 'tech', 'devops', 'marketing'])
    expect(subtreeIds(TREE, 'tech')).toEqual(['tech', 'devops'])
    expect(subtreeIds(TREE, 'marketing')).toEqual(['marketing'])
  })
})

describe('organizationPath', () => {
  it('joins ancestor names, nearest last', () => {
    expect(organizationPath(TREE, 'devops')).toBe('Company A / Tech Agents / DevOps')
    expect(organizationPath(TREE, 'company')).toBe('Company A')
  })
})

describe('organizationFacet (#3165 extension)', () => {
  const facet = organizationFacet(TREE)

  it('offers Top level plus one option per organization', () => {
    expect(facet.id).toBe('organization')
    expect(facet.options.map((o) => o.value)).toEqual([
      TOP_LEVEL_OPTION,
      'company',
      'tech',
      'devops',
      'marketing',
    ])
  })

  it('matches the whole subtree, not just direct members', () => {
    const devopsAgent = agent('devops')
    expect(facet.predicate(devopsAgent, 'tech')).toBe(true)
    expect(facet.predicate(devopsAgent, 'company')).toBe(true)
    expect(facet.predicate(devopsAgent, 'marketing')).toBe(false)
  })

  it('Top level matches unfiled agents only', () => {
    expect(facet.predicate(agent(null), TOP_LEVEL_OPTION)).toBe(true)
    expect(facet.predicate(agent('tech'), TOP_LEVEL_OPTION)).toBe(false)
  })

  it('an unknown agent placement matches nothing (never a false positive)', () => {
    expect(facet.predicate(agent('elsewhere'), 'tech')).toBe(false)
  })
})
