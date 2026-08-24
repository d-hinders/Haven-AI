/**
 * `WalletPopover`'s `presentational` prop stays confined to `/design-system` (#1975).
 *
 * The prop is correct and this guard does not argue against it. #1952 (PR #1973)
 * needed a showcase copy of the popover that is NOT announced as a live dialog,
 * and the two alternatives were worse: scoping `e2e/modal-scroll-cue.spec.ts`'s
 * query would weaken a real document-wide invariant, and reordering the demos in
 * the DOM would leave two decorative nodes still claiming `role="dialog"`.
 *
 * What was missing is enforcement. Until this file, the rule was a doc-comment
 * plus the fact that someone ran a grep at review time — a snapshot, not a guard.
 * The plausible failure is specific: a future author hits a hard accessibility
 * complaint on a real surface, finds a prop that silences it, and passes it, and
 * nothing goes red. The invariant that would break is the one
 * `e2e/modal-scroll-cue.spec.ts` (#1893) asserts DOCUMENT-WIDE — exactly one live
 * `role="dialog"` — and one of its assertions reaches for a raw
 * `document.querySelector('[role="dialog"]')`, which no `aria-hidden` or `inert`
 * wrapper can redirect.
 *
 * ## Why a scan test and not a new lint family
 *
 * `design-lint`, `wire-types` and `db-mocks` are shrink-only ratchets: each guards
 * a rule with real pre-existing debt, so each needs a committed baseline that may
 * only get smaller. This rule has NO debt — the allowed set is exactly the two
 * showcase call sites — so a baseline would be a hole to baseline violations into
 * rather than a ratchet. Reading source text from a test has direct precedent in
 * this repo for exactly this shape of property (`chain-default-guard.test.ts`,
 * `non-custody.invariants.test.ts`): the claim is about what every FUTURE writer
 * must do, and no runtime test can observe a line nobody has written yet. Running
 * here also costs no shared config: the frontend unit suite is already a required
 * check on every pull request.
 *
 * ## What this guard cannot see
 *
 * A `presentational` reaching a call site through a spread (`<WalletPopover
 * {...props} />`) is invisible to a text scan, as is a rename at an intermediate
 * wrapper. Neither is a live shape today — `WalletButton` builds every popover's
 * props inline — and both would be a deliberate act rather than the careless one
 * this guard exists to refuse.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const HERE = path.dirname(SELF)
const FRONTEND_SRC = path.resolve(HERE, '../..')
const WALLET_BUTTON = path.join(FRONTEND_SRC, 'components/WalletButton.tsx')

/**
 * The ONLY directory whose files may pass `presentational`. The showcase is a
 * gallery of illustrations; nothing there is a live overlay.
 */
const SHOWCASE_DIR = 'app/(authenticated)/design-system'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Return the attribute text of every `<WalletPopover …>` opening tag in `source`.
 *
 * Walks to the `>` that closes the tag while tracking brace depth and quoting, so
 * a `>` inside an expression attribute (`onClose={() => onClose()}`) does not end
 * the tag early — the naive `indexOf('>')` gets every real call site wrong.
 */
function walletPopoverOpeningTags(source: string): { attrs: string; index: number }[] {
  const tags: { attrs: string; index: number }[] = []
  const opener = /<WalletPopover(?![A-Za-z0-9_])/g
  let match: RegExpExecArray | null

  while ((match = opener.exec(source)) !== null) {
    let depth = 0
    let quote: string | null = null
    let i = match.index + match[0].length

    for (; i < source.length; i++) {
      const ch = source[i]
      if (quote) {
        if (ch === '\\') i++
        else if (ch === quote) quote = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch
      else if (ch === '{') depth++
      else if (ch === '}') depth--
      else if (ch === '>' && depth === 0) break
    }

    tags.push({ attrs: source.slice(match.index + match[0].length, i), index: match.index })
  }

  return tags
}

const PRESENTATIONAL_ATTR = /(?:^|[\s{])presentational(?![A-Za-z0-9_])/

describe('WalletPopover presentational guard (#1975)', () => {
  it('never lets a WalletButton call site render the popover as presentational', () => {
    const source = readFileSync(WALLET_BUTTON, 'utf8')
    const tags = walletPopoverOpeningTags(source)

    // If this ever reads 0, the scan stopped seeing the call sites and the
    // assertion below would pass vacuously — a guard that cannot say no.
    expect(tags.length).toBeGreaterThan(0)

    const offenders = tags
      .filter((tag) => PRESENTATIONAL_ATTR.test(tag.attrs))
      .map((tag) => `line ${source.slice(0, tag.index).split('\n').length}`)

    expect(offenders, [
      'WalletButton renders the LIVE wallet popover. Passing `presentational` here',
      'strips role="dialog" from a real overlay and breaks the document-wide',
      'single-dialog invariant that e2e/modal-scroll-cue.spec.ts (#1893) asserts.',
      'If a real surface needs this prop, that is a product decision — argue it in',
      'review and change this guard deliberately, not by adding an attribute.',
    ].join(' ')).toEqual([])
  })

  it('confines the presentational prop to the /design-system showcase', () => {
    const files = walk(FRONTEND_SRC)
    const offenders: string[] = []
    let showcaseUsages = 0

    for (const file of files) {
      // This guard quotes `<WalletPopover presentational` in its own prose and
      // matcher. Scanning itself is not a finding — it did fire on the first
      // run, which is incidental evidence that the walk really reads source.
      if (file === SELF) continue
      const rel = path.relative(FRONTEND_SRC, file)
      const source = readFileSync(file, 'utf8')
      if (!source.includes('<WalletPopover')) continue

      for (const tag of walletPopoverOpeningTags(source)) {
        if (!PRESENTATIONAL_ATTR.test(tag.attrs)) continue
        const line = source.slice(0, tag.index).split('\n').length
        if (rel.startsWith(SHOWCASE_DIR)) showcaseUsages++
        else offenders.push(`${rel}:${line}`)
      }
    }

    // The showcase usages are the reason the prop exists. Losing them means the
    // scan is looking at the wrong text, so the empty-offenders result below
    // would prove nothing.
    expect(showcaseUsages).toBeGreaterThan(0)

    expect(
      offenders,
      `\`presentational\` may only be passed under ${SHOWCASE_DIR}/ — see the ` +
        'doc-comment on the prop in components/WalletButton.tsx (#1975).',
    ).toEqual([])
  })

  it('keeps the prop opt-in, so a product call site cannot inherit it by default', () => {
    const source = readFileSync(WALLET_BUTTON, 'utf8')

    // Flipping the destructuring default to `true` would make every call site
    // that says nothing presentational — bypassing both assertions above without
    // adding a single attribute anywhere.
    expect(source).toMatch(/\bpresentational\s*=\s*false\b/)
    expect(source).not.toMatch(/\bpresentational\s*=\s*true\b/)
  })
})
