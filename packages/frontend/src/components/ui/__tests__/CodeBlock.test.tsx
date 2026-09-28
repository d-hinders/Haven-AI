import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodeBlock } from '../CodeBlock'

/**
 * #3434: `wrap` is opt-in. These pin the classes on the `<pre>`; the layout
 * itself (the `--doctor` tail visible at 390px) is judged on the
 * design-system sample, which jsdom cannot lay out.
 */
const DEFAULT_PRE = 'px-5 py-4 text-[13px] leading-[1.65] text-white/90 font-mono overflow-x-auto v2-tabular'

const preOf = (ui: React.ReactElement) => {
  const { container } = render(ui)
  const pre = container.querySelector('pre')
  if (!pre) throw new Error('no <pre>')
  return pre
}

describe('CodeBlock wrap classes (#3434)', () => {
  it('keeps the default class list byte-identical: scrolls, never wraps', () => {
    const pre = preOf(<CodeBlock>npx -y @haven_ai/connect@alpha --doctor</CodeBlock>)
    expect(pre.className).toBe(DEFAULT_PRE)
    expect(pre.className).not.toMatch(/whitespace-pre-wrap|overflow-wrap/)
  })

  it('with wrap, wraps anywhere and drops the horizontal scroll', () => {
    const pre = preOf(<CodeBlock wrap>npx -y @haven_ai/connect@alpha --doctor</CodeBlock>)
    expect(pre.className).toContain('whitespace-pre-wrap')
    expect(pre.className).toContain('[overflow-wrap:anywhere]')
    expect(pre.className).not.toContain('overflow-x-auto')
  })

  it('wrapping changes no text: the copied command is the same string', () => {
    const pre = preOf(<CodeBlock wrap>npx -y @haven_ai/connect@alpha --doctor</CodeBlock>)
    expect(pre.textContent).toBe('npx -y @haven_ai/connect@alpha --doctor')
  })
})
