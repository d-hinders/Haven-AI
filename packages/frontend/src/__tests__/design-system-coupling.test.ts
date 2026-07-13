import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the casts below
import {
  exportedComponentsInLine,
  addedExportsFromDiff,
  undocumentedPrimitives,
} from '../../scripts/design-system-coupling.mjs'

const exportsInLine = exportedComponentsInLine as (line: string) => string[]
const fromDiff = addedExportsFromDiff as (
  diff: string,
) => { file: string; symbol: string; exempt: boolean }[]
const undocumented = undocumentedPrimitives as (
  added: { file: string; symbol: string; exempt: boolean }[],
  page: string,
) => { file: string; symbol: string }[]

const diff = (file: string, ...added: string[]) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` +
  added.map((l) => `+${l}`).join('\n') +
  '\n'

describe('design-system coupling gate (#898)', () => {
  it('extracts PascalCase component exports, ignores types + lowercase helpers', () => {
    expect(exportsInLine('export const Foo = () => null')).toEqual(['Foo'])
    expect(exportsInLine('export function BudgetCard(props) {')).toEqual(['BudgetCard'])
    expect(exportsInLine('export { A, B as Baz } from "./x"')).toEqual(['A', 'Baz'])
    // type-only re-exports and lowercase helpers are not primitives
    expect(exportsInLine('export { type AmountDirection } from "./Amount"')).toEqual([])
    expect(exportsInLine('export const entityCardStyles = {}')).toEqual([])
  })

  it('flags a new ui/ export absent from the reference page', () => {
    const added = fromDiff(diff('src/components/ui/Gauge.tsx', 'export const Gauge = () => null'))
    expect(added).toEqual([{ file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false }])
    expect(undocumented(added, 'import { Button } from "..."')).toEqual([
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge' },
    ])
  })

  it('passes when the new primitive appears on the page (import, JSX, or prose)', () => {
    const added = fromDiff(diff('src/components/haven/Gauge.tsx', 'export const Gauge = () => null'))
    expect(undocumented(added, "import { Gauge } from '@/components/haven'")).toEqual([])
    expect(undocumented(added, '<Gauge value={1} />')).toEqual([])
  })

  it('honours // design-system-exempt on the export line', () => {
    const added = fromDiff(
      diff(
        'src/components/ui/Toast.tsx',
        'export const ToastProvider = () => null // design-system-exempt: infra wrapper',
      ),
    )
    expect(added[0].exempt).toBe(true)
    expect(undocumented(added, 'no mention here')).toEqual([])
  })

  it('is diff-scoped: only ADDED lines count, and only ui/haven files', () => {
    // A context (unchanged) line is not an addition:
    const ctxOnly =
      `diff --git a/src/components/ui/Card.tsx b/src/components/ui/Card.tsx\n` +
      `--- a/src/components/ui/Card.tsx\n+++ b/src/components/ui/Card.tsx\n` +
      ` export const Card = () => null\n`
    expect(fromDiff(ctxOnly)).toEqual([])
    // A new export outside the primitive dirs is ignored:
    expect(fromDiff(diff('src/app/dashboard/Widget.tsx', 'export const Widget = () => null'))).toEqual(
      [],
    )
    // …and the barrel re-export file itself is not a source of truth:
    expect(fromDiff(diff('src/components/haven/index.ts', 'export { Gauge } from "./Gauge"'))).toEqual(
      [],
    )
  })

  it('collects members on the OPENING line of a multi-line export list', () => {
    // Regression (code review 2026-07-13): NewGauge was dropped because brace
    // mode was only entered after member extraction had already failed.
    const added = fromDiff(
      diff('src/components/ui/kit.tsx', 'export { NewGauge,', '  Dial,', "} from './gauges'"),
    )
    expect(added.map((a) => a.symbol).sort()).toEqual(['Dial', 'NewGauge'])
  })

  it('matches export-default primitives (named and anonymous)', () => {
    // Six existing ui/ primitives are export-default (Input, Row, Skeleton,
    // PageHeader, Toast, Tooltip) — the style MUST be gated.
    const named = fromDiff(diff('src/components/ui/Gauge.tsx', 'export default function Gauge() {'))
    expect(named.map((a) => a.symbol)).toEqual(['Gauge'])
    const ref = fromDiff(diff('src/components/ui/Gauge.tsx', 'export default Gauge'))
    expect(ref.map((a) => a.symbol)).toEqual(['Gauge'])
    // Anonymous default → the file basename IS the primitive name:
    const anon = fromDiff(diff('src/components/ui/Meter.tsx', 'export default () => null'))
    expect(anon.map((a) => a.symbol)).toEqual(['Meter'])
  })

  it('normalises the repo-root prefix git emits from the package cwd', () => {
    // `git diff` run in packages/frontend still prints repo-root-relative paths.
    const added = fromDiff(
      diff('packages/frontend/src/components/ui/Gauge.tsx', 'export const Gauge = () => null'),
    )
    expect(added).toEqual([{ file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false }])
  })

  it('ignores export text living in comments or string literals (not real exports)', () => {
    const f = 'src/components/ui/Gauge.tsx'
    // JSDoc gutter line, plain line comment, and a code-sample string literal:
    expect(fromDiff(diff(f, ' *   export const MyButton = styled(Button)'))).toEqual([])
    expect(fromDiff(diff(f, '// export const Legacy = () => null'))).toEqual([])
    expect(fromDiff(diff(f, 'const code = `export const Demo = 1`'))).toEqual([])
    // …but a real export on the same file still registers:
    expect(fromDiff(diff(f, 'export const Gauge = () => null')).map((a) => a.symbol)).toEqual([
      'Gauge',
    ])
  })

  it('collects a multi-line export { … } list across its added member lines', () => {
    const added = fromDiff(
      diff('src/components/haven/kit.tsx', 'export {', '  Gauge,', '  Meter as Dial,', '} from "./x"'),
    )
    expect(added.map((a) => a.symbol).sort()).toEqual(['Dial', 'Gauge'])
  })

  it('only exempts on a real trailing // design-system-exempt: marker', () => {
    const f = 'src/components/ui/Gauge.tsx'
    // A loose prose mention without the colon marker does NOT exempt:
    const loose = fromDiff(diff(f, 'export const Gauge = () => null // per design-system-exempt convention'))
    expect(loose[0].exempt).toBe(false)
    // The real marker does:
    const real = fromDiff(diff(f, 'export const Gauge = () => null // design-system-exempt: internal'))
    expect(real[0].exempt).toBe(true)
  })

  it('excludes .stories and index files as primitive sources', () => {
    expect(fromDiff(diff('src/components/ui/Gauge.stories.tsx', 'export const Primary = () => null'))).toEqual(
      [],
    )
    expect(fromDiff(diff('src/components/haven/index.tsx', 'export const Gauge = () => null'))).toEqual([])
  })
})
