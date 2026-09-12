#!/usr/bin/env node
// Reads an epic body and answers ONE question for ship-next's closeout (#2767):
// may this epic be reported "ready to close"?
//
// `.github/ISSUE_TEMPLATE/loop-epic.md` carries a `## Promotion checklist`
// section — the operator steps the epic depends on and its product verification
// on `dev`, each an unticked box naming where it is done. An epic is ready to
// close only when every box in that section is ticked; otherwise the closeout
// lists the unticked ones and the epic stays open across the promotion until a
// human ticks the last box (owner decision 2026-09-08).
//
// Exit codes, so the skill can branch on them without parsing prose:
//   0  ready — every box ticked, OR the epic has no such section (it predates the
//      template change; the tool SAYS so on stdout rather than inventing boxes)
//   1  not ready — at least one unticked box; each is printed
//   2  usage / unreadable input — INCLUDING an empty or whitespace-only body. A
//      plain pipeline does not propagate `gh issue view`'s failure, so a bad epic
//      number or an auth failure delivers empty stdin; reading that as "no
//      section, ready" would be a false green (review finding on #2767).
//
// Usage:
//   gh issue view <epic> --json body -q .body | node scripts/ci/epic-promotion-checklist.mjs
//   node scripts/ci/epic-promotion-checklist.mjs <body-file>

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `[ \t]` rather than `\s`: under the `m` flag `\s*$` would swallow the heading's
// newline and every blank line after it, and the line numbers reported below
// would then start inside the template's guidance comment (review finding).
export const SECTION_HEADING = /^##[ \t]+promotion checklist[ \t]*$/im

/**
 * Parse the Promotion checklist section out of an issue body.
 *
 * Returns { present, boxes: [{ ticked, text, line }] }. Boxes are GitHub task-list
 * items (`- [ ]` / `- [x]`, `*` accepted, any indentation) between the section
 * heading and the next `## ` heading. Text inside HTML comments is ignored, so the
 * template's own guidance comment cannot count as a box.
 */
export function readPromotionChecklist(body) {
  const source = String(body ?? '').replace(/\r\n/g, '\n')
  const stripped = source.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
  const match = SECTION_HEADING.exec(stripped)
  if (!match) return { present: false, boxes: [] }

  const start = match.index + match[0].length
  const rest = stripped.slice(start)
  const next = /^##\s+/m.exec(rest)
  const section = next ? rest.slice(0, next.index) : rest
  const headingLine = stripped.slice(0, match.index).split('\n').length

  const boxes = []
  section.split('\n').forEach((raw, i) => {
    const m = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(raw)
    if (!m) return
    // `rest` begins on the heading's own line (after its text), so index 0 IS the
    // heading line and box i sits at headingLine + i.
    boxes.push({ ticked: m[1] !== ' ', text: m[2].trim(), line: headingLine + i })
  })
  return { present: true, boxes }
}

/** The verdict the closeout reports. */
export function evaluate(body) {
  const { present, boxes } = readPromotionChecklist(body)
  if (!present) {
    return {
      ready: true,
      reason: 'no-section',
      unticked: [],
      total: 0,
      message:
        'no `## Promotion checklist` section — this epic predates the #2767 template; ' +
        'ready to close on its sub-issues alone, and the closeout names that absence.',
    }
  }
  const unticked = boxes.filter((b) => !b.ticked)
  if (boxes.length === 0) {
    return {
      ready: false,
      reason: 'empty-section',
      unticked: [],
      total: 0,
      message: '`## Promotion checklist` is present but has no boxes — fill it or remove it before reporting ready.',
    }
  }
  if (unticked.length > 0) {
    return {
      ready: false,
      reason: 'unticked',
      unticked,
      total: boxes.length,
      message: `NOT ready to close — ${unticked.length} of ${boxes.length} Promotion checklist box(es) unticked:`,
    }
  }
  return {
    ready: true,
    reason: 'all-ticked',
    unticked: [],
    total: boxes.length,
    message: `ready to close — all ${boxes.length} Promotion checklist box(es) ticked.`,
  }
}

function main(argv) {
  let body
  try {
    body = argv[0] ? readFileSync(argv[0], 'utf8') : readFileSync(0, 'utf8')
  } catch (err) {
    console.error(`epic-promotion-checklist: could not read body: ${err.message}`)
    return 2
  }
  if (body.trim() === '') {
    console.error('epic-promotion-checklist: empty body — did `gh issue view … -q .body` fail upstream of the pipe?')
    return 2
  }
  const verdict = evaluate(body)
  console.log(`epic-promotion-checklist: ${verdict.message}`)
  for (const box of verdict.unticked) console.log(`  - [ ] ${box.text}  (line ${box.line})`)
  return verdict.ready ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
