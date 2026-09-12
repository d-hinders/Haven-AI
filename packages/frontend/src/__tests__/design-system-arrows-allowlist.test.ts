// #2680 slice-2 guard — pins design-system.md § 5 Arrows' ONE-file raw-arrow
// allowlist ("Exactly one gated file may render a raw arrow:
// components/haven/TransactionMovement.tsx") to the repo tree. The doc used
// to carry a copy-paste shell pipeline for this; that pipeline masks only
// lines STARTING with a comment marker, so it reports five comment arrows as
// violations today — a check that needs eyeballing is not a check. This test
// implements the claim properly (comment-aware) and fails when the set
// changes. Mutation-proven for #2680: adding a second file rendering a raw
// arrow turns this red; restoring the file turns it green, byte-identical.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const FRONTEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = join(FRONTEND_ROOT, '..', '..')

// The allowlist, mirrored from docs/product/design-system.md § 5 Arrows.
// Adding a second entry there is a design-system decision (its own words) and
// must land in BOTH places in the same PR.
const ALLOWED_RAW_ARROW_FILES = new Set([
  'packages/frontend/src/components/haven/TransactionMovement.tsx',
])

/** Arrow ranges per § 5: every Unicode arrow block plus named entities. */
const ARROW_RE =
  /[\u{2190}-\u{21FF}\u{2794}-\u{27BF}\u{27F0}-\u{27FF}\u{2900}-\u{297F}\u{2B00}-\u{2BFF}]|&[a-zA-Z]*arr[a-zA-Z]*;/u

/**
 * Mask comments so prose arrows ("badge → body → list" in a JSDoc) are not
 * counted — the claim is about what a component RENDERS. Line comments are
 * stripped from the first `//` that is not part of a URL (`https://`) or a
 * string context ending in a colon-slash; block comments (JSDoc and JSX
 * brace-comment form) mask whole lines from opener to closer. String-literal
 * arrows (a quoted arrow character as rendered output) are deliberately NOT
 * masked: an arrow in a string IS rendered output, which is the thing the
 * rule governs.
 */
export function maskComments(src: string): string {
  const lines = src.split('\n')
  let inBlock = false
  let blockEnd = ''
  return lines
    .map((line) => {
      if (inBlock) {
        const close = line.indexOf(blockEnd)
        if (close === -1) return ''
        inBlock = false
        line = line.slice(close + blockEnd.length)
      }
      // JSX block comments open with `{/*`; plain block comments with `/*`.
      for (const [open, close] of [
        ['{/*', '*/}'],
        ['/*', '*/'],
      ] as const) {
        const start = line.indexOf(open)
        if (start !== -1) {
          const end = line.indexOf(close, start + open.length)
          if (end === -1) {
            inBlock = true
            blockEnd = close
            return line.slice(0, start)
          }
          line = line.slice(0, start) + line.slice(end + close.length)
        }
      }
      const at = line.indexOf('//')
      if (at > 0 && !':['.includes(line[at - 1])) return line.slice(0, at)
      if (at === 0) return ''
      return line
    })
    .join('\n')
}

/** Marketing/landing exemptions, matching § 5's bullet and design-lint. */
function isExemptSurface(file: string): boolean {
  return (
    /(^|\/)components\/(brand|marketing)\//.test(file) ||
    file === 'packages/frontend/src/app/page.tsx' ||
    /^packages\/frontend\/src\/app\/(protocols|how-it-works)\//.test(file)
  )
}

function rawArrowFiles(): { file: string; line: number }[] {
  const files = execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', 'packages/frontend/src/app', 'packages/frontend/src/components'],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => !/(__tests__|\.test\.|\.spec\.)/.test(f))
    .filter((f) => !isExemptSurface(f))
  const offenders: { file: string; line: number }[] = []
  for (const f of files) {
    maskComments(readFileSync(join(REPO_ROOT, f), 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        if (ARROW_RE.test(line)) offenders.push({ file: f, line: i + 1 })
      })
  }
  return offenders
}

describe('design-system § 5 Arrows one-file allowlist (#2680 pin)', () => {
  it('renders a raw arrow in exactly the allowlisted files', () => {
    const offenders = rawArrowFiles()
    const unexpected = offenders.filter((o) => !ALLOWED_RAW_ARROW_FILES.has(o.file))
    expect(
      unexpected,
      `design-system.md § 5 allows a raw arrow ONLY in ${[...ALLOWED_RAW_ARROW_FILES].join(', ')}; found in:\n` +
        unexpected.map((o) => `  ${o.file}:${o.line}`).join('\n') +
        '\nIf this is a deliberate design-system decision, update BOTH the doc\'s allowlist and ALLOWED_RAW_ARROW_FILES here in the same PR.',
    ).toEqual([])
  })

  it('the allowlisted file actually still renders one (the allowlist is not stale)', () => {
    const offenders = rawArrowFiles()
    for (const f of ALLOWED_RAW_ARROW_FILES) {
      expect(
        offenders.some((o) => o.file === f),
        `${f} is on the § 5 allowlist but renders no raw arrow any more — remove the allowlist entry in the same PR`,
      ).toBe(true)
    }
  })
})
