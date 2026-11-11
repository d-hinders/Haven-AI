// Pins `.github/workflows/docs-audit.yml` (#4631): the weekly audit now runs
// the quality-scan runner's doc-figure section first and hands the file to the
// audit. Each assertion names the failure it stops — a job that keeps running
// but answers a different question is the defect the section exists to catch.
//
// The pattern is `scan-remeasure-workflow.test.mjs`'s: every pin is a predicate
// over the comment-stripped text, and every pin is made to fail by the nearest
// wrong edit to the real file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/docs-audit.yml', import.meta.url))

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
  if (!/fetch-depth:\s*0\b/.test(src)) out.push('checkout must use fetch-depth: 0 (the audit counts commits since last-verified)')
  if (!/apt-get install[^\n]*\bripgrep\b/.test(src)) out.push('an rg install step is missing (a doc row may call $RG)')
  if (!/scan-remeasure\.mjs --sha "\$GITHUB_SHA" --doc-figures-only --out figures\.txt/.test(src)) {
    out.push('the runner must run --sha "$GITHUB_SHA" --doc-figures-only --out figures.txt (one SHA, the same as the ranking)')
  }
  if (!/audit-staleness\.mjs[^\n]*--figures-report figures\.txt/.test(src)) {
    out.push('the audit must be passed --figures-report figures.txt (without it the section is a placeholder)')
  }
  const runnerAt = src.indexOf('scan-remeasure.mjs')
  const auditAt = src.indexOf('audit-staleness.mjs')
  if (runnerAt === -1 || auditAt === -1 || runnerAt > auditAt) {
    out.push('the doc-figure runner must run before the audit (the audit reads the file it writes)')
  }
  // The run steps carry no token: the audit does not read the runner's standing
  // issue, it runs the runner itself. Only the upsert step holds GH_TOKEN.
  if ((src.match(/GH_TOKEN/g) ?? []).length !== 1) out.push('GH_TOKEN belongs on the upsert step only')
  if (/origin\/dev/.test(src)) out.push('the workflow must not read origin/dev')
  if (!/--author 'app\/github-actions'/.test(src)) out.push("the upsert must select by --author 'app/github-actions'")
  if (!/TITLE='Docs staleness audit \(weekly\)'/.test(src)) out.push('the tracking issue title moved')
  if (!/--list-args '[^']*--label documentation[^']*'/.test(src)) out.push('--list-args must carry --label documentation')
  if (!/dated reading/.test(src)) out.push('the issue template must say a moved figure is refreshed or rewritten as a dated reading')
  // The issue body is built by `printf` from a single-quoted format, so `\n` is
  // a newline and `\\n` is a literal backslash-n. Render the format the way the
  // step does and require real newlines and a real fence: with `\\n` the whole
  // report collapses onto one line outside the code block (#4631's regression).
  const bodyFormat = src.match(/BODY="\$\(printf '([^']*)'/)?.[1]
  if (!bodyFormat) {
    out.push('the issue body must be built by printf from a single-quoted format')
  } else {
    const rendered = execFileSync('bash', ['-c', 'printf "$1" "$2"', '_', bodyFormat, 'REPORT-LINE-1\nREPORT-LINE-2'], {
      encoding: 'utf8',
    })
    if (/\\\\n/.test(bodyFormat)) {
      out.push('the issue body format must use \\n, not \\\\n (a literal backslash-n collapses the body onto one line)')
    }
    if (!rendered.includes('```\nREPORT-LINE-1\nREPORT-LINE-2\n```')) {
      out.push('the report must sit inside a ``` fence in the issue body')
    }
  }
  // Report-only: the doc-figure step must not fail the job before the audit runs.
  const figureStep = src.slice(src.indexOf('      - name: Re-measure the doc figures'), src.indexOf('      - name: Run the audit'))
  if (!/continue-on-error:\s*true/.test(figureStep)) {
    out.push('the doc-figure step must be continue-on-error: true (the job is report-only)')
  }
  if (!/never \\?`last-verified\\?` alone/.test(src)) out.push('the issue template must say never `last-verified` alone')
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

// Each pin, made to fail by the nearest wrong edit to the real file.
const MUTATIONS = [
  ['fetch-depth', (t) => t.replace(/fetch-depth: 0/, 'fetch-depth: 1'), /fetch-depth: 0/],
  ['ripgrep', (t) => t.replace(/sudo apt-get install -y -qq ripgrep/, 'echo skipped'), /rg install step/],
  ['runner flags', (t) => t.replace('--doc-figures-only --out figures.txt', '--out figures.txt'), /--doc-figures-only/],
  ['figures-report', (t) => t.replace(' --figures-report figures.txt', ''), /--figures-report figures\.txt/],
  [
    'step order',
    (t) => {
      const runner = t.slice(t.indexOf('      - name: Re-measure the doc figures'), t.indexOf('      - name: Run the audit'))
      const audit = t.slice(t.indexOf('      - name: Run the audit'), t.indexOf('      - name: Upsert the tracking issue'))
      return t.replace(runner + audit, audit + runner)
    },
    /must run before the audit/,
  ],
  ['GH_TOKEN on a run step', (t) => t.replace('      - name: Re-measure the doc figures\n', '      - name: Re-measure the doc figures\n        env:\n          GH_TOKEN: ${{ github.token }}\n'), /GH_TOKEN belongs on the upsert step only/],
  ['origin/dev', (t) => t.replace('cat report.txt\n', 'cat report.txt\n          git log origin/dev -1\n'), /must not read origin\/dev/],
  ['--author', (t) => t.replace("--author 'app/github-actions'", "--author 'someone'"), /--author/],
  ['--list-args', (t) => t.replace("--list-args '--label documentation --state open --json'", "--list-args '--state open --json'"), /--list-args must carry/],
  ['dated reading', (t) => t.replace(/ or rewrite it as a dated reading/, ''), /dated reading/],
  ['last-verified alone', (t) => t.replace(/ — never \\`last-verified\\` alone/, ''), /last-verified/],
  ['body newlines', (t) => t.replace(/alone\.\\n\\n```\\n%s/, 'alone.\\\\n\\\\n```\\\\n%s'), /literal backslash-n/],
  ['body fence', (t) => t.replace('```\\n%s\\n```', '\\`\\`\\`\\n%s\\n\\`\\`\\`'), /``` fence/],
  ['continue-on-error', (t) => t.replace('        continue-on-error: true\n', ''), /continue-on-error/],
  ['pull_request', (t) => t.replace(/^ {2}workflow_dispatch:$/m, '  workflow_dispatch:\n  pull_request:'), /no pull_request trigger/],
  ['commented-out fetch-depth', (t) => t.replace(/fetch-depth: 0/, 'fetch-depth: 1 # fetch-depth: 0'), /fetch-depth: 0/],
]

for (const [name, mutate, expected] of MUTATIONS) {
  test(`mutation: ${name} trips its own pin`, () => {
    const real = readFileSync(WORKFLOW, 'utf8')
    const mutated = mutate(real)
    assert.notEqual(mutated, real, `the ${name} mutation did not apply — the pin it tests is unproven`)
    assert.match(violations(mutated).join('\n'), expected)
  })
}
