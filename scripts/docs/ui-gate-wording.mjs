#!/usr/bin/env node
// Retired UI merge-gate wording guard (#2657, guarding the rules #2636 retired).
//
// ## The defect this exists for
//
// #2636 retired two rules and had to correct them in TEN live documentation
// sites. Those ten were found across FIVE review rounds, each round finding
// sites the previous ones had missed — and the site that survived longest was
// `.agents/skills/ship-next/SKILL.md` § *Merge Gate*, the canonical definition
// every other doc links to as the source of truth.
//
// The root cause was mechanical, not attentional. Every failed sweep was
// **line-bound** (`grep`), and this repo's Markdown is **hard-wrapped**, so the
// sentence splits across lines:
//
//     - **Frontend UI:** a UX, copy, or design-system finding from either
//       review pass pauses auto-merge.
//
// No `grep 'finding.*pauses'` matches that. Round 5 found it only by reading
// whole files and running a regex over the raw text.
//
// So this check is **sentence-scoped over file contents, never line-bound**:
// it segments each file's body into sentences that may span any number of
// newlines, flattens each sentence's whitespace, and only then matches. A guard
// that could only see the single-line form would ship green while missing
// exactly the case it was built for — which is why `ui-gate-wording.test.mjs`
// asserts the hard-wrapped case explicitly.
//
// ## The two retired rules
//
//  1. `blanket-merge-pause` — "a finding from either pass pauses auto-merge",
//     with no severity qualifier. The rule since #2636 is that `blocking` and
//     `should-fix` pause and `nit` does not, so a sentence that names either
//     severity is the CORRECTED form and is excluded.
//  2. `retired-rendered-evidence-trigger` — "any diff touching a rendered route
//     or a shared primitive". Rendered evidence now keys on three named
//     triggers (new route, changed shared primitive, a diff that changes what a
//     screen shows).
//
// ## What it deliberately does not read
//
// **Front-matter.** A `last-verified` chain records what a past PR changed, so
// it quotes the retired wording by design and forever — `frontend.md`'s chain
// alone carries several such quotes. The chain is stripped before scanning
// (newline-for-newline, so reported line numbers still point at the real line),
// which is strictly more reliable than the substring filter the issue's
// prototype sweep used: that filter is sentence-scoped too, so it misses a
// chain entry whose own sentence happens not to contain the words
// `last-verified` or `Prior:` — the residue that prototype printed.
// In-body quotations of a chain are still filtered by substring.
//
// ## Residue
//
// Ratcheting, shrink-only baseline in the house style of
// `copy-lint-baseline.json` / `design-lint-baseline.json`: file → rule id →
// count. Counts may fall, never rise. `--update` rewrites it, and is for a
// reviewed, intentional change only.
//
// Usage:
//   node scripts/docs/ui-gate-wording.mjs            # check (runs in docs:check)
//   node scripts/docs/ui-gate-wording.mjs --update   # rewrite the baseline
//
// See docs/contributing/docs-quality-system.md.
import { readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'docs', 'ui-gate-wording-baseline.json')

/**
 * The retired rules, as term sets rather than one long regex.
 *
 * `requires` are ALL matched against the sentence with its whitespace
 * flattened, so word order does not matter and a hard wrap between any two
 * words of a phrase is invisible to the match. `excludes` are the forms that
 * are legitimate: the corrected `blocking`/`should-fix` wording, and text that
 * is quoting a `last-verified` chain inside a doc body.
 */
export const RULES = [
  {
    id: 'blanket-merge-pause',
    what: 'the blanket merge pause #2636 retired ("a finding from either pass pauses auto-merge")',
    fix: 'name the severities: a `blocking` or `should-fix` finding pauses auto-merge; a `nit` does not (#2636).',
    requires: [/\bfinding\b/i, /\bpauses\b/i],
    excludes: [/\bblocking\b/i, /\bshould-fix\b/i],
  },
  {
    id: 'retired-rendered-evidence-trigger',
    what: 'the rendered-evidence trigger #2636 retired ("any diff touching a rendered route or a shared primitive")',
    fix: 'name the three triggers: a new route, a changed shared primitive, or a diff that changes what a screen shows (#2636).',
    requires: [/\brendered route\b/i, /\bprimitive\b/i],
    excludes: [],
  },
]

/**
 * Sentences that are quoting the `last-verified` chain from inside a doc BODY.
 * Front-matter is stripped before this ever applies; this is for prose that
 * pastes a chain entry as an example.
 */
const CHAIN_QUOTE = [/last-verified/i, /\bPrior:/]

/** Markdown files under the doc surface, excluding archived docs. */
export function listMarkdownFiles(root = REPO_ROOT) {
  const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', '*.md'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return out.split('\0').filter(Boolean)
}

/**
 * Blank out the leading front-matter block, preserving byte offsets so that
 * line numbers computed on the result still address the real file. Every
 * non-newline character becomes a space; newlines are kept.
 */
export function blankFrontMatter(raw) {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/)
  if (!m) return raw
  const blanked = m[0].replace(/[^\n]/g, ' ')
  return blanked + raw.slice(m[0].length)
}

/**
 * Segment text into sentences: a maximal run of non-period characters followed
 * by a period, plus any trailing remainder. `[^.]` matches newlines, so a
 * sentence spans however many lines it is wrapped over — this is the whole
 * point of the check and is why nothing here works line by line.
 *
 * Returns `{ text, index }` so a match can be located in the original file.
 */
export function sentences(text) {
  const out = []
  const re = /[^.]*\.|[^.]+$/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    if (m[0].trim().length > 0) out.push({ text: m[0], index: m.index })
  }
  return out
}

/** Collapse every whitespace run — including hard wraps — to one space. */
export function flatten(s) {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * `flatten`, plus the index map back into the source string.
 *
 * The map is what lets the report name a real LINE. Matching happens on the
 * flattened sentence — that is the whole point, since a hard wrap may fall
 * between any two words of a phrase — but a reader needs the file position of
 * the phrase, not of the sentence, which in a hard-wrapped doc can start
 * several lines earlier (and, once front-matter is blanked, at the top of the
 * file). `map[i]` is the source index of `flat[i]`.
 */
export function flattenWithMap(s) {
  let flat = ''
  const map = []
  let i = 0
  while (i < s.length && /\s/.test(s[i])) i++
  for (; i < s.length; i++) {
    if (/\s/.test(s[i])) {
      if (flat.length > 0 && !flat.endsWith(' ')) {
        flat += ' '
        map.push(i)
      }
      continue
    }
    flat += s[i]
    map.push(i)
  }
  while (flat.endsWith(' ')) {
    flat = flat.slice(0, -1)
    map.pop()
  }
  return { flat, map }
}

/** 1-based line number of `index` within `text`. */
export function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/**
 * Scan one file's raw contents. Pure — takes the text, returns violations.
 * `{ file, rule, line, sentence }[]`
 */
export function scanText(file, raw) {
  const body = blankFrontMatter(raw)
  const hits = []
  for (const s of sentences(body)) {
    const { flat, map } = flattenWithMap(s.text)
    if (flat.length === 0) continue
    if (CHAIN_QUOTE.some((re) => re.test(flat))) continue
    for (const rule of RULES) {
      const at = rule.requires.map((re) => flat.search(re))
      if (at.some((i) => i < 0)) continue
      if (rule.excludes.some((re) => re.test(flat))) continue
      // Report the FIRST required term, not the sentence start: the sentence
      // may open several hard-wrapped lines above the phrase.
      const offset = map[Math.min(...at)] ?? 0
      hits.push({
        file,
        rule: rule.id,
        line: lineOf(body, s.index + offset),
        sentence: flat.length > 220 ? `${flat.slice(0, 220)}…` : flat,
      })
    }
  }
  return hits
}

/** `{ file: { ruleId: count } }` from a flat violation list. */
export function countByFile(hits) {
  const counts = {}
  for (const h of hits) {
    counts[h.file] ??= {}
    counts[h.file][h.rule] = (counts[h.file][h.rule] ?? 0) + 1
  }
  return counts
}

/** Occurrences beyond what the baseline allows. */
export function newViolations(counts, baseline) {
  const failures = []
  for (const [file, rules] of Object.entries(counts)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = baseline?.[file]?.[rule] ?? 0
      if (count > allowed) failures.push({ file, rule, count, allowed })
    }
  }
  return failures.sort((a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule))
}

/** True when any baselined count has fallen — the ratchet can be tightened. */
export function hasShrunk(counts, baseline) {
  for (const [file, rules] of Object.entries(baseline ?? {})) {
    for (const [rule, allowed] of Object.entries(rules)) {
      if ((counts?.[file]?.[rule] ?? 0) < allowed) return true
    }
  }
  return false
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(BASELINE_PATH, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}

async function main() {
  const update = process.argv.includes('--update')
  const files = listMarkdownFiles()
  const hits = []
  for (const file of files) {
    hits.push(...scanText(file, await readFile(join(REPO_ROOT, file), 'utf8')))
  }
  const counts = countByFile(hits)

  if (update) {
    const sorted = Object.fromEntries(
      Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([f, r]) => [f, Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)))]),
    )
    await writeFile(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`)
    console.log(`ui-gate-wording: baseline written (${hits.length} existing occurrence(s) ratcheted).`)
    return
  }

  const baseline = await readBaseline()
  const failures = newViolations(counts, baseline)

  if (failures.length > 0) {
    console.error('✗ Retired UI merge-gate wording found in live documentation:\n')
    for (const f of failures) {
      const rule = RULES.find((r) => r.id === f.rule)
      console.error(`  ${f.file} — ${f.rule}: ${f.count} found, baseline allows ${f.allowed}`)
      console.error(`    states ${rule.what}`)
      for (const h of hits.filter((h) => h.file === f.file && h.rule === f.rule)) {
        console.error(`    ${f.file}:${h.line}: ${h.sentence}`)
      }
      console.error(`    → ${rule.fix}\n`)
    }
    console.error(
      'These two rules were retired by #2636 and corrected in ten places across five ' +
        'review rounds, because every sweep before this check was line-bound and the docs ' +
        'are hard-wrapped (#2657). Correct the sentence rather than baselining it; ' +
        '`node scripts/docs/ui-gate-wording.mjs --update` is for a reviewed, intentional ' +
        'change only, and a `last-verified` chain entry never needs one — front-matter is ' +
        'not scanned.\n',
    )
    process.exit(1)
  }

  console.log(
    `✓ No retired UI merge-gate wording in ${files.length} Markdown file(s) ` +
      `(${hits.length} baselined occurrence(s) remain).` +
      (hasShrunk(counts, baseline)
        ? ' Residue shrank — run `node scripts/docs/ui-gate-wording.mjs --update` to tighten the ratchet.'
        : ''),
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    // Fail closed: a broken gate that passes is the defect one layer up.
    console.error('ui-gate-wording error:', err)
    process.exit(1)
  })
}
