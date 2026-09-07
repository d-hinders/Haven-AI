import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import postcss from 'postcss'
import tailwindcss from 'tailwindcss'
import { describe, expect, it } from 'vitest'

/**
 * Every colour utility that carries an opacity modifier must actually COMPILE
 * to a colour (#1818).
 *
 * Tailwind v3 drops an opacity modifier it cannot re-compose. There is no error,
 * no warning, and no class in the output — the markup keeps reading correctly
 * while the declaration simply does not exist. The repo has now been bitten
 * three times by that one behaviour:
 *
 *   1. #1708 — 68 `ring-[var(--v2-*)]/N` focus rings compiled to nothing, so
 *      every focus ring in the product rendered preflight's blue-500/50.
 *   2. #1798 — `Toast`'s `ring-current/30`. Same defect, different SHAPE:
 *      `currentColor` has no channels either, and #1708's `[var(--v2-*)]/N`
 *      regex could not match it.
 *   3. #1818 — `TopBar`'s `bg-[var(--v2-bg)]/85`. Found by accident, while
 *      mutation-testing the visual gate: the mutation went green because the
 *      class it mutated FROM and the class it mutated TO both compiled to
 *      nothing, so the two renders were byte-identical.
 *
 * Three times is the argument for this file. The first two fixes were each
 * paired with a guard that matched the shape in front of it, and the next
 * occurrence arrived wearing a shape that guard could not see. So this one does
 * not pattern-match source at all.
 *
 * **It reads every opacity-modified colour utility out of the product source,
 * compiles it through the real `tailwind.config.js`, and asks whether a colour
 * declaration came out.** A source-level rule cannot answer that question —
 * which is precisely why 68 call-sites survived review — and a guard that asks
 * it is indifferent to which shape the next one wears.
 *
 * Three shapes are already known to drop, and they have nothing in common at
 * the source level:
 *
 *   - `bg-[var(--v2-bg)]/85`   — an opacity modifier on a bare `var()`
 *   - `ring-current/30`        — an opacity modifier on `currentColor`
 *   - `text-white/78`          — a perfectly good colour with an off-scale
 *                                numeric modifier (`78` is not a step on
 *                                Tailwind's opacity scale; `/[0.78]` is the
 *                                arbitrary form and does compile)
 *
 * The third was found BY this guard while it was being written, in
 * the retired investor-briefing page — a marketing surface that design-lint
 * exempted, carrying a shape no `var()`-oriented rule would ever have looked
 * for. It remains as historical evidence that shape-matching was the wrong
 * altitude.
 *
 * **Relationship to the two existing guards**, since all three now touch this
 * behaviour and it should be clear which one to edit:
 *
 *   - `design-token-alpha.test.ts` (#1708) guards the MECHANISM — that no theme
 *     colour is a bare `var()` and that every channel token stays in sync with
 *     its hex. It is about `tailwind.config.js` and `globals.css`.
 *   - `focus-ring.test.ts` (#1741/#1746/#1792) guards the focus-ring TREATMENT,
 *     including that every ring utility in use compiles. Rings only.
 *   - this file guards every OTHER colour utility, and is the one that is
 *     shape-agnostic. `ring-current/30` is deliberately re-pinned below even
 *     though `focus-ring.test.ts` also pins it: here it is one row of the
 *     three-shape table, and the table's point is that the three have nothing
 *     in common at the source level. Dropping the row to avoid the overlap
 *     would remove the evidence for that claim.
 */

const FRONTEND = resolve(__dirname, '../..')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindConfig = require(join(FRONTEND, 'tailwind.config.js'))

/** Booting real Tailwind is a real compile; vitest's 5s default would flake. */
const COMPILE_TIMEOUT = 60_000

// ── the inventory ──────────────────────────────────────────────────────────

/**
 * The dead classes that are KNOWN, TRIAGED and owned by another issue.
 *
 * This is not a tolerance and it is not a baseline of "things we gave up on".
 * Epic #1685 measured 175 dead classes and deliberately sliced them by utility,
 * because a single sweep would repaint ~70 files and no reviewer could
 * sanity-check that diff. #1709 owns the `border-*` family; #1710 owns what is
 * left of `bg-*`/`text-*` plus the design-lint rule. Sweeping them here would
 * undo that slicing, so they are recorded rather than fixed.
 *
 * What the recording BUYS is the thing the previous two guards did not have: a
 * new dead class — in any shape, on any utility, in any file — is not in this
 * map, so it fails immediately. The inventory is the known-bad set, and the
 * guard fires on everything outside it.
 *
 * Shrink-only, and enforced in both directions. `every entry is still dead`
 * below fails when an entry stops being dead, so closing #1709/#1710 makes this
 * file red until the fixed entries are DELETED from the map. An inventory that
 * can be left behind after its reason expires is how a guard quietly becomes a
 * list of excuses.
 */
const KNOWN_DEAD: Record<string, string> = {
  // EMPTY, and that is the point (#1710 closed epic #1685).
  //
  // Every one of the 175 dead call-sites is converted: #1708 the 68 rings,
  // #1709 the 91 borders plus one bracketed `bg-`, #1818 the TopBar background
  // and the mobile scrim, #1710 the last 9. With nothing triaged, the
  // `no dead class outside the triaged inventory` assertion below stops being a
  // ratchet and becomes an ABSOLUTE gate: any opacity-modified colour utility
  // that compiles to nothing now fails, with no escape hatch to add one to.
  //
  // Do not reintroduce an entry. There is no longer a slice that owes debt
  // here, so a new key would be a tolerance rather than a queue — which is what
  // the ceiling below refuses.
}

// ── reading the call-sites ─────────────────────────────────────────────────

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(full)) acc.push(full)
  }
  return acc
}

/**
 * Comments removed, everything else kept.
 *
 * Comments have to go: both `Toast.tsx` and `ConnectStepShell.tsx` quote a dead
 * class inside a comment explaining why it was removed, and counting those as
 * live call-sites makes the guard fail on its own documentation — which teaches
 * people to delete the explanation.
 *
 * The line-comment rule refuses to fire after `:` so that a URL in a string
 * (`href="https://…" className="border-…/20"`) does not take the rest of the
 * line with it. That direction of error is the dangerous one: a swallowed line
 * is a class the scan never sees, and a guard that goes quietly blind is the
 * exact failure this file exists to prevent.
 *
 * An earlier draft walked the file character by character extracting string
 * literals instead. It desynced on the first apostrophe in ordinary JSX text
 * (`<p>Haven's account</p>` opens a "string" that runs to the next quote) and
 * silently lost six real call-sites across four files. The `orphaned` assertion
 * below is what caught it — which is the argument for keeping that assertion
 * even though its stated purpose is inventory hygiene.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments, incl. the JSX {/* … */} form
    .replace(/(^|[^:"'`\w])\/\/[^\n]*/gm, '$1')
}

/** Colour-bearing utility prefixes that accept an opacity modifier. */
const PREFIX =
  '(?:bg|text|border|border-[trblxyse]|ring|ring-offset|from|via|to|fill|stroke|outline|divide|accent|caret|decoration|placeholder|shadow)'

/** e.g. `hover:focus:bg-[var(--v2-brand)]/15`, `text-white/78`, `bg-brand/[0.03]`. */
const BOUND = '[\\s"\'`{}]'
const UTILITY = new RegExp(
  `(?:^|${BOUND})((?:[a-z-]+:)*(${PREFIX}-(?:\\[[^\\]\\s]*\\]|[a-z0-9-]+)\\/(?:\\[[^\\]\\s]*\\]|\\d{1,3})))(?=$|${BOUND})`,
  'g',
)

interface Use {
  /** The utility with its variant prefixes stripped, e.g. `bg-brand/15`. */
  base: string
  file: string
}

/**
 * Every opacity-modified colour utility in the product source, keyed by its
 * BASE form. Variants are stripped because `hover:` and `focus-visible:` wrap a
 * utility, they do not change how its colour resolves — so `hover:bg-x/15` and
 * `bg-x/15` live or die together, and deduping them keeps this to one compile.
 */
function uses(): Use[] {
  const out: Use[] = []
  for (const file of sourceFiles(join(FRONTEND, 'src'))) {
    const rel = relative(FRONTEND, file)
    const text = stripComments(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(UTILITY)) out.push({ base: m[2], file: rel })
  }
  return out
}

// ── compiling ──────────────────────────────────────────────────────────────

/**
 * The properties that COUNT as "a colour was emitted".
 *
 * The `border` branch allows hyphens inside the middle segment on purpose.
 * `border-s-*`/`border-e-*` compile to the LOGICAL properties
 * `border-inline-start-color` / `border-inline-end-color`, and an inner `[a-z]+`
 * cannot consume `-inline-start-` — so a live, correctly-compiling
 * `border-s-brand/20` was reported as dead.
 *
 * Worth naming the direction, because it is the opposite of the defect this
 * file exists for and reads as harmless by comparison: everything else here
 * fails to fire on broken code, whereas this fired on CORRECT code. That is not
 * the safer failure. It would have forced a working class into a `KNOWN_DEAD`
 * map whose whole value is that its entries are really dead — a false entry
 * there discredits the other thirty-one.
 */
const COLOUR_DECL =
  /^(?:background-color|color|border(?:-[a-z-]+)?-color|fill|stroke|outline-color|accent-color|caret-color|text-decoration-color|--tw-(?:ring|ring-offset|shadow|gradient-from|gradient-to|gradient-via)-color)$/

/**
 * Compile every utility in ONE Tailwind pass and return the set that emitted a
 * colour declaration.
 *
 * A dead utility emits no rule at all, so absence from the returned set IS the
 * defect — the same signal, read positively. Selectors come back escaped
 * (`.bg-\[var\(--v2-bg\)\]\/85`); dropping the backslashes recovers the class
 * name exactly, which is safe here only because variants were stripped upstream
 * and no selector carries a pseudo-class suffix.
 */
async function compileLive(utilities: string[]): Promise<Set<string>> {
  const result = await postcss([
    tailwindcss({
      content: [{ raw: utilities.join(' '), extension: 'html' }],
      corePlugins: { preflight: false },
      theme: tailwindConfig.theme,
    }),
  ]).process('@tailwind utilities;', { from: undefined })

  const live = new Set<string>()
  result.root.walkRules((rule) => {
    let hasColour = false
    rule.walkDecls((decl) => {
      if (COLOUR_DECL.test(decl.prop)) hasColour = true
    })
    if (!hasColour) return
    for (const selector of rule.selectors) {
      live.add(selector.replace(/\\/g, '').replace(/^\./, ''))
    }
  })
  return live
}

// ── guards ─────────────────────────────────────────────────────────────────

describe('every opacity-modified colour utility compiles to a colour (#1818)', () => {
  const all = uses()
  const bases = [...new Set(all.map((u) => u.base))].sort()

  it('finds the call-sites at all (guards the scanner itself)', () => {
    // Without this, a tokenizer bug that silently swallowed a region would turn
    // every assertion below into a vacuous pass over an empty array — which is
    // the same class of invisible failure the file exists to catch.
    expect(bases.length).toBeGreaterThan(50)
    expect(new Set(all.map((u) => u.file)).size).toBeGreaterThan(30)
  })

  it('does not read class names out of comments', () => {
    // Both files quote a dead class inside a comment explaining its removal.
    // If those were scanned as call-sites, the guard would fail on its own
    // documentation and the fix would be to delete the explanation.
    expect(bases).not.toContain('ring-current/30') // Toast.tsx:141
    expect(bases).not.toContain('bg-[var(--v2-brand)]/40') // ConnectStepShell.tsx:49
  })

  it('no dead class outside the triaged inventory', async () => {
    const live = await compileLive(bases)
    const dead = bases.filter((b) => !live.has(b))
    const untriaged = dead.filter((b) => !(b in KNOWN_DEAD))

    const where = (b: string) =>
      `${b} (${[...new Set(all.filter((u) => u.base === b).map((u) => u.file))].join(', ')})`

    expect(
      untriaged.map(where),
      'these compile to NO CSS at all — Tailwind dropped the opacity modifier silently. ' +
        'Use a channel-token alias (bg-bg/85, not bg-[var(--v2-bg)]/85), an on-scale ' +
        'modifier, or the arbitrary form (/[0.78]). See tailwind.config.js.',
    ).toEqual([])
  }, COMPILE_TIMEOUT)

  it('every inventory entry is still in use and still dead', async () => {
    // The anti-rubber-stamp half. An entry that has been fixed, or whose
    // call-site is gone, must LEAVE this map — otherwise the inventory outlives
    // its reason and starts licensing the next regression in the same shape.
    const live = await compileLive(Object.keys(KNOWN_DEAD))
    const revived = Object.keys(KNOWN_DEAD).filter((b) => live.has(b))
    expect(revived, 'these compile now — delete them from KNOWN_DEAD').toEqual([])

    const inUse = new Set(bases)
    const orphaned = Object.keys(KNOWN_DEAD).filter((b) => !inUse.has(b))
    expect(orphaned, 'no call-site left for these — delete them from KNOWN_DEAD').toEqual([])
  }, COMPILE_TIMEOUT)

  it('the inventory is EMPTY — a dead class has nowhere to hide (#1710)', () => {
    // This started as a shrink-only ratchet: 31 entries, "lower it as
    // #1709/#1710 land; never raise it". Both landed, so it is now zero and the
    // assertion changes character — from "do not grow" to "there is no such
    // thing as an accepted dead class".
    //
    // Kept as its own assertion rather than deleted with the map. The scan
    // above only reports classes it finds dead; if someone re-adds a key here
    // to quiet a failure, THIS is what refuses. A gate with an escape hatch
    // nobody guards is the shape epic #1685 spent three slices removing.
    expect(Object.keys(KNOWN_DEAD).length).toBe(0)
  })
})

describe('REGRESSION: the three shapes that have actually shipped (#1818)', () => {
  // Reproduced as compiled facts, so reaching for any of them again is a red
  // test rather than an invisible no-op. They are listed together because their
  // only common property is the OUTPUT — nothing at the source level unites a
  // bare var(), currentColor and an off-scale number.
  it('all three drop, and their fixed forms all compile', async () => {
    const dead = ['bg-[var(--v2-bg)]/85', 'ring-current/30', 'text-white/78']
    const fixed = ['bg-bg/85', 'ring-current', 'text-white/75', 'text-white/[0.78]', 'bg-ink/40']

    const live = await compileLive([...dead, ...fixed])

    expect(
      dead.filter((c) => live.has(c)),
      'these shapes are the defect; if one compiles now, Tailwind changed under us',
    ).toEqual([])
    expect(
      fixed.filter((c) => !live.has(c)),
      'these are the prescribed replacements and must compile',
    ).toEqual([])
  }, COMPILE_TIMEOUT)

  it('the fix TopBar actually shipped is the compiling one', async () => {
    // Sidebar's scrim is deliberately NOT here: it moved to the shared
    // `v2-modal-backdrop` class rather than to `bg-ink/40`, so it carries no
    // opacity modifier at all and this guard has nothing to say about it.
    const live = await compileLive(['bg-bg/85'])
    expect([...live]).toEqual(['bg-bg/85'])
  }, COMPILE_TIMEOUT)

  it('recognises the LOGICAL border properties as a colour', async () => {
    // `border-s-*`/`border-e-*` emit `border-inline-start-color` /
    // `border-inline-end-color`. COLOUR_DECL's border branch must allow the
    // hyphens inside that middle segment, or these correctly-compiling classes
    // are reported dead — a false entry in an inventory that claims accuracy.
    // No call-site uses them today, which is exactly why this is pinned: the
    // scan would have been wrong the first time someone reached for one.
    const live = await compileLive(['border-s-brand/20', 'border-e-brand/20'])
    expect([...live].sort()).toEqual(['border-e-brand/20', 'border-s-brand/20'])
  }, COMPILE_TIMEOUT)
})
