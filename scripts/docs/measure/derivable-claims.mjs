#!/usr/bin/env node
// #2678 measurement 2 of 4 — the derivable-claim census.
//
// Read-only, dependency-free. Seven regex classes over governed doc BODIES,
// counting OCCURRENCES of prose that asserts something a machine could check.
//
// ## Occurrences, not sentences — and how that was established
//
// The epic's § *How to re-run this measurement* names the seven classes but
// records none of the regexes, so the classes had to be re-derived. Counting
// occurrences (not matching sentences) is what makes four of the seven land on
// the epic's own figures, which is the evidence that it is the right unit:
//
//   | class           | epic | here | |
//   |-----------------|-----:|-----:|--|
//   | percentage      |   46 |   46 | exact |
//   | ratio           |   23 |   23 | exact |
//   | named-file      |  272 |  270 | −0.7% |
//   | exhaustive-set  |  180 |  186 | +3%   |
//   | gate            |   92 |   62 | DOES NOT REPRODUCE |
//   | http-status     |   37 |   59 | DOES NOT REPRODUCE |
//   | bare-count      |   40 |  150 | DOES NOT REPRODUCE |
//
// The three that do not reproduce were tried against several readings each
// (for `gate`: `is required`/`is advisory` alone → 32, plus the blocking and
// fail-closed forms → 41, the bare word `required` anywhere → 172; for
// `http-status`: `HTTP nnn` → 59, bare 4xx/5xx tokens → 420; for `bare-count`:
// `exactly N` → 1, a number word before a plural noun → 363, a digit before
// one → 273). None lands on the epic's figure, so those three are defined here
// on their own merits and the epic body was corrected rather than fitted to.
// Definitions are recorded in `re` below precisely so the next person does not
// have to repeat this.
//
// ## Read this as a magnitude, never as an inventory
//
// The epic already concedes this ("regex-based, so it is an estimate of
// magnitude, not an exact inventory"). Two consequences worth stating rather
// than leaving to be discovered:
//
//   - It is a LOWER bound in one direction: a claim phrased in a way no class
//     recognises is invisible, and these classes are deliberately narrow.
//   - It is an UPPER bound in another: a class fires on prose that merely
//     resembles the pattern. `ui-gate-wording.mjs` shipped with matching wrong
//     in BOTH directions and needed two follow-up PRs (#2675, #2676); nothing
//     here is more careful than that guard was. It gates nothing, which is the
//     only reason a rough number is acceptable.
//
// The number that carries epic #2678's argument is not this one — it is the
// (doc, uncovered file) pair count from `covers-gaps.mjs`, where every pair
// names a specific doc and a specific file a reader can go and check.
//
// Front-matter is excluded — the `last-verified` chain is measured by
// `corpus-mass.mjs`. Fenced blocks are NOT excluded, and that is calibration
// rather than preference: blanking them drops `percentage` from 46 to 29 and
// `ratio` from 23 to 22, breaking both exact reproductions above. A figure in
// an illustrative block is a claim the doc is making as much as one in a
// sentence, and `covers-gaps.mjs` scans fences for the same reason.
import { governed, row, heading } from './corpus.mjs'

const N = '(?:\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)'

export const CLASSES = [
  {
    id: 'named-file',
    what: 'asserts something about a named source file',
    // A path inside a CODE SPAN. The backticks are the discriminator: bare
    // prose mentioning a path is usually a link target or an example, while a
    // code span is how this repo writes "the thing at this path". Counting
    // every path token instead gives 392 and drifts far from the epic's 272.
    re: /`(?:packages|scripts|\.github)\/[A-Za-z0-9._/-]*\.(?:ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|sql|sh|css|toml)`/g,
    epic: 272,
  },
  {
    id: 'exhaustive-set',
    what: 'claims a set is complete ("the only…", "exactly three…", "nothing else")',
    re: new RegExp(`\\b(?:the only|exactly ${N}|nothing else|no other)\\b`, 'gi'),
    epic: 180,
  },
  {
    id: 'gate',
    what: "asserts a gate's posture (\"is required\" / \"is advisory\" / \"exits 1\")",
    re: /\b(?:is|are|stays?|remains?) (?:a )?(?:required|advisory|blocking|non-blocking|fail-closed|fail-open)\b|\brequired check\b|\bexits? 1\b/gi,
    epic: 92,
    reproduces: false,
  },
  { id: 'percentage', what: 'states a percentage', re: /\b\d+(?:\.\d+)?\s?%/g, epic: 46 },
  {
    id: 'bare-count',
    what: 'states a quantified count ("exactly three X", "there are five X")',
    // Deliberately QUALIFIED. An unqualified number before a plural noun
    // ("three answers") matches 363 times and is mostly ordinary English, not
    // an assertion; requiring an exhaustiveness qualifier or a `there are`
    // frame keeps the class to prose that is actually claiming a count.
    re: new RegExp(`\\b(?:exactly|only|all|just)\\s+${N}\\b|\\bthere (?:are|were|is|was)\\s+${N}\\b`, 'gi'),
    epic: 40,
    reproduces: false,
  },
  { id: 'http-status', what: 'asserts an HTTP status code', re: /\bHTTP\s?\d{3}\b/g, epic: 37, reproduces: false },
  {
    id: 'ratio',
    what: 'states a ratio ("25 of 26")',
    re: /\b\d+\s+of\s+\d+\b/g,
    epic: 23,
  },
]

const docs = await governed()
const counts = Object.fromEntries(CLASSES.map((c) => [c.id, 0]))
const perDoc = []

for (const d of docs) {
  const body = d.body
  let n = 0
  for (const c of CLASSES) {
    const hits = body.match(c.re)?.length ?? 0
    counts[c.id] += hits
    n += hits
  }
  perDoc.push([d.file, n])
}

const total = Object.values(counts).reduce((a, b) => a + b, 0)
const epicTotal = CLASSES.reduce((a, c) => a + c.epic, 0)

heading('#2678 measurement 2/4 — machine-checkable claims living as prose')
console.log(`  ${'class'.padEnd(18)}${'here'.padStart(8)}${'epic'.padStart(8)}   status`)
for (const c of CLASSES) {
  const delta = c.epic === 0 ? '' : `${(((counts[c.id] - c.epic) / c.epic) * 100).toFixed(0)}%`
  const status = counts[c.id] === c.epic ? 'exact' : c.reproduces === false ? 'DOES NOT REPRODUCE' : delta
  console.log(`  ${c.id.padEnd(18)}${String(counts[c.id]).padStart(8)}${String(c.epic).padStart(8)}   ${status}`)
}
console.log('')
row('TOTAL', total)
row('epic body states', epicTotal)
row('across governed docs', docs.length)

console.log('\n  Heaviest docs:')
for (const [file, n] of perDoc.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    ${String(n).padStart(4)}  ${file}`)
}
console.log(
  '\n  Magnitude, not an inventory: narrow classes under-count and look-alike\n' +
    '  prose over-counts. Nothing gates on this number. Three of the seven\n' +
    '  classes do not reproduce the epic — see the docstring for what was tried.\n',
)
