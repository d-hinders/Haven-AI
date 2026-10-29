/**
 * #4016 class-level guard: the ops cards are deliberately UNPADDED
 * (`overflow-hidden` + `Card.Header padding="none"`), so their inset comes
 * from explicit `px-5` classes, and a default `Card.Section` may never
 * appear here — its `-mx-5 md:-mx-6` bleed assumes a `p-5 md:p-6` parent
 * these cards do not have (it gets clipped by `overflow-hidden` and its
 * border-t doubles the header band's border-b).
 *
 * The geometry itself is measured in a real browser by
 * `scripts/measure-card-inset.mjs` on `/ops/health`; this guard is the
 * source-level counterpart covering EVERY ops page (health, doc-health,
 * feedback, the customer view), so a new flush card cannot reintroduce
 * either defect:
 *
 * 1. every `Card.Header padding="none"` opening tag also carries
 *    `className="px-5"` — `padding="none"` drops the horizontal padding
 *    along with the vertical, and the rows below own `px-5`, so the title
 *    must sit at the same inset;
 * 2. every `<Card.Section>` in ops source names `divided` (rows owning
 *    `px-5`) or `inset` — never default mode.
 *
 * Comments are stripped first: both rules are restated in explanatory
 * comments next to the code they protect, and a comment must not satisfy or
 * trip the guard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { stripComments } from '@haven_ai/core/comment-stripper'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = join(__dirname, '..', '..')
const SRC = join(PACKAGE_ROOT, 'src')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      yield* walk(p)
    } else if (/\.tsx$/.test(entry)) {
      yield p
    }
  }
}

/**
 * Stripped with the shared core helper (#4411), passing the file name so the
 * `.tsx` sources keep their JSX verbatim — the old two-regex pair opened a
 * fake block at a `/*` inside a line comment (or a string) and silently
 * dropped the tags below it from the scan.
 */

/** The opening tag containing `needle`, from its `<` to its closing `>`. */
function enclosingTag(source: string, needleIndex: number): string {
  const open = source.lastIndexOf('<', needleIndex)
  const close = source.indexOf('>', needleIndex)
  return close === -1 ? source.slice(open) : source.slice(open, close + 1)
}

describe('card inset guard (#4016)', () => {
  const sources = new Map<string, string>()
  for (const file of walk(SRC)) {
    sources.set(
      relative(PACKAGE_ROOT, file).split(sep).join('/'),
      stripComments(readFileSync(file, 'utf8'), file),
    )
  }

  it('gives every padding="none" Card.Header an explicit px-5', () => {
    const violations: string[] = []
    for (const [file, source] of sources) {
      for (const match of source.matchAll(/padding="none"/g)) {
        const tag = enclosingTag(source, match.index!)
        if (!/padding="none"/.test(tag)) continue // the '<' belonged to a parent tag
        if (!/className="[^"]*\bpx-5\b[^"]*"/.test(tag)) {
          violations.push(`${file}: ${tag.slice(0, 120)}`)
        }
      }
    }
    expect(
      violations,
      `padding="none" drops horizontal padding too; these headers need className="px-5" to match the rows' px-5:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('allows no default-mode Card.Section in ops source', () => {
    const violations: string[] = []
    for (const [file, source] of sources) {
      for (const match of source.matchAll(/<Card\.Section(\s[^>]*)?>/g)) {
        const props = match[1] ?? ''
        if (!/\b(divided|inset)\b/.test(props)) {
          violations.push(`${file}: ${match[0]}`)
        }
      }
    }
    expect(
      violations,
      `a default Card.Section bleeds -mx-5 md:-mx-6, which an unpadded overflow-hidden ops card clips; use divided with rows owning px-5, or a plain padded block:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
