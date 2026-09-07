#!/usr/bin/env node
/**
 * Design-system drift gate (#855, epic #859).
 *
 * Fails CI when a PR introduces NEW violations in src/{app,components}.
 *
 * Token rules — a value bypassed the design tokens:
 *   1. raw-palette   — Tailwind palette colour classes (text-amber-500, …)
 *                      instead of var(--v2-…) tokens
 *   2. hex-color     — hardcoded hex colours
 *   3. micro-font    — new text-[10px] / text-[11px]
 *
 * Structural rules (#899) — a COMPONENT was re-hand-rolled instead of using the
 * shared primitive (the exact debt epic #859 cleaned; token rules can't see it):
 *   4. header-band       — a grey header band (border-b + --v2-surface fill)
 *                          hand-rolled instead of Card.Header
 *   5. raw-table         — a raw <table> instead of the Table primitive
 *   6. raw-svg           — an inline <svg> instead of Icon + a lucide glyph
 *   7. address-truncation — a hand-rolled `${a.slice(0,6)}…${a.slice(-4)}`
 *                          instead of <Address> (or lib/format truncate)
 * Each structural rule exempts its own primitive's home file (Table.tsx,
 * Card.tsx, Address.tsx) so the canonical implementation is never self-flagged.
 *
 * Marketing/landing surfaces are exempt from ALL rules (#874, owner decision
 * 2026-07-12): they are intentionally bespoke and do not count against the
 * baseline. Product-app surfaces and /design-system stay fully gated.
 *
 * A committed baseline (design-lint-baseline.json) ratchets: existing debt
 * passes, counts may only shrink. Growing a count, or violations in a file
 * not in the baseline, fails with file:line output and a pointer to
 * /design-system.
 *
 *   node scripts/design-lint.mjs            # check against the baseline
 *   node scripts/design-lint.mjs --update   # rewrite the baseline (shrink or
 *                                           # intentional, reviewed growth)
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { newViolations, hasShrunk, writeBaseline, readBaseline } from '../../../scripts/lib/ratchet.mjs'
import { isEscaped } from '../../../scripts/lib/lint-escapes.mjs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = path.join(ROOT, 'design-lint-baseline.json')
const SCAN_DIRS = ['src/app', 'src/components']
const DOC_POINTER = 'See /design-system (Colour tokens · How to use this page).'

// Tailwind palette families — white/black/transparent stay legal.
const PALETTE =
  'gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'
const UTILITIES =
  'text|bg|border|ring|divide|from|to|via|fill|stroke|outline|decoration|shadow|accent|caret|placeholder'

// Marketing/landing surfaces — intentionally bespoke, exempt from every rule
// (#874). Everything else in src/{app,components} stays gated.
const MARKETING_SURFACES = [
  'components/brand/',
  'components/marketing/',
  'src/app/page.tsx',
  'src/app/protocols/',
  'src/app/how-it-works/',
]
export function isMarketingSurface(file) {
  return MARKETING_SURFACES.some((m) =>
    m.endsWith('.tsx') ? file.endsWith(m) : file.includes(m),
  )
}

export const RULES = [
  {
    id: 'raw-palette',
    describe: 'raw Tailwind palette class — use a var(--v2-…) token',
    regex: new RegExp(`\\b(?:${UTILITIES})-(?:${PALETTE})-\\d{2,3}\\b`, 'g'),
    exempt: isMarketingSurface,
  },
  {
    id: 'hex-color',
    describe: 'hardcoded hex colour — use a var(--v2-…) token',
    // 3/4-char forms must contain a letter: all-digit short matches are far
    // more often issue references (#857) than colours, and any real colour
    // also exists in its 6-digit form. Line comments are skipped in scanSource.
    regex:
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|(?=[0-9a-fA-F]{0,3}[a-fA-F])[0-9a-fA-F]{4}|(?=[0-9a-fA-F]{0,2}[a-fA-F])[0-9a-fA-F]{3})\b/g,
    exempt: isMarketingSurface,
  },
  {
    id: 'micro-font',
    describe: 'micro font size — use the typography ramp (v2-text-*)',
    regex: /text-\[1[01]px\]/g,
    exempt: isMarketingSurface,
  },
  // ── Structural rules (#899): catch COMPONENT bypass — re-hand-rolling the
  // exact debt epic #859 cleaned. The token rules above can't see these.
  {
    id: 'header-band',
    describe: 'hand-rolled grey header band — use the Card.Header primitive',
    // A border-b co-occurring with the surface fill inside one className.
    // `border-b` is boundary-guarded: it must not match inside `border-black`
    // (a letter follows) but must still match `border-b` and `border-b-2`.
    regex:
      /(border-b(?![a-zA-Z])[^"'`]*bg-\[var\(--v2-surface\)\]|bg-\[var\(--v2-surface\)\][^"'`]*border-b(?![a-zA-Z]))/g,
    exempt: (file) => isMarketingSurface(file) || file.includes('components/ui/Card.tsx'),
  },
  {
    id: 'raw-table',
    describe: 'raw <table> — use the Table primitive (components/ui/Table)',
    regex: /<table[\s>]/g,
    exempt: (file) => isMarketingSurface(file) || file.includes('components/ui/Table.tsx'),
  },
  {
    id: 'raw-svg',
    describe: 'inline <svg> — use Icon + a lucide glyph',
    regex: /<svg[\s>]/g,
    // brand/marketing already exempt via isMarketingSurface; nothing else.
    exempt: isMarketingSurface,
  },
  {
    id: 'address-truncation',
    describe: 'hand-rolled address slice — use <Address> (or lib/format truncate)',
    // The PAIRED idiom only: `…slice(0, 6)…slice(-4)…` on one line. A lone
    // slice(0, 6) is usually an array preview (agents.slice(0, 6)) and a lone
    // slice(-4) a generic suffix — neither is address truncation, and matching
    // them separately also double-counted every real occurrence.
    regex: /\.slice\(\s*0,\s*6\s*\)[^\n]*\.slice\(\s*-4\s*\)/g,
    exempt: (file) => isMarketingSurface(file) || file.includes('components/haven/Address.tsx'),
  },
  // ── Element rule (#1858) — the one § 5 invariant that had no gate ────────
  // `Icon.tsx` enforces its other two conventions by construction:
  // `strokeWidth` defaults to 1.5 and `aria-hidden` is derived from `label`.
  // Size had neither a default nor a check, which is why it — and only it —
  // drifted: 34 of 120 sized call sites were off the documented scale,
  // including eight arbitrary pixel values.
  //
  // Scanned per ELEMENT, not per line, and that is load-bearing rather than
  // fastidious: a `<Icon>`'s `className` routinely sits two lines below its
  // tag, and the same shortcut is what made an earlier line-based census
  // report 110/30 against the true 120/34. See `scanElements`.
  {
    id: 'icon-size',
    describe: 'off-scale <Icon> size — use the 12/14/16/20/24/28 scale (see /design-system → Icons)',
    element: true,
    exempt: isMarketingSurface,
  },
]

/**
 * The icon size scale (#1858), as the exact Tailwind class pairs that express
 * it. Six values, all first-class Tailwind steps — no arbitrary value is ever
 * needed to land on the scale, which is what makes "no arbitrary values"
 * a rule rather than an inconvenience.
 */
export const ICON_SCALE_PX = [12, 14, 16, 20, 24, 28]
const LEGAL_HW = new Map([
  ['3', 12],
  ['3.5', 14],
  ['4', 16],
  ['5', 20],
  ['6', 24],
  ['7', 28],
])
const LEGAL_SIZE_PROP = new Set(ICON_SCALE_PX)

/**
 * Mark every offset sitting inside a COMMENT. Strings are handled elsewhere —
 * see `isQuotedSample` for why they cannot be masked the same way.
 *
 * `Icon.tsx`'s own JSDoc documents this rule and therefore contains the
 * literal `<Icon>` three times. Those counted as call sites and landed in the
 * census's `UNCLASSIFIED` bucket — the one figure whose job is to certify that
 * nothing was silently dropped. Found by re-running the published command from
 * a clean shell against the final tree, not by the gate going red.
 *
 * The `//` rule refuses to fire after `:`, `"` or `'`, so neither `https://`
 * nor a protocol-relative `href="//example.com"` is read as a comment opener
 * that blanks the rest of a live line — a false NEGATIVE, the quiet kind.
 */
function maskNonCode(src) {
  const mask = new Uint8Array(src.length)
  const n = src.length
  for (let i = 0; i < n; ) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      const stop = e < 0 ? n : e + 2
      mask.fill(1, i, stop)
      i = stop
    } else if (c === '/' && d === '/' && !(i > 0 && ':"\''.includes(src[i - 1]))) {
      // Not a comment when it is the `//` of `https://` or of a
      // protocol-relative `href="//example.com"` — treating either as one
      // blanks the rest of a live line and hides real violations.
      let e = src.indexOf('\n', i)
      if (e < 0) e = n
      mask.fill(1, i, e)
      i = e
    } else i++
  }
  return mask
}

/**
 * Is this `<Icon` occurrence the inside of a quoted code SAMPLE?
 *
 * Deliberately a one-character adjacency test rather than a string-state
 * scanner. A full scanner is what you reach for first and it is wrong here:
 * JSX body text is full of bare apostrophes (`its own primitive's home file`,
 * `design-system/page.tsx:183`), each of which opens a string that never
 * closes, masking every real element after it. That version silently dropped
 * two live call sites at `page.tsx:247` and `:364` — a FALSE NEGATIVE, which
 * is the failure that looks like a clean run.
 *
 * Adjacency cannot make that mistake. Real JSX never puts a quote immediately
 * before an element — the preceding character is `>`, `{`, `(`, `?`, `:`, `,`
 * or whitespace. So this rejects the demonstrated case
 * (`{'<Icon icon={Check} … />'}`) and, by construction, nothing that renders.
 *
 * The narrowness is the trade, and it is the right way round: a sample written
 * with padding inside the quotes (`{'  <Icon … '}`) is still counted. That is
 * a false POSITIVE — loud, on the line, and fixable with the escape marker —
 * rather than a silent hole in the census.
 */
function isQuotedSample(src, at) {
  const prev = at > 0 ? src[at - 1] : undefined
  // `at > 0` guard, not `?? ''`: `''` is a substring of every string, so
  // `includes(prev ?? '')` returns TRUE at offset 0 and rejects an element
  // that starts the file. Caught by the existing tests, whose fixtures all
  // begin at offset 0.
  return prev !== undefined && '"\'`'.includes(prev)
}

/**
 * Find each `<Icon …/>` element by walking brace depth to its real `>`, so a
 * multiline element is one unit. Returns [{text, line}].
 */
function iconElements(source) {
  const mask = maskNonCode(source)
  const out = []
  for (let i = 0; ; ) {
    const m = source.indexOf('<Icon', i)
    if (m < 0) break
    // Prose in a comment, or a quoted code sample — not markup.
    if (mask[m] || isQuotedSample(source, m)) {
      i = m + 5
      continue
    }
    // `<IconFoo` is a different component, not this wrapper.
    if (/[A-Za-z0-9_]/.test(source[m + 5] ?? '')) {
      i = m + 5
      continue
    }
    let depth = 0
    let end = -1
    // Quote tracking is safe HERE and only here. Inside a tag, a quote always
    // delimits an attribute value; the bare apostrophes that make whole-file
    // quote tracking unusable live in JSX BODY text, which cannot appear
    // before this element's own `>`. Without it, `title="weird { case"` holds
    // depth above zero forever, the element never terminates, and a real
    // violation on it is dropped in silence.
    let quote = null
    for (let j = m; j < source.length; j++) {
      if (mask[j]) continue
      const c = source[j]
      if (quote) {
        if (c === '\\') j++
        else if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c
        continue
      }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) {
        end = j
        break
      }
    }
    if (end < 0) {
      i = m + 5
      continue
    }
    const text = source.slice(m, end + 1)
    const line = source.slice(0, m).split('\n').length
    out.push({ text, line, endLine: line + (text.split('\n').length - 1) })
    i = end + 1
  }
  return out
}

/**
 * Element-scoped scan for `icon-size` (#1858).
 *
 * What it CAN see, and therefore what it forbids:
 *   - an `h-`/`w-` pair that is not one of the six scale classes;
 *   - a non-square pair (`h-3 w-5`) — lucide's viewBox is square, so the extra
 *     axis is dead box, never a wider glyph;
 *   - any arbitrary value (`h-[13px]`), which is the whole defect class the
 *     issue called the tell;
 *   - a single-axis size (`h-4` with no `w-`);
 *   - a literal `size={13}` off the scale.
 *
 * What it CANNOT see — stated so a clean run is not over-trusted:
 *   - `size={someVariable}` and classNames assembled entirely at runtime;
 *   - a size arriving from a `cva`/lookup table in another file;
 *   - a `className` prop threaded in by a wrapper component.
 * `h-full`/`w-full` is container sizing and is deliberately legal.
 */
export function scanElements(relFile, source) {
  const rule = RULES.find((r) => r.id === 'icon-size')
  if (rule.exempt(relFile)) return []
  const lines = source.split('\n')
  const hits = []
  for (const el of iconElements(source)) {
    // The shared escape convention is "the offending line, or the one above".
    // For a multiline element those are two DIFFERENT places — the `<Icon`
    // tag and the `className` line two below it — and an author following the
    // convention will reach for the one next to the size. Accept the marker
    // anywhere the element spans, or immediately above it, rather than
    // shipping a rule whose escape hatch silently does nothing on exactly the
    // elements the element-scan exists to reach.
    let escaped = false
    for (let ln = el.line; ln <= el.endLine && !escaped; ln++) {
      if (isEscaped(lines, ln - 1, 'design-lint-disable-line')) escaped = true
    }
    if (escaped) continue
    if (/\b[hw]-full\b/.test(el.text)) continue
    const h = el.text.match(/\bh-(\[[^\]]+\]|[\d.]+)/)
    const w = el.text.match(/\bw-(\[[^\]]+\]|[\d.]+)/)
    const sizeProp = el.text.match(/\bsize=\{(\d+)\}/)
    let bad = null
    if (h || w) {
      const hv = h?.[1]
      const wv = w?.[1]
      if (!h || !w) bad = `h-${hv ?? '?'} w-${wv ?? '?'} (one axis only)`
      else if (hv !== wv) bad = `h-${hv} w-${wv} (not square)`
      else if (!LEGAL_HW.has(hv)) bad = `h-${hv} w-${wv}`
    } else if (sizeProp && !LEGAL_SIZE_PROP.has(Number(sizeProp[1]))) {
      bad = `size={${sizeProp[1]}}`
    }
    if (bad) hits.push({ rule: 'icon-size', line: el.line, match: bad })
  }
  return hits
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      yield* walk(p)
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      yield p
    }
  }
}

/** Scan one file's source; returns [{rule, line, match}] (pure — testable). */
export function scanSource(relFile, source) {
  const hits = []
  const lines = source.split('\n')
  for (const rule of RULES) {
    // Element rules are scanned whole-element, not line-by-line (#1858).
    if (rule.element) continue
    if (rule.exempt(relFile)) continue
    lines.forEach((raw, i) => {
      // Escape on the offending line or the line above (shared semantics).
      if (isEscaped(lines, i, 'design-lint-disable-line')) return
      // Strip line-comment content — issue refs (#857) and colour names in
      // comments are prose, not styles. Block-comment bodies starting with *
      // are skipped the same way. The `//` must not be preceded by `:` —
      // otherwise the `//` inside `https://` reads as a comment opener and
      // everything after the URL goes unscanned, for every rule (#1204).
      const text = raw.replace(/(?<!:)\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      for (const m of text.matchAll(rule.regex)) {
        hits.push({ rule: rule.id, line: i + 1, match: m[0] })
      }
    })
  }
  return hits
}

function scanAll() {
  /** @type {Record<string, Record<string, number>>} file → rule → count */
  const counts = {}
  const details = []
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file)
      const src = readFileSync(file, 'utf8')
      const hits = [...scanSource(rel, src), ...scanElements(rel, src)]
      for (const h of hits) {
        counts[rel] ??= {}
        counts[rel][h.rule] = (counts[rel][h.rule] ?? 0) + 1
        details.push({ file: rel, ...h })
      }
    }
  }
  return { counts, details }
}

/**
 * `--icons`: the icon-size census (#1858), printed rather than asserted.
 *
 * The doc records a RULE, never a count, and this is why it can: the
 * distribution is re-derivable on demand instead of being copied into
 * Markdown where it goes stale. `UNCLASSIFIED` is the load-bearing line — a
 * non-zero bucket means some call site was silently dropped and the totals
 * below it are a guess, not a measurement.
 */
function iconCensus() {
  const dist = new Map()
  const off = []
  let total = 0
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file)
      // The header says "marketing exempt", so actually exempt them. Only the
      // off-scale half was filtered (via `scanElements`); the totals were not.
      // Correct today only because no marketing surface uses `<Icon>` — i.e.
      // an untested claim that would have gone quietly wrong the first time
      // one did. That is the exact failure mode this issue is about.
      if (isMarketingSurface(rel)) continue
      const src = readFileSync(file, 'utf8')
      for (const el of iconElements(src)) {
        total++
        let key
        if (/\b[hw]-full\b/.test(el.text)) key = 'container (h-full/w-full)'
        else {
          const h = el.text.match(/\bh-(\[[^\]]+\]|[\d.]+)/)
          const w = el.text.match(/\bw-(\[[^\]]+\]|[\d.]+)/)
          const sz = el.text.match(/\bsize=\{(\d+)\}/)
          if (h && w) key = `h-${h[1]} w-${w[1]}`
          else if (h || w) key = `h-${h?.[1] ?? '?'} w-${w?.[1] ?? '?'}`
          else if (sz) key = `size={${sz[1]}}`
          else if (/\b(?:size|className)=\{/.test(el.text)) key = 'runtime-computed'
          else key = 'UNCLASSIFIED'
        }
        dist.set(key, (dist.get(key) ?? 0) + 1)
        if (key === 'UNCLASSIFIED') off.push(`${rel}:${el.line}`)
      }
      for (const h of scanElements(rel, src)) off.push(`${rel}:${h.line}  ${h.match}`)
    }
  }
  console.log(`TOTAL <Icon> call sites (src/{app,components}, marketing exempt): ${total}\n`)
  for (const [k, v] of [...dist].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(v).padStart(4)}  ${k}`)
  }
  console.log(`\nUNCLASSIFIED: ${dist.get('UNCLASSIFIED') ?? 0}`)
  console.log(`OFF-SCALE (what the icon-size gate would fail on): ${off.length}`)
  if (off.length) console.log(off.map((o) => `  ${o}`).join('\n'))
}

function main() {
  if (process.argv.includes('--icons')) return iconCensus()
  const update = process.argv.includes('--update')
  const { counts, details } = scanAll()

  if (update) {
    writeBaseline(BASELINE_PATH, counts)
    console.log(`design-lint: baseline written (${details.length} existing violations ratcheted).`)
    return
  }

  const baseline = readBaseline(BASELINE_PATH)
  const failures = newViolations(counts, baseline)

  if (failures.length === 0) {
    console.log(
      `design-lint: OK (${details.length} baselined violations remain).` +
        (hasShrunk(counts, baseline)
          ? ' Debt shrank — run `npm run design:lint:update -w packages/frontend` to tighten the ratchet.'
          : ''),
    )
    return
  }

  console.error('design-lint: NEW design-system drift detected.\n')
  for (const f of failures) {
    const rule = RULES.find((r) => r.id === f.key)
    console.error(
      `  ${f.file} — ${f.key}: ${f.count} found, baseline allows ${f.allowed} (${rule.describe})`,
    )
    for (const d of details.filter((d) => d.file === f.file && d.rule === f.key)) {
      console.error(`    ${f.file}:${d.line}  ${d.match}`)
    }
  }
  console.error(`\n${DOC_POINTER}`)
  console.error(
    'Fix the new violations (route colours through var(--v2-…) tokens, use the type ramp), ' +
      'or — only for a reviewed, intentional exception — run `npm run design:lint:update -w packages/frontend`.',
  )
  process.exit(1)
}

// Run only as a CLI (the pure scanner is imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
