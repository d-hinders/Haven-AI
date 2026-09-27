/**
 * Client release data — generated from the package CHANGELOGs (#3304, #3305)
 *
 * `packages/core/src/client-releases.data.ts` holds `CLIENT_RELEASES`: per
 * published package, the version released in source and short notes for the
 * newest releases. `GET /discovery`, `/.well-known/haven.json` and `/releases`
 * serve it (#3304). This module makes that file a PURE FUNCTION of the five
 * CHANGELOGs, and `release-bump.mjs` writes it on every real release — the
 * fifth thing the bump owns, beside versions, pins, the Supported Runtime
 * Manifest table and the CHANGELOG release heading.
 *
 * ## Why regenerate from the CHANGELOGs rather than append
 *
 * An appended file has history nobody can re-derive, so a hand edit to an
 * old note is invisible. A file that is `f(CHANGELOGs)` can be checked: before
 * writing, the bump regenerates the file from the CHANGELOGs AS THEY STAND and
 * compares it with the file on disk. Any difference is a hand edit (or a
 * CHANGELOG edited after its release), and the bump refuses and names it —
 * refused at bump time. That is the same "never verify your own write"
 * argument `release-changelog.mjs` makes. Earlier still, CI's
 * `release-bump.test.mjs` compares the committed file with the committed
 * CHANGELOGs, so a PR that edits one without regenerating goes red.
 *
 * ## What a note is
 *
 * One note per released version per package: the version, its date, a short
 * summary and `action_required`. The summary is the lead bullet's headline —
 * its opening bold span when it has one (the house style, e.g.
 * `**Client identity (#3303).**`), otherwise its first sentence — plus its next
 * sentence when both fit, then how many more changes the CHANGELOG lists.
 * Never cut mid-clause (a headline over the limit is shortened only at a
 * top-level `;`); issue references stripped, since a public reader cannot use
 * them. It is "what changed, for deciding whether to
 * update", not the CHANGELOG; the CHANGELOG stays the record.
 *
 * ## The action-required marker
 *
 * A bullet carrying {@link ACTION_REQUIRED_MARKER} (`**Update required**`)
 * makes its release `action_required: true`: a client must update to keep
 * paying. It is deliberately NOT `**BREAKING**`. BREAKING means "updating may
 * break you"; action-required means "not updating will" — nearly the
 * opposite, and conflating them would tell every agent to update into a break.
 *
 * ## What this never touches
 *
 * `packages/core/src/client-compat.ts` — the enforced `min_version` /
 * `recommended_version` table. A release must never raise a minimum as a side
 * effect (#3305); that table is hand-edited by owner decision. The writer below
 * returns ONE file's text, and the bump writes it to ONE path.
 */

import { CHANGELOG_PACKAGES } from './release-changelog.mjs'

/** Where the generated data lives, relative to the repository root. */
export const CLIENT_RELEASE_DATA_FILE = 'packages/core/src/client-releases.data.ts'

/** The CHANGELOG marker that sets `action_required` on its release (#3305). */
export const ACTION_REQUIRED_MARKER = '**Update required**'

/** Newest releases kept per package. Older ones stay in the CHANGELOG. */
export const MAX_NOTES_PER_PACKAGE = 2

/**
 * A summary grows by its lead bullet's second sentence only while it stays
 * within this many characters. Never cut mid-clause: a headline over it is
 * shortened at a top-level `;`, otherwise served whole.
 */
export const MAX_SUMMARY_CHARS = 300

const RELEASE_HEADING = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) — (\d{4}-\d{2}-\d{2})\s*$/

/**
 * The released sections of one CHANGELOG, newest first, as
 * `{ version, date, body }`. `## Unreleased` and anything else that is not a
 * `## <version> — <date>` heading ends a section but starts none.
 */
export function releasedSections(source) {
  const sections = []
  let current = null
  for (const line of source.split('\n')) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current)
      const m = RELEASE_HEADING.exec(line)
      current = m ? { version: m[1], date: m[2], lines: [] } : null
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) sections.push(current)
  return sections.map(({ version, date, lines }) => ({ version, date, body: lines.join('\n') }))
}

/** Top-level bullets of a section body, each with its continuation lines joined. */
export function topLevelBullets(body) {
  const bullets = []
  let current = null
  for (const line of body.split('\n')) {
    if (/^- /.test(line)) {
      if (current !== null) bullets.push(current)
      current = line.slice(2)
    } else if (current !== null && /^\s+\S/.test(line) && !/^\s+- /.test(line)) {
      current += ' ' + line.trim()
    } else if (current !== null && (line.trim() === '' || /^#{3,}\s/.test(line) || /^\s+- /.test(line))) {
      // A blank line, a `###` sub-heading or a nested list ends the lead text;
      // nested items are detail, not the headline.
      bullets.push(current)
      current = null
    }
  }
  if (current !== null) bullets.push(current)
  return bullets
}

/** Markdown emphasis and code ticks removed — the summary is rendered as plain text. */
function plain(text) {
  return text.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Plain text fit for a public page: the issue references a CHANGELOG uses for
 * traceability (`(#3303, epic #3302)`, a leading `#3128:`) removed, and the
 * CHANGELOG's `BREAKING` shouting spelled out. Readers of `/releases` decide
 * whether to update; issue numbers mean nothing to them.
 */
export function publicText(text) {
  let out = plain(text.replace(new RegExp(ACTION_REQUIRED_SPAN.source, 'g'), ''))
  let prev
  do {
    prev = out
    out = out.replace(/\s*\([^()]*#\d+[^()]*\)/g, '')
  } while (out !== prev)
  return out
    .replace(/^#\d+:\s*/, '')
    .replace(/,?\s*\bepic #\d+/g, '')
    .replace(/(^|\s)#\d+(?:'s)?(?=[\s.,;:!?)]|$)/g, '$1')
    .replace(/\bBREAKING\b/g, 'Breaking change')
    .replace(/\s+([.,;:])(?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A bullet as whole sentences, headline first. The opening bold span is the
 * headline when there is one (the house style, `**Client identity (#3303).**`);
 * otherwise the first sentence is. A sentence ends at `.`, `!` or `?` followed
 * by a space — never at a colon, which in these changelogs is as often inside
 * a code span (`{ source: 'wallet' }`) as it is punctuation.
 */
export function bulletSentences(bullet) {
  const trimmed = bullet.trim()
  const bold = /^\*\*(.+?)\*\*/.exec(trimmed)
  const sentences = []
  let rest = trimmed
  if (bold) {
    const head = publicText(bold[1]).replace(/[:]$/, '')
    if (head.length > 0) sentences.push(/[.!?]$/.test(head) ? head : `${head}.`)
    rest = trimmed.slice(bold[0].length)
  }
  for (const s of splitSentences(publicText(rest))) {
    const clean = s.replace(/^(?:[.,;:](?=\s|$)|\s|—\s)+/, '')
    if (clean.length > 0) sentences.push(clean)
  }
  return sentences
}

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATION = /\b(?:e\.g|i\.e|vs|etc|cf)\.$/i

function splitSentences(text) {
  const out = []
  let current = ''
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    current = current ? `${current} ${piece}` : piece
    if (!ABBREVIATION.test(current)) {
      out.push(current)
      current = ''
    }
  }
  if (current) out.push(current)
  return out
}

/**
 * A sentence longer than {@link MAX_SUMMARY_CHARS}, shortened at a CLAUSE
 * boundary — a `;` outside brackets — never mid-clause. One with no such
 * boundary is served whole.
 */
function fitSentence(sentence) {
  if (sentence.length <= MAX_SUMMARY_CHARS) return sentence
  let depth = 0
  let lastFit = -1
  for (let i = 0; i < sentence.length && i < MAX_SUMMARY_CHARS; i++) {
    const c = sentence[i]
    if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth = Math.max(0, depth - 1)
    else if (c === ';' && depth === 0) lastFit = i
  }
  return lastFit > 0 ? `${sentence.slice(0, lastFit)}.` : sentence
}


/**
 * The marker as it must appear: a bold span, optionally ending in `.` or `:`
 * (a line wrap between the two words is still the marker).
 * Matched only outside code spans, so prose that QUOTES the marker in
 * backticks (as the CHANGELOG headers do) does not flag a release.
 */
const ACTION_REQUIRED_SPAN = /\*\*Update\s+required[.:]?\*\*/

function withoutCodeSpans(text) {
  return text.replace(/`[^`]*`/g, '')
}

/** True when `text` carries the marker outside a code span. */
export function carriesActionRequired(text) {
  return ACTION_REQUIRED_SPAN.test(withoutCodeSpans(text))
}

/**
 * "update required" written any other way — lowercase, not bold, bold with more
 * words inside. The author meant must-update and the flag would silently say
 * the opposite, so the generator REFUSES rather than guess (#3305 review).
 */
export function nearMissMarker(text) {
  const outside = withoutCodeSpans(text)
  const all = outside.match(/\bupdate\s+required\b/gi) ?? []
  const exact = outside.match(new RegExp(ACTION_REQUIRED_SPAN.source, 'g')) ?? []
  return all.length > exact.length
}

/** A bullet with a leading marker span removed, so its real headline leads. */
function withoutLeadingMarker(bullet) {
  return bullet.trim().replace(new RegExp(`^${ACTION_REQUIRED_SPAN.source}\\s*`), '')
}

/**
 * The text a section's note is built from when it has no top-level bullet:
 * its first prose paragraph. A section with content is never announced as
 * having none.
 */
function proseLead(body) {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0)
  const prose = paragraphs.find((p) => !/^(#|\||```|>)/.test(p))
  if (prose !== undefined) return prose.split('\n').map((l) => l.trim()).join(' ')
  return null
}

/** One release note from one released section. */
export function noteFromSection({ version, date, body }) {
  // The marker counts anywhere in the section — a nested bullet or a
  // continuation paragraph included — so where it sits never hides it.
  if (nearMissMarker(body)) {
    throw new Error(
      `${version}: "update required" appears but not as the marker ${ACTION_REQUIRED_MARKER} ` +
        '(exactly that bold span, optionally ending in "." or ":"). If clients must update, write ' +
        'the marker exactly; if the text only mentions it, quote it in a code span; if it means ' +
        'the opposite ("no update required"), reword it ("no update needed").',
    )
  }
  const actionRequired = carriesActionRequired(body)
  const bullets = topLevelBullets(body).filter((b) => bulletSentences(withoutLeadingMarker(b)).length > 0)
  let lead
  if (bullets.length > 0) {
    // Lead with the marked bullet when there is one: that is what a reader must see.
    lead = withoutLeadingMarker(bullets.find(carriesActionRequired) ?? bullets[0])
  } else {
    lead = proseLead(body)
  }
  if (lead === null || bulletSentences(lead).length === 0) {
    return { version, date, summary: 'No changes to this package in this release.', action_required: actionRequired }
  }
  const [rawHeadline, next] = bulletSentences(lead)
  const headline = fitSentence(rawHeadline)
  let summary = headline
  // A shortened headline is not followed by its next sentence: that would read
  // as if it followed the clause kept, not the one dropped.
  if (headline === rawHeadline && next !== undefined && `${headline} ${next}`.length <= MAX_SUMMARY_CHARS) summary = `${headline} ${next}`
  if (bullets.length > 1) summary += ` (+${bullets.length - 1} more in the changelog)`
  return { version, date, summary, action_required: actionRequired }
}

/**
 * `CLIENT_RELEASES` as data, from the CHANGELOG texts keyed by package dir
 * name (`sdk`, `signer`, …). Throws when a package has no released section:
 * a published package with nothing to announce is a broken CHANGELOG, not an
 * empty entry to invent.
 */
export function clientReleasesFrom(changelogs) {
  const out = {}
  for (const name of CHANGELOG_PACKAGES) {
    const source = changelogs[name]
    if (typeof source !== 'string') throw new Error(`packages/${name}/CHANGELOG.md was not provided`)
    const notes = releasedSections(source).slice(0, MAX_NOTES_PER_PACKAGE).map((section) => {
      try {
        return noteFromSection(section)
      } catch (err) {
        throw new Error(`packages/${name}/CHANGELOG.md ${err.message}`)
      }
    })
    if (notes.length === 0) throw new Error(`packages/${name}/CHANGELOG.md has no "## <version> — <date>" section`)
    out[`@haven_ai/${name}`] = { released_version: notes[0].version, notes }
  }
  return out
}

/** The full text of {@link CLIENT_RELEASE_DATA_FILE}. Deterministic: same input, same bytes. */
export function renderClientReleaseDataFile(data) {
  return [
    '/**',
    ' * GENERATED by `scripts/release-bump.mjs` from the five package CHANGELOGs',
    ' * (#3305, via `scripts/release-client-data.mjs`). Do not hand-edit: the bump',
    ' * regenerates this file from the CHANGELOGs before every release and REFUSES',
    ' * to run when the file on disk differs from what they produce.',
    ' *',
    ' * To change a note, change the CHANGELOG entry it comes from. To mark a',
    ' * release as one clients must update to, put `**Update required**` on its',
    ' * CHANGELOG bullet. The enforced thresholds are NOT here — they live in',
    ' * `client-compat.ts`, which the bump never writes.',
    ' *',
    ' * Untyped on purpose: `client-releases.ts` imports this and types it, so',
    ' * this file imports nothing and no module cycle forms.',
    ' */',
    '',
    `export const CLIENT_RELEASE_DATA = ${JSON.stringify(data, null, 2)}`,
    '',
  ].join('\n')
}

/**
 * Differences between the file on disk and what the CHANGELOGs produce —
 * the hand-edit check. Empty when they agree. Reports the first differing line
 * so the refusal names what moved rather than just that something did.
 */
export function clientReleaseDataViolations(fileText, changelogs) {
  let expected
  try {
    expected = renderClientReleaseDataFile(clientReleasesFrom(changelogs))
  } catch (err) {
    return [`cannot regenerate ${CLIENT_RELEASE_DATA_FILE}: ${err.message}`]
  }
  if (fileText === expected) return []
  const a = fileText.split('\n')
  const b = expected.split('\n')
  const i = a.findIndex((line, n) => line !== b[n])
  const at = i === -1 ? Math.min(a.length, b.length) : i
  return [
    `${CLIENT_RELEASE_DATA_FILE} is not what the CHANGELOGs produce (first difference at line ${at + 1}: ` +
      `on disk ${JSON.stringify(a[at] ?? '<end of file>')}, expected ${JSON.stringify(b[at] ?? '<end of file>')}). ` +
      'It was hand-edited, or a CHANGELOG was edited after its release. Put the change in the CHANGELOG, ' +
      'then regenerate with `node scripts/release-client-data.mjs --write`.',
  ]
}

// ---------------------------------------------------------------------------
// CLI — `node scripts/release-client-data.mjs --write | --check`
//   --write  regenerate the data file from the CHANGELOGs (what the bump does)
//   --check  exit 1 when the file differs from what the CHANGELOGs produce
// Both exist so a contributor can see the bump's (and CI's) answer without
// cutting a release, and fix a red one with a single command.
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false
  try {
    const { realpathSync } = process.getBuiltinModule('node:fs')
    const { fileURLToPath } = process.getBuiltinModule('node:url')
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isMain) await (async () => {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const mode = process.argv[2]
  if (mode !== '--write' && mode !== '--check') {
    console.error('usage: node scripts/release-client-data.mjs --write | --check')
    process.exitCode = 2
    return
  }
  const changelogs = {}
  for (const name of CHANGELOG_PACKAGES) {
    changelogs[name] = await readFile(join(root, 'packages', name, 'CHANGELOG.md'), 'utf8')
  }
  const path = join(root, CLIENT_RELEASE_DATA_FILE)
  if (mode === '--write') {
    await writeFile(path, renderClientReleaseDataFile(clientReleasesFrom(changelogs)), 'utf8')
    console.log(`wrote ${CLIENT_RELEASE_DATA_FILE}`)
    return
  }
  let onDisk = ''
  try { onDisk = await readFile(path, 'utf8') } catch { /* reported below */ }
  const violations = clientReleaseDataViolations(onDisk, changelogs)
  if (violations.length > 0) {
    for (const v of violations) console.error(`✗ ${v}`)
    process.exitCode = 1
    return
  }
  console.log(`✓ ${CLIENT_RELEASE_DATA_FILE} matches the CHANGELOGs`)
})()
