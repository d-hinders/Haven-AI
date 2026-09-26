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
 * caught at bump time, which is the only time this file changes. That is the
 * same "never verify your own write" argument `release-changelog.mjs` makes.
 *
 * ## What a note is
 *
 * One note per released version per package: the version, its date, a short
 * summary and `action_required`. The summary is built from each top-level
 * bullet's lead — its opening bold span when it has one (the house style,
 * e.g. `**Client identity (#3303).**`), otherwise its first sentence — joined
 * and capped. It is "what changed, for deciding whether to update", not the
 * CHANGELOG; the CHANGELOG stays the record.
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
export const MAX_NOTES_PER_PACKAGE = 3

/** Longest summary served; a longer one is cut at a word and marked. */
export const MAX_SUMMARY_CHARS = 320

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

/** Longest single lead taken from an un-bolded bullet's first sentence. */
const MAX_LEAD_CHARS = 160

/**
 * A bullet's headline: its opening bold span, else its first sentence. The
 * sentence is found AFTER markup is stripped and only at a sentence end —
 * never at a colon, which in this repo's changelogs is as often inside a code
 * span (`{ source: 'wallet' }`) as it is punctuation.
 */
export function bulletLead(bullet) {
  const bold = /^\*\*(.+?)\*\*/.exec(bullet.trim())
  if (bold) return plain(bold[1]).replace(/[.:]+$/, '')
  const sentence = plain(bullet).split(/(?<=[.!?])\s/)[0]
  return capAt(sentence, MAX_LEAD_CHARS).replace(/[.:]+$/, '')
}

/** Cut at a word boundary and mark the cut. */
function capAt(text, max) {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[;,(]$/, '') + '…'
}

function cap(text) {
  return capAt(text, MAX_SUMMARY_CHARS)
}

/** One release note from one released section. */
export function noteFromSection({ version, date, body }) {
  const bullets = topLevelBullets(body)
  const leads = bullets.map(bulletLead).filter((l) => l.length > 0 && l !== plain(ACTION_REQUIRED_MARKER))
  return {
    version,
    date,
    summary: leads.length > 0 ? cap(leads.join('; ')) : 'No changes in this package.',
    action_required: bullets.some((b) => b.includes(ACTION_REQUIRED_MARKER)),
  }
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
    const notes = releasedSections(source).slice(0, MAX_NOTES_PER_PACKAGE).map(noteFromSection)
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
    ' */',
    '',
    "import type { PublishedClientPackage } from './client-compat.js'",
    "import type { ClientRelease } from './client-releases.js'",
    '',
    `export const CLIENT_RELEASES: Readonly<Record<PublishedClientPackage, ClientRelease>> = ${JSON.stringify(data, null, 2)}`,
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
// Neither runs in CI (#3305: a hand edit is caught at bump time); both exist so
// a contributor can see the bump's answer without cutting a release.
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
