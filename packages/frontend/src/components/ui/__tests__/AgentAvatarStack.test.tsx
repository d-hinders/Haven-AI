import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AgentAvatarStack, rosterLine } from '../AgentAvatarStack'
import type { StackedAgent } from '../AgentAvatarStack'

/**
 * `ui/AgentAvatarStack` (#4480) — the overlapping agent monograms, owner
 * approved 2026-10-27.
 *
 * What this file pins is the contract a caller has to be able to rely on: the
 * cap and its `+N` overflow, the tint coming from the agent's STORED
 * `avatarTint` (never invented here), the accessible name in the roster's
 * words, and ONE focus stop whatever the number of marks — the reason the
 * stack carries a single shared `Tooltip` instead of one per mark.
 */

const agent = (id: string, name: string, avatarTint: number | null = null): StackedAgent => ({
  id,
  name,
  avatarTint,
})

const THREE = [agent('a1', 'Atlas', 1), agent('a2', 'Data agent', 2), agent('a3', 'Ops agent', 3)]

/** The tint class each rendered mark wears, in order. */
function markClasses(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')].map(
    (mark) => mark.firstElementChild!.className,
  )
}

describe('AgentAvatarStack — the cap and its overflow mark (#4480)', () => {
  it('shows three marks and no overflow for three agents', () => {
    const { container } = render(<AgentAvatarStack agents={THREE} />)
    expect(container.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')).toHaveLength(3)
    expect(container.querySelector('[data-testid="agent-avatar-stack-overflow"]')).toBeNull()
  })

  it('shows three marks plus "+2" for five agents', () => {
    const { container } = render(
      <AgentAvatarStack
        agents={[...THREE, agent('a4', 'Research agent', 4), agent('a5', 'Data-feed agent', 5)]}
      />,
    )
    expect(container.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')).toHaveLength(3)
    const overflow = container.querySelector('[data-testid="agent-avatar-stack-overflow"]')!
    expect(overflow.textContent).toBe('+2')
    // Neutral ink, never a tint: the overflow mark counts agents, it is not one.
    expect(overflow.className).toContain('bg-[var(--v2-surface-2)]')
    expect(overflow.className).toContain('text-[var(--v2-ink-2)]')
    expect(overflow.className).not.toMatch(/avatar-\d/)
  })

  it('honours a caller cap', () => {
    const { container } = render(<AgentAvatarStack agents={THREE} cap={2} />)
    expect(container.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')).toHaveLength(2)
    expect(container.querySelector('[data-testid="agent-avatar-stack-overflow"]')!.textContent).toBe('+1')
  })

  it('renders nothing for zero agents — the caller keeps its own text', () => {
    const { container } = render(<AgentAvatarStack agents={[]} />)
    expect(container.innerHTML).toBe('')
  })
})

describe('AgentAvatarStack — colour comes from the stored tint (#4480)', () => {
  it('wears each agent’s stored avatarTint, so two names that hash alike still differ', () => {
    // 'Research agent' and 'Data-feed agent' both hash to tint 6 (djb2 mod 6);
    // they wear different colours because each carries its own stored tint —
    // the same rule `seriesColorForAgent` fills their chart series with.
    const { container } = render(
      <AgentAvatarStack
        agents={[agent('a1', 'Research agent', 1), agent('a2', 'Data-feed agent', 2)]}
      />,
    )
    const classes = markClasses(container)
    expect(classes[0]).toContain('bg-[var(--v2-avatar-1-soft)]')
    expect(classes[1]).toContain('bg-[var(--v2-avatar-2-soft)]')
    expect(classes[0]).not.toBe(classes[1])
  })

  it('falls back to the name hash when the agent has no stored tint', () => {
    // A null tint is the caller's "unknown agent" case: the hash decides, and
    // the stack invents no colour of its own.
    const { container } = render(<AgentAvatarStack agents={[agent('a1', 'Atlas', null)]} />)
    expect(markClasses(container)[0]).toMatch(/bg-\[var\(--v2-avatar-[1-6]-soft\)\]/)
  })
})

describe('AgentAvatarStack — one accessible name, one focus stop (#4480)', () => {
  it('names the agents in the roster’s words', () => {
    render(<AgentAvatarStack agents={THREE} />)
    expect(screen.getByRole('img', { name: 'Atlas, Data agent, Ops agent' })).toBeTruthy()
  })

  it('counts the agents past the cap in the accessible name', () => {
    render(
      <AgentAvatarStack
        agents={[...THREE, agent('a4', 'Research agent', 4), agent('a5', 'Data-feed agent', 5)]}
      />,
    )
    expect(screen.getByRole('img', { name: 'Atlas, Data agent, Ops agent and 2 more' })).toBeTruthy()
  })

  it('is exactly ONE tab stop, whatever the number of marks', () => {
    // A per-mark tooltip would add one tab stop per mark (up to thirty in the
    // merchants table), each wrapped around aria-hidden content. Mutation:
    // wrap each mark in its own Tooltip → this goes red.
    for (const agents of [[agent('a1', 'Atlas', 1)], THREE, [...THREE, agent('a4', 'Research agent', 4)]]) {
      const { container, unmount } = render(<AgentAvatarStack agents={agents} />)
      expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1)
      unmount()
    }
  })

  it('marks every monogram decorative — the stack’s name is the only thing read', () => {
    const { container } = render(<AgentAvatarStack agents={THREE} />)
    for (const mark of container.querySelectorAll('[data-testid="agent-avatar-stack-mark"]')) {
      expect(mark.firstElementChild!.getAttribute('aria-hidden')).toBe('true')
    }
  })
})

describe('rosterLine (#4480)', () => {
  it('joins the names and counts the rest', () => {
    expect(rosterLine(['Atlas', 'Data agent'], 2)).toBe('Atlas, Data agent')
    expect(rosterLine(['Atlas', 'Data agent'], 3)).toBe('Atlas, Data agent and 1 more')
    expect(rosterLine(['Atlas'], 5)).toBe('Atlas and 4 more')
  })
})
