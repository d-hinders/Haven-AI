import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HavenMark } from '../HavenMark'

/**
 * What each tone draws (#3586). `brand` is pinned as it was before `onNavy`
 * existed, so adding a tone must not move it. The legacy header's translucent
 * tone left with that header (#3579, retired by #3658).
 */
function draw(tone?: 'brand' | 'onNavy') {
  const { container } = render(<HavenMark tone={tone} />)
  const rect = container.querySelector('rect')!
  const path = container.querySelector('path')!
  return {
    tile: rect.getAttribute('class'),
    tileStroke: rect.getAttribute('stroke-width'),
    ink: path.getAttribute('stroke'),
  }
}

describe('HavenMark tones', () => {
  it('brand (the default): the brand tile with a white H', () => {
    expect(draw()).toEqual({ tile: 'fill-[var(--v2-brand)]', tileStroke: '0', ink: 'white' })
    expect(draw('brand')).toEqual(draw())
  })

  it("onNavy: the mockup's solid white tile with a navy H and no border", () => {
    expect(draw('onNavy')).toEqual({ tile: 'fill-white', tileStroke: '0', ink: '#0e1230' })
  })
})
