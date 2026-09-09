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
// **Front-matter.** It is metadata, not user-facing prose. The scanner blanks
// it newline-for-newline so reported body line numbers remain accurate.
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
//   node scripts/docs/ui-gate-wording.mjs --update --accept-new
//                                                      # reviewed non-empty first write
//
// See docs/contributing/docs-quality-system.md.
import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// #2747: this gate carried PRIVATE copies of `newViolations`/`hasShrunk` while
// five sibling gates imported them from here. That is why the #2728 sweep,
// which found the missing `--update` refusal in `design-lint` by reading this
// module's importer list, could not reach this file: a gate that CLONED the
// engine is invisible to the sweep that finds gates which imported it. The
// clone was both why it drifted and why nothing found it.
import {
  newViolations,
  hasShrunk,
  updateRefusals,
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
  loadBaseline,
  writeBaseline,
  runGate,
} from '../lib/ratchet.mjs'

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BASELINE_PATH = join(REPO_ROOT, 'scripts', 'docs', 'ui-gate-wording-baseline.json')

/**
 * The retired rules, as term sets rather than one long regex.
 *
 * `requires` are ALL matched against the sentence with its whitespace
 * flattened, so word order does not matter and a hard wrap between any two
 * words of a phrase is invisible to the match. `excludes` are the forms that
 * are legitimate: the corrected `blocking`/`should-fix` wording.
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
    // Two INDEPENDENT words, not one adjacency (review finding). `\brendered
    // route\b` binds the pair, so any inline markup landing between them —
    // `rendered **route**`, or a wrap onto a code span — slips through. That is
    // the same defect one level down from the one this guard exists for: a hard
    // wrap defeats grep, and a bolded word defeats a two-word regex. Both words
    // must still appear in the SAME flattened sentence, which is what keeps
    // this from firing on unrelated prose that happens to say "primitive".
    // Matched against the MARKUP-STRIPPED sentence (see `stripMarkup`), so the
    // rule can say what it means: the two words adjacent, separated by nothing
    // but a space or a hyphen.
    //
    // Three attempts got here, and the two rejected ones bracket why a regex
    // over raw text cannot do this. `\brendered route\b` was too tight — any
    // inline markup between the words slipped through. Three independent words
    // was too loose — it fired on `.github/pull_request_template.md`, whose
    // checklist has no full stops, so the whole list flattens into one
    // "sentence" holding all three words in unrelated bullets. A bounded
    // character gap, `[^A-Za-z0-9]{0,12}`, was wrong on BOTH sides and an
    // independent review reproduced each: it missed `rendered <!-- x --> route`
    // (a comment is longer than the budget and contains letters), and it FIRED
    // on `the rendered, route opens differently` — a clause boundary, not the
    // retired phrase at all.
    //
    // Stripping markup first removes the guesswork: a comma survives stripping
    // and still separates the words, while emphasis, code spans and comments do
    // not survive and no longer hide the pair.
    requires: [/\brendered[ -]route\b/i, /\bprimitive\b/i],
    excludes: [],
  },
]

/**
 * The escape for a sentence that QUOTES the retired wording in order to explain
 * or forbid it (review finding).
 *
 * Without one, this guard cannot tell a violation from a citation of one — and
 * the document most likely to quote the retired sentence verbatim is the one
 * explaining why it is retired. Today no body prose does that, so nothing is
 * broken; the next explanatory doc would have had no clean way out, because
 * baselining is semantically wrong for a citation. It is residue the baseline
 * describes, and a citation is not residue.
 *
 * Deliberately an explicit marker rather than heuristics on words like
 * "retired" or "forbidden": a guard that tries to read intent will get it
 * wrong in both directions, and the repo already uses this shape
 * (`// design-system-exempt: <reason>`, `// ui-local: <reason>`).
 *
 *     <!-- ui-gate-wording-allow: quoting the retired form to forbid it -->
 *
 * It applies to the LINE it appears on, plus one line either side — enough for
 * a hard wrap, and no further. It cannot silence a file, and it cannot excuse a
 * violation in another paragraph. (An earlier draft of this comment said
 * "sentence", describing a scope that was tried and rejected; the mechanism
 * below is line-anchored and this sentence is the correction.)
 *
 * One limit, stated rather than discovered: the marker excuses EVERY violation
 * on the lines it covers, not one specific occurrence. Two distinct retired
 * phrases on one physical line cannot be excused separately.
 */
const ALLOW_MARKER = /<!--\s*ui-gate-wording-allow:[^>]*-->/i

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
 * Segment text into sentences. A sentence ends at a period that is followed by
 * whitespace or end-of-input — NOT at every bare period (#2671). Splitting on
 * bare periods fragmented sentences at URL dots (`example.com/docs` split into
 * two "sentences", each holding half of a retired phrase, so neither matched);
 * a period glued to following text is a dot inside a URL, a filename, a
 * version number or an ellipsis, none of which end a sentence. A period
 * followed by a space or newline can still split mid-thought on an
 * abbreviation ("e.g. "), which over-segments rather than under-segments: the
 * cost is a rarer match, never a false one. `[^.]`-style spanning is kept:
 * a sentence still covers however many lines it is wrapped over.
 *
 * Returns `{ text, index }` so a match can be located in the original file.
 */
export function sentences(text) {
  const out = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '.') continue
    const boundary = i + 1 >= text.length || /\s/.test(text[i + 1])
    if (!boundary) continue
    const chunk = text.slice(start, i + 1)
    if (chunk.trim().length > 0) out.push({ text: chunk, index: start })
    start = i + 1
  }
  const tail = text.slice(start)
  if (tail.trim().length > 0) out.push({ text: tail, index: start })
  return out
}

/**
 * Remove inline markup so a rule can talk about WORDS rather than about the
 * characters that happen to sit between them — AND report where each surviving
 * character came from (#2671).
 *
 * HTML comments go first, then tags. A TAG is `<` + optional `!`/`/` + a
 * letter or digit + anything up to `>`: the old `<[^>]*>` also blanked
 * comparison prose like `< shared primitive >`, deleting one of the very words
 * the guard exists to find and hiding the deletion from the report. Emphasis,
 * code-span backticks and link brackets are deleted outright; a comment or tag
 * span becomes ONE space (so `a<!--x-->b` stays two words). Clause punctuation
 * — commas, semicolons, dashes — is deliberately KEPT: it is what separates
 * `the rendered, route opens differently` from the retired phrase.
 *
 * `idx[j]` is the index within the INPUT of `plain[j]`, which is what lets a
 * match found on the stripped text be reported at a true source position.
 */
export function stripMarkupWithMap(s) {
  const chars = []
  const idx = []
  let i = 0
  const lastIsWs = () => chars.length > 0 && /\s/.test(chars[chars.length - 1])
  while (i < s.length) {
    const rest = s.slice(i)
    const comment = /^<!--[\s\S]*?-->/.exec(rest)
    const tag = /^<[/!]?[A-Za-z0-9][^>]*>/.exec(rest)
    if (comment || tag) {
      const span = comment || tag
      if (!lastIsWs()) {
        chars.push(' ')
        idx.push(i)
      }
      i += span[0].length
      continue
    }
    const ch = s[i]
    if (/[*_`~[\]]/.test(ch)) {
      i++
      continue
    }
    if (/\s/.test(ch)) {
      if (!lastIsWs()) {
        chars.push(' ')
        idx.push(i)
      }
      i++
      continue
    }
    chars.push(ch)
    idx.push(i)
    i++
  }
  let a = 0
  let b = chars.length
  while (a < b && /\s/.test(chars[a])) a++
  while (b > a && /\s/.test(chars[b - 1])) b--
  return { plain: chars.slice(a, b).join(''), idx: idx.slice(a, b) }
}

/** `stripMarkupWithMap(...).plain` — one implementation, no drift. */
export function stripMarkup(s) {
  return stripMarkupWithMap(s).plain
}

/**
 * Blank fenced code blocks newline-for-newline (#2671): every non-newline
 * character becomes a space, so line numbers and offsets stay true to the real
 * file. Illustrative "before" text inside a fence is a citation of the retired
 * form, not live prose — the same distinction front-matter already gets. The
 * block's fence lines themselves are blanked too; a fence line carries no
 * rule-bearing words, so nothing is lost.
 *
 * The opening fence line's last character is rewritten to a period, making the
 * fence a hard SENTENCE boundary: without it, a fully blanked interior would
 * weld the prose before and after the fence into one flattened "sentence", and
 * a retired phrase could straddle the fence and co-occur into a false positive
 * — including through a period-less interior (the common case: a list item
 * ending without a full stop, then an install-command block). Interior periods
 * are also preserved, so an illustrative sentence inside the fence does not
 * weld with surrounding prose either. A 1:1 character swap throughout:
 * offsets, line numbers and newline counts are untouched.
 */
export function blankFences(raw) {
  return raw.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => {
    const blanked = block.replace(/[^\n.]/g, ' ')
    // Terminate the sentence AT the fence: the opening fence line's last
    // character becomes a period, so prose before the fence can never weld
    // with prose after it — including through a PERIOD-LESS interior, which
    // period-preservation alone cannot separate. A 1:1 character swap, so
    // offsets, line numbers and newline counts are untouched.
    const nl = blanked.indexOf('\n')
    return nl > 0 ? blanked.slice(0, nl - 1) + '.' + blanked.slice(nl) : blanked
  })
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
  const body = blankFences(blankFrontMatter(raw))
  const hits = []
  // The citation escape is LINE-scoped: the marker excuses the line it sits on
  // and the line either side of it.
  //
  // Paragraph scope was tried first and cannot work here, for a reason worth
  // recording. `sentences()` splits on sentence-ending periods, and a marker
  // line has none — so the "sentence" beginning at the marker ran straight
  // through the blank line into the next paragraph, and a marker anywhere
  // above a violation excused it. The failure was invisible until a test put
  // the marker in a DIFFERENT paragraph and expected the hit to survive.
  //
  // Lines are what an author can see. Same line, the line before, or the line
  // after — enough for a hard wrap, and no further.
  const allowedLines = new Set()
  body.split('\n').forEach((line, i) => {
    if (!ALLOW_MARKER.test(line)) return
    allowedLines.add(i).add(i - 1).add(i + 1)
  })

  for (const s of sentences(body)) {
    const { flat, map } = flattenWithMap(s.text)
    if (flat.length === 0) continue
    for (const rule of RULES) {
      // Rules match the MARKUP-STRIPPED sentence, and the reported position is
      // mapped from THAT SAME text (#2671). The previous code searched the
      // UNstripped `flat` for the rule's terms and fell back to a bare
      // first-word search on miss: stripped-away markup shifted every index,
      // an earlier unrelated word stole the report (a violation on line 10 was
      // reported on line 8), and the fallback's last resort landed on offset
      // 0 — the sentence start, lines above the phrase.
      const { plain, idx } = stripMarkupWithMap(flat)
      if (rule.requires.some((re) => !re.test(plain))) continue
      if (rule.excludes.some((re) => re.test(plain))) continue
      // Every required term is known to match `plain` (checked above); report
      // the FIRST one, not the sentence start — the sentence may open several
      // hard-wrapped lines above the phrase.
      const at = Math.min(
        ...rule.requires.map((re) => {
          const m = re.exec(plain)
          return m ? m.index : plain.length
        }),
      )
      const offset = map[idx[at]] ?? map[0] ?? 0
      const line = lineOf(body, s.index + offset)
      // The citation escape is anchored to the line the VIOLATING PHRASE is
      // on, not to where its sentence starts. (History: two earlier anchors —
      // the sentence and its paragraph — excused violations several paragraphs
      // away, which is precisely what the escape must not do. The phrase's own
      // line is the only anchor that means what an author reading the file
      // would expect.)
      if (allowedLines.has(line - 1)) continue
      hits.push({
        file,
        rule: rule.id,
        line,
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

// Re-exported, not redefined. The point of #2747 is that this gate stops
// carrying its own COPY of the decision, not that it stops offering the names.
// The only importer is this gate's own test file -- there are no other callers,
// so this is an export surface kept for the tests rather than for a consumer,
// and it is worth saying so instead of implying a wider audience.
export { newViolations, hasShrunk }

/**
 * The shared engine's violations, sorted for a stable report. The ordering is
 * this gate's own concern -- `lib/ratchet.mjs` deliberately does not sort, and
 * the private copy this replaced did, so keeping it here preserves the output
 * byte-for-byte while the DECISION moves to the one place all six gates share.
 *
 * The shared engine names the second dimension `key`; this gate calls it a
 * `rule`, and the printing below reads `f.key`.
 *
 * One difference the swap DOES carry, stated rather than left to surface on the
 * commit that matters: the baseline's key ORDER. The inline writer this gate
 * used sorted with `localeCompare`; `lib/ratchet.mjs`'s `writeBaseline` uses a
 * bare `.sort()`, i.e. code units. Measured over the four tracked root docs in
 * this gate's 454-file set, exactly ONE moves: `README.md`, which sorted after
 * `docs/…` under `localeCompare` and sorts before it under code units.
 * `CLAUDE.md`, `AGENTS.md` and `ABOUT_HAVEN.md` sort before `docs/` under BOTH
 * orders — `localeCompare` is primary-strength on letters, so `A`/`C` precede
 * `d` either way. A first draft of this note named those two as the example,
 * which was the one sentence here nobody had measured. Today's baseline has a
 * single entry so nothing churns, and the first `--update` that adds `README.md`
 * rewrites the whole file once. Deliberate: the five gates already on `writeBaseline`
 * have code-unit-sorted baselines, and changing the shared writer to
 * `localeCompare` would churn theirs instead of this one's.
 */
function sortedViolations(counts, baseline) {
  return newViolations(counts, baseline).sort(
    (a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key),
  )
}

async function main() {
  const update = process.argv.includes('--update')
  const acceptNew = process.argv.includes(ACCEPT_NEW_BASELINE_FLAG)
  // A corrupt baseline used to be REPAIRED by `--update`, which read nothing
  // and overwrote. Reading it first is what makes the refusal possible, so the
  // repair path is gone and a `SyntaxError` with a raw stack is not a remedy
  // (#2747, review finding). Name it instead.
  let loaded
  try {
    // The shape check this gate carried in #2747 lived here. It moved into
    // `loadBaseline` in #2759, where it covers all six gates and one more case
    // this one never reached: an OBJECT baseline holding a non-numeric COUNT,
    // which `count > allowed` reads as false and so silently allows everything
    // for that key. Proven dead before removing it rather than assumed —
    // neutering the local check changed nothing, because `loadBaseline` throws
    // first. An unreachable guard is a guard that cannot fail.
    loaded = loadBaseline(BASELINE_PATH)
  } catch (err) {
    // The headline says "unusable" rather than "not JSON": this also catches a
    // permissions failure, where "not readable as JSON" would misdirect (N1).
    console.error(`✗ ${BASELINE_PATH} is unusable as a baseline: ${err.message}`)
    console.error(
      '\nUntil #2747 `--update` overwrote it without reading, so a corrupt file repaired ' +
        'itself silently. It no longer can — the refusal has to read the baseline to compare ' +
        'against it. Delete the file and re-run with `--update`; an empty scan regenerates it ' +
        'directly. If the scan finds debt, review it and explicitly use `--update --accept-new` ' +
        'to initialize the non-empty baseline.',
    )
    process.exit(1)
  }
  const { baseline, firstRun } = loaded
  const files = listMarkdownFiles()
  const hits = []
  for (const file of files) {
    hits.push(...scanText(file, await readFile(join(REPO_ROOT, file), 'utf8')))
  }
  const counts = countByFile(hits)

  if (update) {
    // #2747: this branch used to write unconditionally, with no comparison at
    // all -- so the command the message below sends you to absorbed any amount
    // of retired wording silently, on a gate that runs inside `docs:check`.
    // Same shape as #2728's, on the sixth consumer of the shared engine.
    const violations = updateRefusals(counts, baseline, { firstRun, acceptNew })
    if (violations.length > 0) {
      console.error('✗ --update refuses to RAISE the baseline. Grown:')
      for (const v of violations) console.error(`  ${v.file} [${v.key}]: ${v.allowed} → ${v.count}`)
      if (firstRun) console.error(firstRunRefusalMessage(firstRun))
      console.error(
        '\nThese rules were RETIRED. Growth is a reviewed decision, not a ratchet step: ' +
          'correct the sentence, or add the allow marker on a line that genuinely quotes the ' +
          'retired wording. If a baseline change is genuinely correct, it belongs in a ' +
          'reviewed commit of its own.',
      )
      process.exit(1)
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`ui-gate-wording: baseline written (${hits.length} existing occurrence(s) ratcheted).`)
    return
  }

  const failures = sortedViolations(counts, baseline)

  if (failures.length > 0) {
    console.error('✗ Retired UI merge-gate wording found in live documentation:\n')
    for (const f of failures) {
      const rule = RULES.find((r) => r.id === f.key)
      console.error(`  ${f.file} — ${f.key}: ${f.count} found, baseline allows ${f.allowed}`)
      console.error(`    states ${rule.what}`)
      for (const h of hits.filter((h) => h.file === f.file && h.rule === f.key)) {
        console.error(`    ${f.file}:${h.line}: ${h.sentence}`)
      }
      console.error(`    → ${rule.fix}\n`)
    }
    console.error(
      'These two rules were retired by #2636 and corrected in ten places across five ' +
        'review rounds, because every sweep before this check was line-bound and the docs ' +
        'are hard-wrapped (#2657). Correct the sentence rather than baselining it; ' +
        'since #2747 `node scripts/docs/ui-gate-wording.mjs --update` REFUSES to raise the ' +
        'baseline, so it is not a way past this: run it after a genuine reduction to ' +
        'tighten the ratchet. Front-matter is not scanned.\n',
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
  // Fail closed: a broken gate that passes is the defect one layer up. The
  // named remedy for a bad baseline lives in `main`'s own try/catch and never
  // reaches this one.
  runGate('ui-gate-wording', main)
}
