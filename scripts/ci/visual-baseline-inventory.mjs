#!/usr/bin/env node
/**
 * Say exactly which baselines the blocking visual gate compared (#2318).
 *
 * ── The defect this closes ───────────────────────────────────────────────────
 *
 * The *Design visual regression* check is one of the ticks a reviewer reads as
 * "the UI is unchanged". Its name said `/design-system`, and even that
 * understated it — it has always run every `*.visual.spec.ts`, which is four
 * files over two routes. Neither the name nor the green tick told anyone which
 * routes were actually compared, so the check licensed a claim far wider than
 * the thing it measured, and no reader could see the gap.
 *
 * The instrument-vs-claim mismatch was the whole of #2318. Adding routes
 * narrows the gap; it cannot close it, because there will always be screens
 * without a baseline. So the claim is made honest as well: this script enumerates
 * the committed baselines and prints them into the job summary, where the person
 * reading the tick is looking.
 *
 * ── What it is, and what it is not ───────────────────────────────────────────
 *
 * It is a REPORT with one guard attached. The report cannot be wrong about what
 * exists, because it reads the committed PNGs rather than a hand-maintained
 * list — the failure mode of every enumeration in this repo (#1874) is that the
 * list drifts from the thing, and a directory listing cannot.
 *
 * It is NOT a claim that the listed routes are well covered, and it deliberately
 * does not try to derive "routes NOT covered" — that set is every screen in the
 * product minus these, and a script that guessed at it would be inventing the
 * authority it is supposed to be removing. It states the negative as a sentence
 * instead, which is true without being derived.
 *
 * ── The guard, and why it is here rather than nowhere ────────────────────────
 *
 * An empty (or missing) baseline tree makes the whole gate pass vacuously:
 * Playwright writes missing snapshots on a first run and the job goes green
 * having compared nothing. That is the same family as #1738's blank captures —
 * a gate that is green about nothing — so this exits non-zero on it. Every
 * other outcome is informational, and it never fails on a baseline COUNT: a
 * count guard would have to be updated by every legitimate change, and a guard
 * everybody has to edit is a guard everybody edits without reading.
 */
import { readdirSync, statSync, appendFileSync } from 'node:fs'
import path from 'node:path'

export const BASELINE_ROOT = 'packages/frontend/e2e/__screenshots__'

/**
 * Every committed baseline, grouped by the spec file that owns it.
 *
 * Sorted at both levels so the summary is stable between runs — an unstable
 * report gets read as churn and then stops being read.
 */
export function collectBaselines(root) {
  let specDirs
  try {
    specDirs = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  return specDirs
    .map((spec) => ({
      spec,
      baselines: readdirSync(path.join(root, spec))
        .filter((f) => f.endsWith('.png'))
        .sort(),
    }))
    .filter((group) => group.baselines.length > 0)
}

export function renderSummary(groups) {
  const total = groups.reduce((n, g) => n + g.baselines.length, 0)
  const lines = [
    '## Visual regression — what was actually compared',
    '',
    `**${total}** committed baseline${total === 1 ? '' : 's'} across **${groups.length}** spec file${groups.length === 1 ? '' : 's'}:`,
    '',
  ]
  for (const group of groups) {
    lines.push(`- \`${group.spec}\``)
    for (const baseline of group.baselines) lines.push(`  - \`${baseline}\``)
  }
  lines.push(
    '',
    '> A green tick here means **these** captures are unchanged. Any screen not',
    '> listed above has no pixel baseline at all, and this check says nothing',
    '> about it — see `packages/frontend/e2e/product-routes.visual.spec.ts` for',
    '> which routes were considered and why the uncovered ones were left out',
    '> (#2318).',
  )
  return lines.join('\n')
}

/** @returns exit code — 0 on a non-empty tree, 1 on the vacuous-pass case. */
export function run(root = BASELINE_ROOT, write = (text) => process.stdout.write(`${text}\n`)) {
  const groups = collectBaselines(root)
  if (groups.length === 0) {
    write(
      `No visual baselines found under ${root}. The visual gate would pass ` +
        `vacuously: Playwright writes missing snapshots on a first run and ` +
        `compares nothing. Restore the baselines, or regenerate them with the ` +
        `"Update visual baselines" workflow (#2318).`,
    )
    return 1
  }
  write(renderSummary(groups))
  return 0
}

// Not executed on import, so the test file can drive the pure functions above.
if (process.argv[1] && statSync(process.argv[1]).isFile() &&
    path.basename(process.argv[1]) === 'visual-baseline-inventory.mjs') {
  const code = run(process.env.VISUAL_BASELINE_ROOT ?? BASELINE_ROOT, (text) => {
    process.stdout.write(`${text}\n`)
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
    }
  })
  process.exit(code)
}
