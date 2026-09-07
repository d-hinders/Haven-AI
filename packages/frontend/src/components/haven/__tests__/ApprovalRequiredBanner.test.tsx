/**
 * Tone ladder characterization (#1701 added `danger`).
 *
 * The first two cases are a CHARACTERIZATION of behaviour that existed before
 * this change and must not move: all four `/design-system` call sites pass
 * `tone` explicitly, and #1863 owns the committed visual baselines for that
 * route. If adding `danger` had altered what `neutral` or `warning` render,
 * those baselines would shift and #1863's in-flight work would collide with
 * this for no reason. These pin it as an assertion rather than leaving it as
 * a claim in a PR body.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApprovalRequiredBanner } from '../ApprovalRequiredBanner'

function frameOf(container: HTMLElement): string {
  return (container.firstElementChild as HTMLElement).className
}

describe('ApprovalRequiredBanner tones', () => {
  it('neutral keeps the surface frame it had before danger existed', () => {
    const { container } = render(
      <ApprovalRequiredBanner tone="neutral" title="T">body</ApprovalRequiredBanner>,
    )
    expect(frameOf(container)).toContain('border-[var(--v2-border)]')
    expect(frameOf(container)).toContain('bg-[var(--v2-surface)]')
  })

  it('warning keeps its frame, and is still the default', () => {
    const { container: explicit } = render(
      <ApprovalRequiredBanner tone="warning" title="T">body</ApprovalRequiredBanner>,
    )
    const { container: byDefault } = render(
      <ApprovalRequiredBanner title="T">body</ApprovalRequiredBanner>,
    )
    expect(frameOf(explicit)).toContain('bg-[var(--v2-warning-soft)]')
    // The default must remain `warning` — a silently changed default is how a
    // tone addition moves every uncustomised banner in the product.
    expect(frameOf(byDefault)).toBe(frameOf(explicit))
  })

  it('danger is a distinct frame, not a restyled warning', () => {
    const { container: danger } = render(
      <ApprovalRequiredBanner tone="danger" title="T">body</ApprovalRequiredBanner>,
    )
    const { container: warning } = render(
      <ApprovalRequiredBanner tone="warning" title="T">body</ApprovalRequiredBanner>,
    )
    expect(frameOf(danger)).toContain('bg-[var(--v2-danger-soft)]')
    expect(frameOf(danger)).not.toBe(frameOf(warning))
  })

  it('renders the title and body for every tone', () => {
    render(
      <ApprovalRequiredBanner tone="danger" title="Cannot be undone">
        the consequence
      </ApprovalRequiredBanner>,
    )
    expect(screen.getByRole('heading', { name: 'Cannot be undone' })).toBeInTheDocument()
    expect(screen.getByText('the consequence')).toBeInTheDocument()
  })

  it('can shrink and break a long unbroken title or body (#2526)', () => {
    // A jsdom test cannot measure layout, so this pins the CONTRACT and says
    // so. The bug it stands for was real and rendered: an 80-character
    // unbroken string made this banner wider than its card on mobile and
    // pushed the rest of its own sentence out of view. Two causes — a flex
    // child's default `min-width: auto` refusing to shrink, and `break-words`
    // not breaking a single token — and the title needed the fix as much as
    // the body, because `ReplaceSigningKeyModal` passes a user-chosen agent
    // name into it on an irreversible re-key.
    const unbroken = 'A'.repeat(80)
    const { container } = render(
      <ApprovalRequiredBanner tone="danger" title={unbroken}>
        <span>{unbroken}b</span>
      </ApprovalRequiredBanner>,
    )
    const heading = screen.getByRole('heading', { name: unbroken })
    expect(heading.className).toContain('[overflow-wrap:anywhere]')
    // The column the title and body share must be allowed to shrink, or the
    // break rule never gets the chance to apply.
    expect(heading.parentElement?.className).toContain('min-w-0')
    expect(container.querySelector('.min-w-0')).not.toBeNull()
  })
})
