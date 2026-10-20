// CLI self-test for the design-system lint (#2728).
//
// This file exists because the guard had NO self-test at all, and its
// `--update` branch had no refusal at all: `if (update) { writeBaseline(...);
// return }`, byte-for-byte the hole #2728 was filed about in the copy lint.
// The issue named three sibling ratchets that refuse to raise; this fifth
// consumer of `scripts/lib/ratchet.mjs` was in neither set, and review found
// it by reading the module's importer list rather than the issue text.
//
// It matters here as much as anywhere: design lint is a BLOCKING CI job, and
// its own failure message sends you to the command that was laundering the
// failure.
//
// The guard is driven as a PROCESS through the shared harness. `runGuard`
// needs no change for a script outside `scripts/`: the path is resolved
// against `scripts/`, so `../packages/frontend/scripts/design-lint.mjs` lands
// at `<root>/packages/frontend/scripts/`, from which the guard's own
// `../../../scripts/lib/ratchet.mjs` resolves to the copy `also:` puts at
// `<root>/scripts/lib/`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runGuard } from '../../../scripts/test-support/guard-cli.mjs'

const SCRIPT = '../packages/frontend/scripts/design-lint.mjs'
const ALSO = ['lib/ratchet.mjs', 'lib/lint-escapes.mjs']
const BASE = 'packages/frontend/design-lint-baseline.json'
const COMP = 'packages/frontend/src/components/Probe.tsx'

// Both SCAN_DIRS have to exist, so `src/app` gets a clean file.
const clean = 'export default function P() {\n  return <p>ok</p>\n}\n'
const withDrift = 'export default function P() {\n  return <p className="text-amber-500">x</p>\n}\n'
const tree = (extra) => ({
  'packages/frontend/src/app/page.tsx': clean,
  [COMP]: clean,
  ...extra,
})

test('CLI: new design drift fails the plain run and names the file', () => {
  const { status, out } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [COMP]: withDrift, [BASE]: '{}' }),
  })
  assert.equal(status, 1)
  assert.match(out, /NEW design-system drift detected/)
  assert.match(out, /Probe\.tsx/)
  assert.match(out, /raw-palette/)
})

test('CLI: a clean tree exits 0', () => {
  // The control. Without it the case above also passes against a lint that
  // fails everything.
  const { status, out } = runGuard(SCRIPT, { also: ALSO, files: tree({ [BASE]: '{}' }) })
  assert.equal(status, 0)
  assert.match(out, /design-lint: OK/)
})

test('CLI: `--update` REFUSES to raise the baseline, and writes nothing', () => {
  // The #2728 hole, on this guard. Before the fix this exited 0 and wrote the
  // drift in -- measured on the real script, not reasoned about.
  const before = JSON.stringify({ [COMP]: { 'raw-palette': 0 } })
  const shared = { also: ALSO, files: tree({ [COMP]: withDrift, [BASE]: before }) }

  // The plain run refuses it, so the growth is real and not a fixture artifact.
  assert.equal(runGuard(SCRIPT, shared).status, 1)

  const { status, out, wrote } = runGuard(SCRIPT, {
    ...shared,
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.match(out, /Probe\.tsx \[raw-palette\]: 0 → 1/)
  // "writes nothing" checked, not claimed.
  assert.equal(wrote[BASE], before)
})

test('CLI: an existing but EMPTY baseline REFUSES growth -- it is not a first run', () => {
  // This guard's baseline IS `{}` on `dev`, so the empty-object state is not a
  // theoretical one here -- it is the state the gate ships in. Keying the
  // allowance on emptiness would leave this guard permanently open.
  const { status, out, wrote } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [COMP]: withDrift, [BASE]: '{}' }),
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.equal(wrote[BASE], '{}')
})

test('CLI: a MISSING baseline refuses debt unless --accept-new is explicit', () => {
  const shared = { also: ALSO, files: tree({ [COMP]: withDrift }), readBack: [BASE] }
  const refused = runGuard(SCRIPT, { ...shared, args: ['--update'] })
  assert.equal(refused.status, 1)
  assert.match(refused.out, /--update --accept-new/)
  assert.equal(refused.wrote[BASE], null)

  const accepted = runGuard(SCRIPT, { ...shared, args: ['--update', '--accept-new'] })
  assert.equal(accepted.status, 0)
  assert.match(accepted.wrote[BASE], /"raw-palette": 1/)
})

test('CLI: a MISSING baseline still writes an empty first scan without --accept-new', () => {
  const { status, wrote } = runGuard(SCRIPT, {
    also: ALSO, files: tree({}), args: ['--update'], readBack: [BASE],
  })
  assert.equal(status, 0)
  assert.deepEqual(JSON.parse(wrote[BASE]), {})
})

test('CLI: `--update` DOES write when the drift is gone', () => {
  // The accept half: a refusal that refuses everything breaks the ratchet in
  // the other direction, so debt could never be tightened after a cleanup.
  const { status, out, wrote } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [BASE]: JSON.stringify({ [COMP]: { 'raw-palette': 4 } }) }),
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 0)
  assert.match(out, /baseline written/)
  assert.equal(JSON.parse(wrote[BASE])[COMP], undefined)
})

test('CLI: a malformed baseline prints one line — and this gate has a SYNC main', () => {
  // #2761. The other eight gates have an async `main`; this one is synchronous,
  // which is why `runGate` uses `Promise.resolve().then(() => main())` rather than
  // `main().catch(...)` — the latter lets a sync throw escape before any
  // handler exists. So this gate is not a fifth copy of the same case: it is
  // the one that would still print a node:internal banner under the obvious
  // implementation.
  const { status, out } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({ [BASE]: JSON.stringify({ [COMP]: { 'raw-palette': 'x' } }) }),
  })
  assert.equal(status, 1)
  assert.match(out, /✗ design-lint: /)
  assert.match(out, /\[raw-palette\] is "x", not a number/)
  assert.doesNotMatch(out, /node:internal/)
  assert.doesNotMatch(out, /triggerUncaughtException/)
})

// ── The list-control rule (#4129) ───────────────────────────────────────────
// Signal proofs run through the pure scanner (per file, per fixture); the
// ratchet proofs run the CLI. The fixtures are the MEASURED shapes from the
// hand-built copies (dev @ 3bb177a12 and the current tree) and the four
// unrelated menus, not invented ones — a rule whose fixtures are guesses
// proves a rule that fires on guesses.
import { scanSource } from './design-lint.mjs'

const RULE = 'hand-built-list-control'
const ruleHits = (relFile, source) => scanSource(relFile, source).filter((h) => h.rule === RULE)

// FilterBar (src/components/transactions/FilterBar.tsx) — the ONE hand-built
// copy still on dev (Agents' toolbar deleted, Marketplace and Contacts
// migrated). Its search input, verbatim lines 291–297. The committed baseline
// carries exactly this file; the guard must fire on it.
const filterBarCopy = `export default function F() {
  return (
    <Input
      type="search"
      value={searchDraft}
      onChange={(event) => handleSearchInput(event.target.value)}
      placeholder="Search transactions"
      aria-label="Search transactions"
      leftIcon={<Icon icon={Search} className="h-4 w-4" />}
    />
  )
}
`
// The committed baseline, byte-for-byte (files keyed relative to
// packages/frontend, the scan's ROOT).
const LIST_BASELINE = JSON.stringify({
  'src/components/transactions/FilterBar.tsx': { 'hand-built-list-control': 2 },
})

test('list-control: fires on FilterBar, the copy the baseline carries', () => {
  // Two lines trip: the `type="search"` attribute and the "Search …"
  // placeholder — one search field, counted per matching line like every
  // line-scanned rule.
  assert.deepEqual(ruleHits('src/components/transactions/FilterBar.tsx', filterBarCopy).map((h) => h.line), [4, 7])
})

test('list-control: fires on each hand-built shape measured on dev @ 3bb177a12', () => {
  // AgentListToolbar (deleted by #4157): its search field.
  assert.ok(
    ruleHits(
      'src/components/agent-panel/AgentListToolbar.tsx',
      '<input placeholder="Search agents" aria-label="Search agents" />',
    ).length >= 1,
  )
  // MerchantGrid (migrated by #4114): the bare FilterPill row.
  assert.ok(
    ruleHits(
      'src/components/marketplace/MerchantGrid.tsx',
      '<FilterPill active={activeCategory === null} onClick={() => setCategory(null)}>All</FilterPill>',
    ).length >= 1,
  )
  // Contacts (migrated by #4159): its list search — a placeholder WITHOUT
  // type="search", which is why the placeholder half of the signal exists.
  assert.ok(
    ruleHits(
      'src/app/(authenticated)/contacts/page.tsx',
      '<Input placeholder="Search by name or address" aria-label="Search contacts" />',
    ).length >= 1,
  )
  // The hand-rolled Filters trigger tell: the SlidersHorizontal glyph outside
  // the family.
  assert.ok(
    ruleHits('src/components/x/Toolbar.tsx', '<Button icon={SlidersHorizontal}>Filters</Button>').length >= 1,
  )
  // A dynamic placeholder (`placeholder={`Search ${noun}`}`) trips too — the
  // pre-#4110 copies were string literals, but a new copy need not be.
  assert.ok(
    ruleHits('src/components/x/Toolbar.tsx', '<input placeholder={`Search ${noun}`} />').length >= 1,
  )
})

test('list-control: fires on a newly added copy', () => {
  const src = `export default function P() {
  return <input type="search" placeholder="Search widgets" />
}
`
  assert.ok(ruleHits('src/components/widgets/WidgetListToolbar.tsx', src).length >= 1)
})

test('list-control: stays silent inside the ListToolbar family — the allowlisted home', () => {
  // The same search field, family home: exempt BY PATH, not by signal.
  assert.equal(ruleHits('src/components/ui/ListToolbar.tsx', filterBarCopy).length, 0)
  // FacetMenu renders the pills; PeriodPicker owns a trigger glyph.
  assert.equal(
    ruleHits('src/components/ui/FacetMenu.tsx', '<FilterPill active onClick={() => {}}>All</FilterPill>').length,
    0,
  )
  assert.equal(
    ruleHits('src/components/ui/PeriodPicker.tsx', '<Button icon={SlidersHorizontal}>Period</Button>').length,
    0,
  )
})

test('list-control: stays silent on the four unrelated menus — by SIGNAL, not exemption', () => {
  // aria-haspopup and aria-expanded are the generic menu signals those four
  // share (#4129 measured them). None of them carries a search field, the
  // sliders glyph or a bare FilterPill — DropdownMenu.tsx is deliberately NOT
  // in the exempt list, so a zero here is the signal holding, not a path
  // carve-out.
  const sidebar = '<button type="button" aria-haspopup="menu" aria-expanded={menuOpen} aria-label="User menu" />'
  assert.equal(ruleHits('src/components/sidebar/Sidebar.tsx', sidebar).length, 0)
  const wallet = '<button type="button" aria-haspopup="dialog" aria-expanded={popoverOpen} aria-label="Passkey" />'
  assert.equal(ruleHits('src/components/WalletButton.tsx', wallet).length, 0)
  const menu =
    '<button type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} />'
  assert.equal(ruleHits('src/components/ui/DropdownMenu.tsx', menu).length, 0)
  const row = "<button {...({ 'aria-haspopup': 'dialog' } as const)} onClick={openRow} />"
  assert.equal(ruleHits('src/components/haven/TransactionActivityRow.tsx', row).length, 0)
})

test('list-control: silent in packages/ops/src, packages/ui/src, and on the FilterPill shim', () => {
  // ops is exempt by owner decision (2026-10-20); ui/src holds FilterPill's
  // definition; the shim re-exports it.
  assert.equal(ruleHits('../ops/src/anything.tsx', '<input type="search" placeholder="Search ops" />').length, 0)
  assert.equal(ruleHits('../ui/src/FilterPill.tsx', 'export const X = () => <FilterPill />').length, 0)
  assert.equal(
    ruleHits('src/components/ui/FilterPill.tsx', "export const X = () => <FilterPill />").length,
    0,
  )
})

test('list-control: silent on the /design-system demos', () => {
  assert.equal(
    ruleHits(
      'src/app/(authenticated)/design-system/page.tsx',
      '<FilterPill active={dsFilterPillActive === null} onClick={() => setDsFilterPillActive(null)}>All</FilterPill>',
    ).length,
    0,
  )
})

test('list-control: design-lint-disable-line does NOT silence it — the baseline is the only carry', () => {
  const escaped = `export default function P() {
  // design-lint-disable-line
  return <input type="search" placeholder="Search widgets" />
}
`
  assert.ok(ruleHits('src/components/widgets/WidgetListToolbar.tsx', escaped).length >= 1)
  // Control: the same marker DOES silence the token rules it exists for, so
  // the non-silence above is the rule's opt-out, not a broken marker path.
  const paletteEscaped = `export default function P() {
  // design-lint-disable-line
  return <p className="text-amber-500">x</p>
}
`
  assert.equal(
    scanSource('src/components/widgets/WidgetListToolbar.tsx', paletteEscaped).filter((h) => h.rule === 'raw-palette')
      .length,
    0,
  )
})

test('CLI: the committed baseline carries the remaining copy — plain run exits 0', () => {
  const { status, out } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({
      [BASE]: LIST_BASELINE,
      'packages/frontend/src/components/transactions/FilterBar.tsx': filterBarCopy,
    }),
  })
  assert.equal(status, 0)
  assert.match(out, /2 baselined violations remain/)
})

test('CLI: a newly added hand-built copy fails the plain run and names the rule', () => {
  const { status, out } = runGuard(SCRIPT, {
    also: ALSO,
    files: tree({
      [BASE]: LIST_BASELINE,
      'packages/frontend/src/components/transactions/FilterBar.tsx': filterBarCopy,
      [COMP]: filterBarCopy, // a second copy: the baseline is per-FILE
    }),
  })
  assert.equal(status, 1)
  assert.match(out, /NEW design-system drift detected/)
  assert.match(out, /Probe\.tsx/)
  assert.match(out, /hand-built-list-control/)
})

test('CLI: the list-control baseline can only shrink — --update refuses to raise it', () => {
  // The baseline says the probe copy has 1 tripping line; the file has 2.
  // Growth is refused even though the file is already baselined — the ratchet
  // is per-file, per-rule, shrink-only.
  const before = JSON.stringify({ 'src/components/Probe.tsx': { 'hand-built-list-control': 1 } })
  const shared = {
    also: ALSO,
    files: tree({ [COMP]: filterBarCopy, [BASE]: before }),
  }
  assert.equal(runGuard(SCRIPT, shared).status, 1)

  const { status, out, wrote } = runGuard(SCRIPT, {
    ...shared,
    args: ['--update'],
    readBack: [BASE],
  })
  assert.equal(status, 1)
  assert.match(out, /--update refuses to RAISE the baseline/)
  assert.match(out, /Probe\.tsx \[hand-built-list-control\]: 1 → 2/)
  assert.equal(wrote[BASE], before)
})
