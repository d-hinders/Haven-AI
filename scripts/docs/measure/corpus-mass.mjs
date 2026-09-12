#!/usr/bin/env node
// #2678 measurement 1 of 4 — corpus and chain mass, and the `covers:` census.
//
// Read-only, dependency-free. Reproduces (or corrects) the epic's
// § *Corpus and its annotation* table and the `63` in its headline ratio.
//
// ## The `63`, settled
//
// The epic's headline table labels 63 as "Declared `covers:` entries,
// repo-wide". It is not an entry count. Parsed at the epic's own commit
// `dee89b8e` this script's definitions give: 73 governed docs, 10 of them
// `covers: []`, so **63 governed docs declare at least one `covers:` entry** —
// and 807 entries between them. The epic's own `74 − 11` arithmetic lands on
// the same 63 from a doc count one off in both terms.
//
// That matters because the epic's ratio, "690 machine-checkable prose claims
// against 63", was reading as claims-per-entry. It is claims against
// *documents*, which is not a ratio of two comparable things at all. Both
// numbers are printed below so a reader can see which is which; #2678's body
// was corrected in the PR that added this script.
import { governed, words, row, heading } from './corpus.mjs'

const docs = await governed()

const bodyWords = docs.reduce((n, d) => n + words(d.body), 0)
const chainWords = docs.reduce((n, d) => n + words(d.chain), 0)
const chainBytes = docs.reduce((n, d) => n + Buffer.byteLength(d.chain, 'utf8'), 0)

// Body words on lines that carry an issue reference (`#1234`).
const issueRefWords = docs.reduce(
  (n, d) => n + d.body.split(/\r?\n/).filter((l) => /#\d{3,}/.test(l)).reduce((m, l) => m + words(l), 0),
  0,
)

const entries = docs.flatMap((d) => d.data.covers ?? [])
const empty = docs.filter((d) => (d.data.covers ?? []).length === 0)
const withCovers = docs.length - empty.length

heading('#2678 measurement 1/4 — corpus and chain mass')
row('governed docs (status not archived/research)', docs.length)
row('governed body words', bodyWords.toLocaleString('en-US'))
row('live verification-chain words (retired)', chainWords.toLocaleString('en-US'))
row('live verification-chain bytes (retired)', chainBytes.toLocaleString('en-US'))
row('live verification-chain share of governed prose', `${Math.round((chainWords / (bodyWords + chainWords)) * 100)}%`)
row('body words on lines carrying an issue ref', `${Math.round((issueRefWords / bodyWords) * 100)}%`)

console.log('')
row('governed docs with `covers: []`', empty.length)
row('governed docs declaring ≥1 `covers:` entry  ← the "63"', withCovers)
row('declared `covers:` ENTRIES across those docs', entries.length)
row('  …of which unique', new Set(entries).size)
row('  …of which contain a glob', entries.filter((e) => /[*?]/.test(e)).length)

const claude = docs.find((d) => d.file === 'CLAUDE.md')
if (claude) {
  console.log('')
  row('CLAUDE.md body words', words(claude.body).toLocaleString('en-US'))
  row('CLAUDE.md live verification-chain bytes', Buffer.byteLength(claude.chain, 'utf8').toLocaleString('en-US'))
}

console.log('')
console.log('  Docs with `covers: []` (nothing can ever implicate them):')
for (const d of empty) console.log(`    ${d.file}`)
