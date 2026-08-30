/**
 * A permanently-open showcase copy of an overlay keeps its `inert` +
 * `aria-hidden` wrapper (#2002).
 *
 * `/design-system` renders most overlays LIVE — `Modal`, `SidePanel`,
 * `ConfirmDialog`, `InfoModal`, `ComingSoonModal`, `DropdownMenu`, `Tooltip` and
 * `Toast` all open from a real trigger, so the copy on the page IS the component.
 * Exactly one showcase is held permanently open: `WalletPopover`'s two
 * signing-credential states, side by side, because the blocking pixel gate
 * captures the page at rest and a trigger-driven overlay is photographed shut.
 *
 * That copy is not a dialog, and what takes it out of the accessibility tree and
 * the tab order is the ancestor `<div inert aria-hidden="true">` wrapper — NOT
 * the copy's own `role`. The measurements behind that split are recorded ONCE,
 * on the `presentational` prop's doc-comment in `components/WalletButton.tsx`
 * (#1982); the rule they support is in `docs/product/design-system.md` § 6.
 * Read them there. This file is the enforcement, not a fourth copy of the prose.
 *
 * ## The gap this closes, stated as the shape it is
 *
 * `components/__tests__/wallet-popover-presentational-guard.test.ts` (#1975) is a
 * CONFINEMENT rule: the `presentational` prop may not escape the showcase. This
 * is the COMPLETENESS rule — the same three-question split § 6 already records
 * for focus rings (#1867). A confinement check only ever looks at call sites that
 * ALREADY use the mechanism, so the next author who holds a different overlay
 * permanently open and never reaches for the wrapper at all contributes nothing
 * to scan and is invisible by construction. That author is the whole population
 * this guard exists for.
 *
 * ## Why a scan test and not a lint family or a rendered spec
 *
 * Same reasoning as #1975's, and not restated beyond the load-bearing half:
 * `design-lint` / `wire-types` / `db-mocks` are shrink-only ratchets that need a
 * committed baseline because they guard rules with real pre-existing debt. This
 * rule has NO debt — both permanently-open showcases comply — so a baseline would
 * be a hole to baseline violations into. And no RENDERED test can observe a
 * showcase nobody has written yet; the claim is about every future writer.
 *
 * ## What this guard cannot see
 *
 * It finds a showcase that is rendered UNCONDITIONALLY and carries a LITERAL
 * `open` attribute (`open` or `open={true}`). That marker is component-agnostic
 * on purpose — an allowlist of "which components are overlays" is a list that
 * goes stale silently and then reports a confident zero. The cost is the
 * complement:
 *
 * - a copy held open some other way — `useState(true)`, a `defaultOpen`/
 *   `forceOpen`-shaped prop, or a component that simply renders its overlay body
 *   unconditionally — is invisible here;
 * - a wrapper supplied by a COMPONENT rather than by an inline JSX element would
 *   be reported as a violation, because the ancestor walk only sees JSX in these
 *   files. That errs toward red, which is the safe direction for a guard;
 * - it says nothing about whether the showcase's copy matches the component's, or
 *   about any behaviour at all. A showcase is a rendering of appearance, never a
 *   test of behaviour — § 6 says what the reviewer must therefore still do
 *   elsewhere, and no check can carry that half.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_SRC = path.resolve(HERE, '..')
const SHOWCASE_DIR = 'app/(authenticated)/design-system'
const SHOWCASE_ROOT = path.join(FRONTEND_SRC, SHOWCASE_DIR)

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) tsxFiles(full, out)
    else if (full.endsWith('.tsx')) out.push(full)
  }
  return out
}

type OpeningLike = ts.JsxOpeningElement | ts.JsxSelfClosingElement

function attribute(node: OpeningLike, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (prop): prop is ts.JsxAttribute =>
      ts.isJsxAttribute(prop) && ts.isIdentifier(prop.name) && prop.name.text === name,
  )
}

/**
 * Is `name` present on this element as a literal true — a bare attribute, or one
 * initialised with `{true}` or `"true"`?
 *
 * `open={someState}` is deliberately NOT literal true: a state-driven overlay is
 * the live, trigger-opened case this rule does not govern.
 */
function isLiteralTrue(node: OpeningLike, name: string): boolean {
  const attr = attribute(node, name)
  if (!attr) return false
  if (attr.initializer === undefined) return true
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text === 'true'
  if (
    ts.isJsxExpression(attr.initializer) &&
    attr.initializer.expression &&
    attr.initializer.expression.kind === ts.SyntaxKind.TrueKeyword
  ) {
    return true
  }
  return false
}

function tagName(node: OpeningLike): string {
  return node.tagName.getText(node.getSourceFile())
}

function lineOf(node: ts.Node): number {
  const sf = node.getSourceFile()
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** The wrapper the rule requires: BOTH attributes, on one element. */
function isSuppressingWrapper(node: OpeningLike): boolean {
  return isLiteralTrue(node, 'inert') && isLiteralTrue(node, 'aria-hidden')
}

/**
 * Is this element rendered unconditionally — i.e. always on the page — rather
 * than gated behind a `{cond ? <X/> : null}` / `{cond && <X/>}` expression?
 *
 * This is the second half of "permanently open", and it is not pedantry. The
 * showcase's OWN `ConfirmDialog` demo is written `{confirmOpen ? <ConfirmDialog
 * open … /> : null}`: a literal `open` attribute on a LIVE, trigger-driven
 * dialog, whose openness is carried by the conditional instead. Keying on the
 * attribute alone would report the page's best-behaved overlay as a violation.
 *
 * Only an explicit gate — a conditional expression or a logical `&&`/`||` —
 * counts as one. A `.map()` or any other expression does NOT exempt an element:
 * a static array of open popovers is still permanently open, and an unknown
 * shape should land in the red set rather than quietly leave it.
 */
function isUnconditionallyRendered(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (!ts.isJsxExpression(current) || !current.expression) continue
    const expr = current.expression
    if (ts.isConditionalExpression(expr)) return false
    if (
      ts.isBinaryExpression(expr) &&
      (expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        expr.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
    ) {
      return false
    }
  }
  return true
}

function hasSuppressingAncestor(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isJsxElement(current) && isSuppressingWrapper(current.openingElement)) return true
  }
  return false
}

interface Finding {
  file: string
  line: number
  tag: string
}

function scan(): { permanentlyOpen: Finding[]; unwrapped: Finding[]; halfApplied: Finding[] } {
  const permanentlyOpen: Finding[] = []
  const unwrapped: Finding[] = []
  const halfApplied: Finding[] = []

  for (const file of tsxFiles(SHOWCASE_ROOT)) {
    const rel = path.relative(FRONTEND_SRC, file)
    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TSX,
    )

    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const where: Finding = { file: rel, line: lineOf(node), tag: tagName(node) }
        if (isLiteralTrue(node, 'inert') && !isLiteralTrue(node, 'aria-hidden')) {
          halfApplied.push(where)
        }
        if (isLiteralTrue(node, 'open') && isUnconditionallyRendered(node)) {
          permanentlyOpen.push(where)
          if (!hasSuppressingAncestor(node)) unwrapped.push(where)
        }
      }
      ts.forEachChild(node, visit)
    }

    visit(sourceFile)
  }

  return { permanentlyOpen, unwrapped, halfApplied }
}

const format = (f: Finding) => `${f.file}:${f.line} <${f.tag}>`

describe('permanently-open showcase copies of overlays (#2002)', () => {
  const { permanentlyOpen, unwrapped, halfApplied } = scan()

  it('finds the permanently-open showcases at all, so the rule below cannot pass vacuously', () => {
    // A scan that stops seeing its subject reports a confident zero and every
    // assertion after it is an empty set congratulating itself. This is the
    // positive control: it goes red when the population disappears, whether the
    // showcases were removed or the marker this guard keys on moved.
    expect(
      permanentlyOpen.length,
      `No permanently-open showcase found under ${SHOWCASE_DIR}/. Either they are ` +
        'gone — in which case delete this guard deliberately — or they are now held ' +
        'open by something other than a literal `open` attribute, which this scan ' +
        'cannot see. See "What this guard cannot see" in this file.',
    ).toBeGreaterThan(0)
  })

  it('keeps every permanently-open showcase inside an inert + aria-hidden wrapper', () => {
    expect(
      unwrapped.map(format),
      [
        'A showcase copy held permanently open must sit inside an ancestor',
        '`<div inert aria-hidden="true">`. That wrapper is what removes it from the',
        'accessibility tree and the tab order; changing the copy\'s own `role` does',
        'NOT — measured in real Chromium on #1982. Without it the page exposes a',
        'labelled control group whose handlers do nothing. See',
        'docs/product/design-system.md § 6 and the `presentational` doc-comment in',
        'components/WalletButton.tsx.',
      ].join(' '),
    ).toEqual([])
  })

  it('never lets a wrapper carry inert without aria-hidden', () => {
    // The half-applied form of the same pattern, and the reason the rule names
    // the PAIR rather than either attribute: #1982's measurement is of the pair.
    // Do not read this as a claim about what `inert` alone does in any browser —
    // that was not measured, and a guard should not assert what nobody ran.
    expect(
      halfApplied.map(format),
      '`inert` in the showcase is half of a two-attribute pattern; add `aria-hidden="true"` ' +
        'to the same element (docs/product/design-system.md § 6).',
    ).toEqual([])
  })
})
