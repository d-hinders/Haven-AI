// `scripts/ci/promotion-digest-metrics.mjs` — the two #2767 figures the promotion
// digest prints. The classifier is pinned on real subjects from `dev`'s history so
// the rule cannot drift silently, and the rendered lines are asserted to carry the
// reproducing commands next to the numbers (ship-next § Acceptance Gate: numbers
// state their basis).
//
// Run with: node --test scripts/ci/promotion-digest-metrics.test.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  classifySubject,
  collect,
  filedPerClosed,
  productShare,
  renderDigestLines,
} from './promotion-digest-metrics.mjs'

const SCRIPT = fileURLToPath(new URL('./promotion-digest-metrics.mjs', import.meta.url))

describe('classifySubject', () => {
  const cases = [
    // product: a user, an agent or an operator sees the behaviour change
    ['feat(frontend): installed-app shell — web manifest, iOS metadata (Refs #2729) (#2765)', 'product'],
    ['fix(backend): refuse an over-budget EIP-3009 funding authorize with #2082\'s typed 403 (#2706) (#2719)', 'product'],
    ['fix(frontend,sdk): the manifest reports production instead of unknown (Closes #2709) (#2713)', 'product'],
    ['fix(db): schema-qualify the pg_constraint checks and repair what they skipped (#2702) (#2704)', 'product'],
    ['fix(2613): force the interleaving the positive control was racing for (#2655)', 'product'],
    ['refactor(x402): one settlement builder (#1)', 'product'],
    ['perf(backend): cache the chain config (#2)', 'product'],
    // tooling: the verification apparatus, docs, CI, guards, the QA harness
    ['fix(ci): refuse a malformed baseline at the read boundary (#2759) (#2760)', 'tooling'],
    ['docs-quality: convert exhaustive-set claims in the six worst docs into test assertions (#2680) (#2754)', 'tooling'],
    ['fix(docs): ui-gate-wording --update must refuse to raise (#2747) (#2757)', 'tooling'],
    ['fix(qa): the x402 3009 over-budget leg asserts the typed 403 (#2738) (#2753)', 'tooling'],
    ['test(backend): revert migrations inside a finally, all five sites (#2621) (#2683)', 'tooling'],
    ['docs: release closeout gains the stranded-`latest` runbook (Closes #2716) (#2717)', 'tooling'],
    ['ci: ratchet the retired-rail prose phrase family (#2685) (#2693)', 'tooling'],
    ['chore(deps): bump vitest (#3)', 'tooling'],
    ['feat(release): measure what a promotion publishes instead of counting it by hand — Closes #2724 (#2748)', 'tooling'],
    // unclassified: no conventional prefix — counted in the denominator, never as product
    ['Complete agent-discovery metadata (#2710) (#2755)', 'unclassified'],
    ['release: 0.1.36-alpha.0 (#2662)', 'tooling'],
    ['ship-next: a title saying "still" names a boundary, not an instance (#2517)', 'tooling'],
    // pre-#2632 two-parent landings: the type is the branch prefix
    ['Merge pull request #2589 from d-hinders/feat/2534-wallets-funding', 'product'],
    ['Merge pull request #2463 from d-hinders/ci/2421-dev-snapshot-publish', 'tooling'],
    ['Merge pull request #2559 from d-hinders/docs/2516-ship-next-string-surface', 'tooling'],
    ['Merge pull request #2646 from d-hinders/codex/sync-2634-main', 'unclassified'],
    ['fix: retire "import-only" and stale rail identifiers, Closes #2687 (#2691)', 'product'],
    ['', 'unclassified'],
  ]
  for (const [subject, expected] of cases) {
    test(`${expected.padEnd(12)} ← ${subject.slice(0, 60)}`, () => {
      assert.equal(classifySubject(subject), expected)
    })
  }

  test('a tooling scope wins over a product type (feat(ci) is tooling)', () => {
    assert.equal(classifySubject('feat(ci): new guard'), 'tooling')
    assert.equal(classifySubject('fix(scripts): guard self-test'), 'tooling')
  })
})

describe('productShare / filedPerClosed', () => {
  test('share counts all three buckets and uses the full denominator', () => {
    const s = productShare(['feat(x): a', 'fix(ci): b', 'Untyped', 'fix(y): c'])
    assert.deepEqual(s, { product: 2, tooling: 1, unclassified: 1, total: 4, pct: 50 })
  })
  test('empty window → pct null, never NaN', () => {
    assert.equal(productShare([]).pct, null)
  })
  test('ratio rounds to two places and refuses a zero denominator', () => {
    assert.equal(filedPerClosed(195, 172), 1.13)
    assert.equal(filedPerClosed(0, 10), 0)
    assert.equal(filedPerClosed(5, 0), null)
    assert.equal(filedPerClosed('5', 1), null)
  })
})

describe('renderDigestLines', () => {
  const lines = renderDigestLines({
    since: '2026-09-01T00:00:00.000Z',
    until: '2026-09-08T00:00:00.000Z',
    created: 195,
    closed: 172,
    subjects: ['feat(a): x (#1)', 'fix(ci): y (#2)', 'docs: z (#3)'],
  })
  test('prints both figures with their targets and points at #2767 for the baseline', () => {
    assert.match(lines, /Filing ratio \(2026-09-01 → 2026-09-08\):\*\* 1\.13 issues filed per issue closed \(195 filed \/ 172 closed; target < 0\.3/)
    assert.match(lines, /Product share of `origin\/dev` merges .*33\.3 % \(1 product \/ 2 tooling \/ 0 unclassified of 3; target > 60 %/)
    assert.doesNotMatch(lines, /baseline 2026-09-08 [=≈]/, 'no restated baseline figure — it lives in #2767')
  })
  test('each figure is followed by the command that reproduces it', () => {
    assert.match(lines, /gh issue list --state all --limit 1000 --json number --search created:2026-09-01\.\.2026-09-08 \| jq length; gh issue list --state all --limit 1000 --json number --search 'is:closed closed:2026-09-01\.\.2026-09-08' \| jq length/)
    assert.match(lines, /git log --first-parent --format=%s --since=2026-09-01T00:00:00\.000Z --until=2026-09-08T00:00:00\.000Z origin\/dev \| node scripts\/ci\/promotion-digest-metrics\.mjs --classify/)
  })
  test('a count at the listing limit is flagged as a floor, not printed as a ratio of 1.00', () => {
    const out = renderDigestLines({ since: '2026-09-01', until: '2026-09-08', created: 1000, closed: 1000, subjects: [] })
    assert.match(out, /1000 filed ⚠ hit the 1000-row listing limit/)
    assert.match(out, /1000 closed ⚠ hit the 1000-row listing limit/)
    const ok = renderDigestLines({ since: '2026-09-01', until: '2026-09-08', created: 999, closed: 10, subjects: [] })
    assert.doesNotMatch(ok, /listing limit/)
  })

  test('n/a when nothing closed or nothing merged, never ∞ or NaN', () => {
    const out = renderDigestLines({ since: '2026-09-01', until: '2026-09-08', created: 3, closed: 0, subjects: [] })
    assert.match(out, /\*\* n\/a issues filed per issue closed \(3 filed \/ 0 closed/)
    assert.match(out, /merges .*:\*\* n\/a \(0 product/)
    assert.doesNotMatch(out, /NaN|Infinity/)
  })
})

describe('collect (injected gh/git)', () => {
  test('asks gh for created and closed counts over the window and git for first-parent subjects', () => {
    const ghCalls = []
    const gitCalls = []
    const gh = (args) => {
      ghCalls.push(args)
      const search = args[args.indexOf('--search') + 1]
      return JSON.stringify(search.startsWith('created:') ? [1, 2, 3].map((n) => ({ number: n })) : [{ number: 9 }])
    }
    const git = (args) => {
      gitCalls.push(args)
      return 'feat(a): one (#1)\nfix(ci): two (#2)\n'
    }
    const out = collect({ gh, git, days: 7, until: '2026-09-08T00:00:00Z', ref: 'origin/dev' })
    assert.equal(out.created, 3)
    assert.equal(out.closed, 1)
    assert.deepEqual(out.subjects, ['feat(a): one (#1)', 'fix(ci): two (#2)'])
    assert.equal(out.since, '2026-09-01T00:00:00.000Z')
    assert.ok(ghCalls[0].includes('created:2026-09-01..2026-09-08'))
    assert.ok(ghCalls[1].includes('is:closed closed:2026-09-01..2026-09-08'))
    // The printed repro command is the executed call, argument for argument.
    const printed = renderDigestLines(out)
    for (const call of ghCalls) {
      const cmd = `gh ${call.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`
      assert.ok(printed.includes(cmd), `printed command lacks executed call: ${cmd}`)
    }
    assert.ok(gitCalls[0].includes('--first-parent'))
    assert.ok(gitCalls[0].includes('origin/dev'))
  })
})

describe('CLI', () => {
  test('--classify reads subjects on stdin and prints one bucket per line plus the share', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--classify'], {
      input: 'feat(a): one (#1)\nfix(ci): two (#2)\nUntyped (#3)\n',
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^product\s+feat\(a\): one/m)
    assert.match(r.stdout, /^tooling\s+fix\(ci\): two/m)
    assert.match(r.stdout, /^unclassified\s+Untyped/m)
    assert.match(r.stdout, /product 1 \/ tooling 1 \/ unclassified 1 of 3 = 33\.3 %$/m)
  })
  test('--days=0 refuses with exit 2', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--days=0'], { encoding: 'utf8' })
    assert.equal(r.status, 2)
  })
})
