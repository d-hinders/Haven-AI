import type { AgentFacet, AgentFacetOption } from '@/lib/agent-list-filters'
import type { Agent } from '@/hooks/useAgents'
import type { Organization } from '@/hooks/useOrganizations'

/**
 * Organization domain for the `/agents` surface (#3164): the client-side
 * tree build over the API's flat rows, and the #3165 filter facet that the
 * filter lib's header promised ("organizations from #3164"). Everything here
 * is pure and mirrored in `lib/__tests__/agent-organizations.test.ts`.
 *
 * Terminology: UI copy says "Organizations" — never "groups" or "folders"
 * (the coordinator's settled decision on the issue). Only `ParentId` in a
 * helper's signature says parent, because TypeScript does.
 */

export interface OrganizationNode {
  org: Organization
  children: OrganizationNode[]
  /** Depth in the tree; roots are 0. indentation helper for flat renders. */
  depth: number
}

/**
 * Build the display tree from flat rows. Unknown or foreign parent ids are
 * IMPOSSIBLE from the API (every row is the caller's own), but a client that
 * received a partially-failed fetch could hold a child without its parent;
 * such a row degrades to a root rather than disappearing (an agent filed
 * under it must stay reachable). The API's move guard makes cycles
 * unreachable; if a hostile payload carried one anyway, the members would
 * never be reached from the roots, so they are promoted to roots below —
 * every organization renders, nothing loops.
 */
export function buildOrganizationTree(organizations: Organization[]): OrganizationNode[] {
  const byId = new Map<string, OrganizationNode>()
  for (const org of organizations) {
    byId.set(org.id, { org, children: [], depth: 0 })
  }
  const roots: OrganizationNode[] = []
  for (const node of byId.values()) {
    const parentId = node.org.parent_organization_id
    const parent = parentId ? byId.get(parentId) : undefined
    if (parent && parent !== node) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  // Name-sorted roots and siblings at every depth (case-insensitive, the
  // API's own order is per-parent but a client-side rebuild after a move
  // should not depend on it), then depths.
  const byName = (a: OrganizationNode, b: OrganizationNode) =>
    a.org.name.localeCompare(b.org.name, undefined, { sensitivity: 'base' }) ||
    a.org.name.localeCompare(b.org.name)
  roots.sort(byName)
  const seen = new Set<string>()
  const walk = (nodes: OrganizationNode[], depth: number) => {
    nodes.sort(byName)
    for (const node of nodes) {
      seen.add(node.org.id)
      node.depth = depth
      walk(node.children, depth + 1)
    }
  }
  walk(roots, 0)
  // Cycle members are unreachable from the roots; promote them so every
  // organization (and the agents filed under it) stays visible.
  for (const node of byId.values()) {
    if (!seen.has(node.org.id)) roots.push(node)
  }
  return roots
}

/** Flat, depth-ordered row list for renders (the tree, pre-order). */
export function flattenOrganizationTree(nodes: OrganizationNode[]): OrganizationNode[] {
  const out: OrganizationNode[] = []
  const walk = (nodes: OrganizationNode[]) => {
    for (const node of nodes) {
      out.push(node)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** Every id in the subtree rooted at `orgId`, inclusive — one option per org. */
export function subtreeIds(organizations: Organization[], orgId: string): string[] {
  const childrenByParent = new Map<string | null, string[]>()
  for (const org of organizations) {
    const list = childrenByParent.get(org.parent_organization_id) ?? []
    list.push(org.id)
    childrenByParent.set(org.parent_organization_id, list)
  }
  const out: string[] = []
  const walk = (id: string) => {
    out.push(id)
    for (const child of childrenByParent.get(id) ?? []) walk(child)
  }
  walk(orgId)
  return out
}

/** "Tech Agents / DevOps" — breadcrumb-style path, nearest last. */
export function organizationPath(organizations: Organization[], orgId: string): string {
  const byId = new Map(organizations.map((o) => [o.id, o]))
  const parts: string[] = []
  let current = byId.get(orgId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    parts.unshift(current.name)
    current = current.parent_organization_id ? byId.get(current.parent_organization_id) : undefined
  }
  return parts.join(' / ')
}

/**
 * The facet the agents list registers (#3165's extension point). Selecting
 * an organization shows the agents filed under it OR any of its descendants
 * — picking "Tech Agents" means the whole Tech Agents subtree, which is what
 * the folder metaphor promises. "Top level" is the explicit option for
 * unfiled agents (`organization_id = null`), so every agent is reachable
 * through the facet exactly once.
 */
export function organizationFacet(organizations: Organization[]): AgentFacet {
  const options: AgentFacetOption[] = [
    { value: TOP_LEVEL_OPTION, label: 'Top level' },
    ...organizations.map((org) => ({ value: org.id, label: org.name })),
  ]
  const subtreeCache = new Map<string, Set<string>>()
  for (const org of organizations) {
    subtreeCache.set(org.id, new Set(subtreeIds(organizations, org.id)))
  }
  return {
    id: 'organization',
    label: 'Organization',
    match: 'any',
    options,
    predicate: (agent: Agent, value: string) => {
      if (value === TOP_LEVEL_OPTION) return agent.organization_id == null
      return subtreeCache.get(value)?.has(agent.organization_id ?? '') ?? false
    },
  }
}

/** The facet's option value for agents outside every organization. */
export const TOP_LEVEL_OPTION = 'top_level'

/** Indentation for a flat render: one depth step, capped for deep trees. */
export function organizationIndent(depth: number): string {
  return ' '.repeat(Math.min(depth, 6) * 2)
}
