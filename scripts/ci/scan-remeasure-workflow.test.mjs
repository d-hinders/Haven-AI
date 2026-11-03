// Pins `.github/workflows/scan-remeasure.yml` (#4625): the weekly job that
// re-runs the quality-scan manifest. Each assertion names the failure it
// stops — a job that keeps running but answers a different question is the
// defect the job itself exists to catch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/scan-remeasure.yml', import.meta.url))
const LABELS = fileURLToPath(new URL('../../.github/labels.yml', import.meta.url))

/** The workflow text, comments stripped so a commented-out line cannot satisfy a pin. */
export function code(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1').trimEnd())
    .join('\n')
}

/** Every pin, as a predicate over the comment-stripped text; empty means the workflow passes. */
export function violations(text) {
  const src = code(text)
  const out = []
  if (!/fetch-depth:\s*0\b/.test(src)) out.push('checkout must use fetch-depth: 0 (block 5 counts merge commits in history)')
  if (!/apt-get install[^\n]*\bripgrep\b/.test(src)) out.push('an rg install step is missing (no other workflow installs rg)')
  if (!/^concurrency:\s*\n\s+group:\s*\S+/m.test(src)) out.push('a top-level concurrency group is missing (a dispatch would race the cron)')
  if (!/scan-remeasure\.mjs --sha "\$GITHUB_SHA"/.test(src)) out.push('the runner must take --sha "$GITHUB_SHA" (one resolved SHA, never origin/dev)')
  if (/origin\/dev/.test(src)) out.push('the workflow must not read origin/dev')
  if (!/--author 'app\/github-actions'/.test(src)) out.push("the upsert must select by --author 'app/github-actions'")
  if (!/TITLE='Quality-scan re-measurement \(weekly\)'/.test(src)) out.push('the standing issue title moved')
  if (!/--list-args '[^']*--label scan-remeasure[^']*'/.test(src)) out.push('--list-args must carry --label scan-remeasure (standing-issue-upsert.mjs:53-58)')
  if (!/^\s+--label scan-remeasure\b/m.test(src)) out.push('--label scan-remeasure must be passed for create (standing-issue-upsert.mjs:191-198)')
  if (/--label (code-quality|ci-health)\b/.test(src)) out.push('code-quality / ci-health queue work; the job queues none')
  // The `on:` block: indented lines and the blank lines a stripped comment leaves.
  const on = src.match(/^on:[ \t]*\n((?:(?:[ \t].*)?\n)*)/m)?.[1] ?? ''
  if (/^\s+pull_request(_target)?:/m.test(on)) out.push('no pull_request trigger: the job must never become a PR check')
  if (!/^\s+schedule:/m.test(on)) out.push('the schedule trigger is missing')
  if (!/^\s+workflow_dispatch:/m.test(on)) out.push('workflow_dispatch is missing')
  return out
}

test('the workflow passes every pin', () => {
  assert.deepEqual(violations(readFileSync(WORKFLOW, 'utf8')), [])
})

test('the scan-remeasure label is declared', () => {
  assert.match(readFileSync(LABELS, 'utf8'), /^- name: "scan-remeasure"$/m)
})

// Each pin, made to fail by the nearest wrong edit to the real file.
const MUTATIONS = [
  ['fetch-depth', (t) => t.replace(/fetch-depth: 0/, 'fetch-depth: 1')],
  ['ripgrep', (t) => t.replace(/sudo apt-get install -y -qq ripgrep/, 'echo skipped')],
  ['concurrency', (t) => t.replace(/^concurrency:\n {2}group: scan-remeasure\n/m, '')],
  ['GITHUB_SHA', (t) => t.replace('--sha "$GITHUB_SHA"', '--sha "$(git rev-parse origin/dev)"')],
  ['--author', (t) => t.replace("--author 'app/github-actions'", "--author 'someone'")],
  ['--list-args', (t) => t.replace("--list-args '--label scan-remeasure --state open --json'", "--list-args '--state open --json'")],
  ['--label', (t) => t.replace(/^(\s+)--label scan-remeasure \\$/m, '$1--label code-quality \\')],
  ['pull_request', (t) => t.replace(/^ {2}workflow_dispatch:$/m, '  workflow_dispatch:\n  pull_request:')],
  ['commented-out fetch-depth', (t) => t.replace(/fetch-depth: 0/, 'fetch-depth: 1 # fetch-depth: 0')],
]

for (const [name, mutate] of MUTATIONS) {
  test(`mutation: ${name} turns the pins red`, () => {
    const real = readFileSync(WORKFLOW, 'utf8')
    const mutated = mutate(real)
    assert.notEqual(mutated, real, `the ${name} mutation did not apply — the pin it tests is unproven`)
    assert.notDeepEqual(violations(mutated), [])
  })
}
