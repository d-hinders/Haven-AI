import { describe, expect, it } from 'vitest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script; typed via the casts below
import {
  exportedComponentsInLine,
  addedExportsFromDiff,
  undocumentedPrimitives,
  addedExportsInFile,
  dedupe,
} from '../../scripts/design-system-coupling.mjs'

const exportsInLine = exportedComponentsInLine as (line: string) => string[]
const fromDiff = addedExportsFromDiff as (
  diff: string,
) => { file: string; symbol: string; exempt: boolean }[]
const inFile = addedExportsInFile as (
  file: string,
  contents: string,
) => { file: string; symbol: string; exempt: boolean }[]
const dedup = dedupe as (
  added: { file: string; symbol: string; exempt: boolean }[],
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

/**
 * The local run reads the working tree (#2826).
 *
 * ## Why these two functions carry the fix
 *
 * The gate used to compute its local diff as `origin/dev...HEAD` alone —
 * committed work only. A primitive that was written but not yet committed was
 * therefore invisible, and the run printed "no undocumented primitives added"
 * and exited 0. That is precisely when ship-next invokes it: during review,
 * before the commit. CI, which sets BASE_SHA/HEAD_SHA, then failed the
 * required **Design-system coupling (strict)** check on the same tree.
 *
 * The union that fixes it is three `git` calls, which a unit test cannot
 * usefully assert on. What it CAN assert on are the two pure pieces the union
 * is built from, and they are where the behaviour actually lives:
 *
 *  - `untrackedFileDiff` renders a brand-new file — the shape this gate exists
 *    to catch, and the one no `git diff` form emits, `git diff HEAD` included —
 *    as a diff the existing parser reads. If it stops producing something
 *    `addedExportsFromDiff` understands, the fix silently reverts to a false
 *    green, so the assertion is made by round-tripping the two together rather
 *    than by matching the diff text.
 *  - `dedupe` handles the union's one new hazard: the same export reachable
 *    twice, committed and again in the working tree.
 *
 * End-to-end proof that the CLI goes red on an uncommitted primitive is a
 * mutation run against the real entry point, recorded in the pull request —
 * this is the part that belongs in the suite.
 */
describe('local runs read the working tree (#2826)', () => {
  it('finds an export in an untracked primitive, which no git diff form emits', () => {
    expect(
      inFile('packages/frontend/src/components/ui/Gauge.tsx', 'export function Gauge() {}\n'),
    ).toEqual([{ file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false }])
  })

  it('honours a trailing exempt marker in an untracked file', () => {
    expect(
      inFile(
        'packages/frontend/src/components/ui/Gauge.tsx',
        'export function Gauge() {} // design-system-exempt: internal\n',
      )[0].exempt,
    ).toBe(true)
  })

  it('ignores an untracked file outside the primitive directories', () => {
    expect(inFile('packages/frontend/src/lib/thing.ts', 'export function Thing() {}\n')).toEqual([])
  })

  /**
   * File CONTENT cannot forge a diff file header.
   *
   * The first version of this fix rendered untracked files into diff text and
   * fed them back through addedExportsFromDiff. Every content line gains a `+`
   * there, so a source line beginning `++ ` arrives as `+++ ` — which that
   * parser reads as a file header. It then re-points at that path and silently
   * drops every export after it: a gate going green because of what a file
   * happened to contain, which is the one posture it must not have. Scanning
   * the file directly removes the round trip; this asserts the property rather
   * than the mechanism, so it still means something if the internals change.
   */
  it('reads exports after a line that would forge a diff header', () => {
    const contents = '// docs example:\n++ b/docs/README.md\nexport function Sneaky() {}\n'
    expect(inFile('packages/frontend/src/components/ui/Sneaky.tsx', contents)).toEqual([
      { file: 'src/components/ui/Sneaky.tsx', symbol: 'Sneaky', exempt: false },
    ])
  })

  it('collapses an export the union sees twice', () => {
    const twice = [
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false },
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false },
    ]
    expect(dedup(twice)).toEqual([
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false },
    ])
  })

  /**
   * The newest occurrence wins in BOTH directions (#2826, review round 1).
   *
   * dedupe originally OR-ed the exempt flags, on the reasoning that the working
   * tree is the newest state. The reasoning was right and the OR did not encode
   * it: OR is order-blind, so it produced the newest answer only when the newest
   * answer happened to be `true`.
   *
   * The second case is the fail-open that cost — commit the marker, then delete
   * it in the working tree, the ordinary "a reviewer said that is not internal"
   * move made before the commit. OR resolved it to exempt, so the local run
   * exited 0 on a tree CI reddens, falsifying the guarantee this change is for.
   */
  it('an exemption added in the working tree wins over the committed state', () => {
    const added = dedup([
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false }, // committed
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: true }, // working tree
    ])
    expect(undocumented(added, 'import { Button } from "..."')).toEqual([])
  })

  it('an exemption REMOVED in the working tree also wins — the fail-open direction', () => {
    const added = dedup([
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: true }, // committed
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false }, // working tree
    ])
    expect(added).toEqual([{ file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false }])
    expect(undocumented(added, 'import { Button } from "..."')).toEqual([
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge' },
    ])
  })

  it('keeps distinct symbols in the same file apart', () => {
    const added = dedup([
      { file: 'src/components/ui/Gauge.tsx', symbol: 'Gauge', exempt: false },
      { file: 'src/components/ui/Gauge.tsx', symbol: 'GaugeLabel', exempt: false },
    ])
    expect(added.map((a) => a.symbol)).toEqual(['Gauge', 'GaugeLabel'])
  })
})
