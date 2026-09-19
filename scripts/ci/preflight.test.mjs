// Tests for the pre-push gate battery (#3150).
//
// The suite that matters is `every CI command is classified`. It is the whole
// anti-drift mechanism: a command appearing in a PR-triggered workflow that
// neither a rule nor the map accounts for fails this test, so a new CI step
// cannot join the build without someone deciding whether a builder can run it.
// #3135 added `check:route-modules` to Backend checks and no builder battery
// learned about it for a week — the fourth incident #3150 was filed for.
//
// Dependency-free, and collected by the `ci_config_checks` job's existing
// `node --test scripts/ci/*.test.mjs` glob, so the drift check runs on every
// pull request with no workflow change and no auth.
//
// Run with: node --test scripts/ci/preflight.test.mjs

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  isPullRequestTriggered,
  splitCommands,
  parseWorkflow,
  surfacesInCondition,
  collectCiCommands,
  classifyCommand,
  loadGateMap,
  buildPlan,
  selectGates,
  workflowFiles,
  unreadableRunKeys,
  suspiciousCommands,
  compositeActionGates,
  ACTIONS_DIR,
  parseWorkflowCommands,
  DB_SKIP_MARKER,
  GATE_RULES,
  GATE_SHAPED_ANYWHERE,
  literalHead,
} from './preflight.mjs'
import { classifyChangedFiles } from './change-classifier.mjs'

const map = loadGateMap()

describe('the drift check', () => {
  test('every command in every PR-triggered workflow is classified', () => {
    const commands = [...new Set(collectCiCommands().map((c) => c.command))]
    const unclassified = commands.filter((c) => classifyCommand(c, map) === 'unclassified')
    assert.deepEqual(
      unclassified,
      [],
      'A CI step runs a command this battery does not know about. Decide which it is:\n' +
        '  - a gate a builder can run  → add a rule to GATE_RULES in preflight.mjs\n' +
        '  - not a gate                → add it to notGates in preflight-gates.json WITH ITS REASON\n' +
        'Unclassified:\n' +
        unclassified.map((c) => `  ${JSON.stringify(c)}`).join('\n'),
    )
  })

  test('no notGates entry is stale', () => {
    // The other direction, so this file cannot accumulate dead rows the way a
    // hand-maintained gate list does. Without it, a `notGates` reason outlives
    // the step it excuses and the next reader trusts it.
    const live = new Set(collectCiCommands().map((c) => c.command))
    const stale = Object.keys(map.notGates).filter((c) => !live.has(c))
    assert.deepEqual(stale, [], `notGates entries no workflow runs any more:\n${stale.join('\n')}`)
  })

  test('every notGates entry carries a reason of substance', () => {
    for (const [command, reason] of Object.entries(map.notGates)) {
      assert.equal(typeof reason, 'string', `${command}: reason must be a string`)
      assert.ok(
        reason.trim().length >= 40,
        `${command}: needs a real reason, not "${reason}" — this list is the one place a ` +
          'builder learns why a CI command is not theirs to run',
      )
    }
  })

  test('a gate-shaped command with shell syntax is unclassified, never dropped', () => {
    // The one silent path through the classifier is NOT_GATE_RULES, and a gate
    // whose argument carries an interpolation takes it:
    //   npm run lint:envish -- --base=$GITHUB_BASE_REF
    // `$` put it in NOT_GATE_RULES, so the gate landed in CI and in nobody's
    // battery with NO test failure — this file's own defect, through its own
    // escape hatch. A gate-shaped head now wins over the shell-syntax rule.
    for (const cmd of [
      'npm run lint:envish -- --base=$GITHUB_BASE_REF',
      'npm run check:thing -- --sha=${{ github.event.pull_request.head.sha }}',
      'npm run test -w packages/backend -- --shard=$SHARD',
      'node --test scripts/$WHICH.test.mjs',
      // An ENV PREFIX is not an exemption either: this matched the
      // `/^[A-Z_]+=/` not-a-gate rule and took the silent path, because the
      // gate-shaped heads were anchored and could not see past the assignment.
      'HAVEN_SKIP_DB_TESTS=1 npm run test -w packages/backend -- --x=$Y',
      'HAVEN_X=1 npm run lint:thing',
      'HAVEN_X=1 node --test scripts/x.test.mjs',
      // The four gates that had no counterpart in the old second shape list,
      // and so were silenced on the PREFIX axis while the suffix axis read
      // closed. The strict contract-doc gate is the first of them.
      'BASE_SHA=abc node scripts/docs/coupling-gate.mjs --strict --out=/dev/null',
      'echo run && node packages/frontend/scripts/design-system-coupling.mjs --strict --out=/dev/null',
      'set -e; node scripts/frontend-copy-lint.mjs',
      'for f in a; do node scripts/workspace-pin-lint.mjs; done',
      // A gate that is not the HEAD of its line. Review found a new separator
      // each round — an env prefix, then `&&`/`;`, then `||` and a pipe — so
      // the test is no longer positional: a gate-shaped command ANYWHERE means
      // a human looks. These are the enumerated class, not four more instances.
      'echo "Linting" && npm run lint:next-steps',
      'set -euo pipefail; npm run check:route-modules',
      'export CI=1 && npm run lint:b',
      'for f in a b; do npm run lint:c; done',
      'command -v foo || npm run lint:b',
      'foo || npm run test -w packages/backend',
      // The one a separator split could never reach: a wrapper, no separator.
      'git diff --name-only | xargs npm run lint:x',
      'bash -c "npm run lint:x"',
    ]) {
      assert.equal(classifyCommand(cmd, map), 'unclassified', `silently dropped: ${cmd}`)
    }
  })

  test('a genuinely non-gate shell line is still not-a-gate', () => {
    // The other side of the same rule: making gate-shaped heads win must not
    // drag ordinary shell plumbing into `unclassified`, or the drift check
    // reddens on every `if`/`echo` in the build and gets switched off.
    for (const cmd of [
      'if [ "${{ needs.changes.outputs.backend }}" = "true" ]; then',
      'echo "Backend checks result: ${{ needs.backend_checks.result }}"',
      'gh issue create --title "$TITLE" --label ci-health',
      'RUN_URL="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"',
    ]) {
      assert.equal(classifyCommand(cmd, map), 'not-a-gate', `wrongly flagged: ${cmd}`)
    }
  })

  test('no gate goes silent when given an interpolated argument', () => {
    // THE closure test for the escape class, and general rather than positional.
    //
    // The version this replaces asserted that every corpus command matching a
    // gate shape "anywhere" while classifying not-a-gate was in the map. That
    // was vacuous BY CONSTRUCTION, not merely against the corpus: the
    // gate-shaped-anywhere branch runs BEFORE the not-a-gate rules, so such a
    // command can only be not-a-gate via the map, and the filter could never
    // find anything. Deleting the rule it policed left it green.
    //
    // This one perturbs each real gate the way CI would — one interpolated
    // argument — and requires it not to vanish. Against the head list alone it
    // reported four, including the strict coupling gate that two of the four
    // incidents were about.
    const plan = buildPlan()
    assert.ok(plan.length > 0, 'no plan to perturb')
    // BOTH axes. The suffix axis alone read closed for a whole round while the
    // prefix axis silenced four gates — including the strict contract-doc gate
    // — because the shield did not mirror every rule. One axis reading closed
    // proves nothing about the other, so the perturbations go both ways.
    const perturbations = [
      ['suffix arg', (c) => `${c} -- --base=$GITHUB_BASE_REF`],
      ['suffix pipe', (c) => `${c} | tee out.log`],
      ['prefix env', (c) => `BASE_SHA=abc ${c}`],
      ['prefix echo', (c) => `echo run && ${c}`],
      ['prefix set', (c) => `set -e; ${c}`],
      ['prefix export', (c) => `export CI=1 && ${c}`],
      ['loop body', (c) => `for f in a; do ${c}; done`],
    ]
    const silenced = []
    for (const [name, perturb] of perturbations) {
      for (const g of plan) {
        if (classifyCommand(perturb(g.command), map) === 'not-a-gate') {
          silenced.push(`${name}: ${g.command}`)
        }
      }
    }
    assert.deepEqual(
      silenced,
      [],
      'these gates go silent when perturbed:\n' + silenced.map((c) => `  ${c}`).join('\n'),
    )
  })

  test('a metacharacter alone never silences a command', () => {
    // The rule change that closed the class. `/[|><`$()]/` used to be a
    // not-a-gate rule, and it was the silent path every escape took. Nothing
    // shell-ish silences a command now; only a keyword head, `gh`, or an
    // argued map row does.
    for (const cmd of [
      'node scripts/docs/coupling-gate.mjs --strict --base=$B',
      'node packages/frontend/scripts/design-system-coupling.mjs --strict --base=$B',
      'node scripts/frontend-copy-lint.mjs --changed=$(git diff --name-only)',
      'npm run qa:check -- --base=$X',
      'some-new-tool --flag=$Y',
    ]) {
      assert.notEqual(classifyCommand(cmd, map), 'not-a-gate', `silenced: ${cmd}`)
    }
  })

  test('every GATE_RULES entry is covered by the shield', () => {
    // THE COUPLING, machine-checked. GATE_RULES and GATE_SHAPED_ANYWHERE are
    // two lists on purpose — precise vs generous, see the shield's docstring —
    // and two lists drift. They already did: four gates had no shield, so
    // `BASE_SHA=abc node scripts/docs/coupling-gate.mjs --strict` was silenced.
    //
    // Deriving one from the other fixed the drift and created a narrowing
    // instead (`node --test $FILE` stopped being shielded, because that rule
    // excludes `$` so the battery never RUNS an unexpanded variable). So the
    // lists stay separate and this test holds them together: a rule whose
    // literal head no shield matches fails the build.
    const uncovered = GATE_RULES.filter((r) => {
      const head = literalHead(r.source)
      return !GATE_SHAPED_ANYWHERE.some((shield) => shield.test(head))
    }).map((r) => r.source)
    assert.deepEqual(
      uncovered,
      [],
      'these gate rules have no shield — their prefix-wrapped form would be\n' +
        'silently dropped. Add a shape to GATE_SHAPED_ANYWHERE:\n' +
        uncovered.map((r) => `  ${r}`).join('\n'),
    )
  })

  test('literalHead stops at the first metacharacter, resolving escapes', () => {
    assert.equal(literalHead('^npm run lint:[a-z:-]+$'), 'npm run lint:')
    assert.equal(literalHead('^node --test [^|><&;$`]+$'), 'node --test ')
    assert.equal(literalHead('^node scripts\\/docs\\/[a-z-]+\\.mjs$'), 'node scripts/docs/')
    assert.equal(literalHead('^npm run visual:baselines(:test)?$'), 'npm run visual:baselines')
  })

  test('every GATE_RULES entry carries exactly one leading anchor', () => {
    // The load-bearing consequence, measured rather than reasoned: an
    // UNANCHORED rule lets `classifyCommand` match somewhere INSIDE a compound
    // line, and `runGate` then hands that whole line to
    // `spawnSync(..., { shell: true })` as "a gate". That is the hole, and it
    // is silent.
    //
    // The two OTHER shapes this rejects fail loudly, so they are hygiene and
    // not a second hole — stated here because getting them wrong was itself a
    // review finding. A doubled `^^` makes `literalHead` return `''` (it breaks
    // on the first metacharacter), and no GATE_SHAPED_ANYWHERE entry matches
    // `''`, so the shield-coverage test goes RED. Top-level alternation
    // makes `literalHead` stop at the `|`, so only branch one is ever checked:
    // `literalHead('^npm run lint:a$|^npm run whatever')` is `'npm run lint:a'`,
    // which IS shielded, and the coverage check vouches for the rule while
    // branch two goes unshielded. (A toy `/^npm run a|^npm run b/` would go red
    // instead, because nothing shields `'npm run a'` — which is why the example
    // has to be a realistic rule to demonstrate the failure at all.)
    // Enforced, not implied.
    // Count anchors OUTSIDE character classes. `/^node --test [^|><&;$`]+$/`
    // carries a `^` (negation) and a `$` (literal) inside its class, and a
    // naive count reads four anchors where there are two — which is how this
    // test first went red against a rule that is perfectly well-formed.
    const outsideClasses = (source) => source.replace(/\[(?:\\.|[^\]\\])*\]/g, '[]')
    for (const r of GATE_RULES) {
      const bare = outsideClasses(r.source)
      assert.ok(bare.startsWith('^'), `not anchored: ${r.source}`)
      assert.equal(
        (bare.match(/(?<!\\)\^/g) ?? []).length,
        1,
        `more than one unescaped ^ outside a class: ${r.source}`,
      )
      // A trailing `$` is fine — the derivation strips it too — but only one,
      // and only at the end, or unanchoring changes what the rule means.
      const dollars = bare.match(/(?<!\\)\$/g) ?? []
      assert.ok(dollars.length <= 1, `more than one $ outside a class: ${r.source}`)
      if (dollars.length === 1) assert.ok(bare.endsWith('$'), `$ is not trailing: ${r.source}`)
    }
  })

  test("each row's (redundant) marker matches what the rules actually do", () => {
    // The markers say which rows are load-bearing. Written by hand they went
    // stale within one round: three rows qualified when they were written, and
    // the fix for the gate-shaped-head escape promoted one to load-bearing
    // without the comment noticing. A reader deleting a row on a stale marker
    // reddens the drift check.
    //
    // So the split is re-derived here rather than trusted: classify each row
    // against an EMPTY map and see whether the rules alone still answer.
    const empty = { notGates: {} }
    const mismatched = []
    for (const [command, reason] of Object.entries(map.notGates)) {
      const marked = reason.startsWith('(redundant)')
      const rulesAlone = classifyCommand(command, empty) === 'not-a-gate'
      if (marked !== rulesAlone) {
        mismatched.push({ command, marked, rulesAlone })
      }
    }
    assert.deepEqual(
      mismatched,
      [],
      'a (redundant) marker disagrees with the rules:\n' +
        mismatched
          .map((m) => `  ${JSON.stringify(m.command)} marked=${m.marked} rulesAlone=${m.rulesAlone}`)
          .join('\n'),
    )
  })

  test('the classifier is total — every command is exactly one of the three', () => {
    // Guards the enum itself: a fourth return value would silently drop
    // commands out of both the battery and the drift check.
    //
    // Weak against the CURRENT corpus by construction — every real command
    // classifies as gate or not-a-gate today, so replacing the final
    // `return 'unclassified'` with anything else leaves this green. It bites
    // once an unclassifiable command exists, which is the state it guards.
    for (const c of new Set(collectCiCommands().map((x) => x.command))) {
      assert.ok(
        ['gate', 'not-a-gate', 'unclassified'].includes(classifyCommand(c, map)),
        `classifyCommand returned something else for ${JSON.stringify(c)}`,
      )
    }
  })
})

describe('the four incidents #3150 was filed for', () => {
  // Acceptance criterion 1, as an executable claim rather than a promise: the
  // #3126 r2 branch shape selects every gate that reddened its first CI run.
  const plan = buildPlan()
  const surfacesFor = (files) =>
    Object.entries(classifyChangedFiles(files))
      .filter(([, v]) => v === true)
      .map(([k]) => k)

  test('a backend-route + mcp-server diff selects all three #3126 r2 gates', () => {
    const selected = selectGates(
      plan,
      surfacesFor([
        'packages/backend/src/routes/machine-payments.ts',
        'packages/mcp-server/src/state-direct-recovery.ts',
      ]),
    ).map((g) => g.command)
    for (const gate of [
      'npm run lint:next-steps',
      'npm run check:route-modules',
      'npm run typecheck -w packages/mcp-server',
    ]) {
      assert.ok(selected.includes(gate), `#3126 r2 gate not selected: ${gate}`)
    }
  })

  test('a backend-route diff selects the #3054 gate', () => {
    const selected = selectGates(
      plan,
      surfacesFor(['packages/backend/src/routes/machine-payments.ts']),
    ).map((g) => g.command)
    assert.ok(selected.includes('npm run lint:request-schemas'))
  })

  test('the strict coupling gate (#3126 r1, #2732) is always selected', () => {
    // It lives in docs-coupling.yml, not ci.yml, and is ungated — so it is in
    // EVERY battery. A gate inventory built from ci.yml alone misses it, which
    // is how an exploration pass of this very issue concluded it "never runs in
    // CI at all".
    const gate = plan.find((g) => g.command === 'node scripts/docs/coupling-gate.mjs --strict --out=/dev/null')
    assert.ok(gate, 'the strict coupling gate is not in the plan')
    assert.equal(gate.alwaysRuns, true)
    assert.deepEqual(gate.jobs, ['Contract-doc coupling'])
  })

  test('a docs-only diff still selects the ungated gates and no package gate', () => {
    const selected = selectGates(plan, surfacesFor(['docs/product/some-page.md'])).map((g) => g.command)
    assert.ok(selected.includes('npm run docs:check'))
    assert.ok(!selected.some((c) => /-w packages\//.test(c)), 'a docs-only diff pulled in a package gate')
  })
})

describe('the plan', () => {
  test('names every CI job that runs a gate, not just the first', () => {
    // `lint:next-steps` is run by four jobs. A builder needs to run it once,
    // but a failure reddens four contexts and the plan has to say so.
    //
    // The exact list is pinned on purpose, characterization-fixture style (the
    // `routing-matrix.mjs` precedent): a fifth job adopting this gate reddens
    // here, and that is the point — it is a routing change and should be argued
    // for, not absorbed. The pin is one line to update and it makes the change
    // visible, which a `.includes()` assertion would not.
    const gate = buildPlan().find((g) => g.command === 'npm run lint:next-steps')
    assert.ok(gate)
    assert.deepEqual(gate.jobs.sort(), [
      'Backend checks',
      'MCP checks',
      'MCP server checks',
      'Signer checks',
    ])
  })

  test('unions the surfaces of every job that runs a gate', () => {
    // sdk builds in SDK checks, QA agent checks and Install-path smoke, whose
    // gates are sdk, qa_agent and connect. Taking only the first job's surface
    // would drop the gate from a connect-only diff.
    const gate = buildPlan().find((g) => g.command === 'npm run build -w packages/sdk')
    assert.ok(gate)
    for (const s of ['sdk', 'qa_agent', 'connect']) assert.ok(gate.surfaces.includes(s), `missing ${s}`)
  })

  test('every gate is reachable from some diff', () => {
    // A gate with no surfaces and alwaysRuns=false can never be selected — it
    // would sit in the plan looking covered while running for nobody.
    const orphans = buildPlan().filter((g) => !g.alwaysRuns && g.surfaces.length === 0)
    assert.deepEqual(orphans.map((g) => g.command), [])
  })
})

describe('isPullRequestTriggered', () => {
  test('reads the on: block, not the whole file', () => {
    // The real cases, measured at ce79bf0c, are claim-assignee.yml,
    // morning-report-note.yml and update-visual-baselines.yml: each contains
    // the string `pull_request` outside its `on:` block, and none runs on one.
    // A whole-file grep pulls all three into every builder's battery.
    // (db-concurrency-proof.yml is NOT such a case — it really is PR-triggered,
    // path-filtered. An earlier revision of this comment claimed otherwise.)
    assert.equal(isPullRequestTriggered('on:\n  schedule:\n    - cron: "0 3 * * *"\njobs:\n  a:\n    if: github.event_name == \'pull_request\'\n'), false)
    assert.equal(isPullRequestTriggered('on:\n  pull_request:\n    branches: [dev]\n'), true)
    assert.equal(isPullRequestTriggered('on: [push, pull_request]\n'), true)
    assert.equal(isPullRequestTriggered('on: push\n'), false)
    assert.equal(isPullRequestTriggered('on:\n  pull_request_target:\n'), true)
    assert.equal(isPullRequestTriggered('jobs:\n  a:\n    runs-on: x\n'), false)
  })

  test('reads a quoted on: key and any indentation under it', () => {
    // YAML 1.1 reads a bare `on` as the boolean true, so `"on":` and `'on':`
    // are both common and both valid; a four-space block is as valid as a
    // two-space one. Missing either dropped the whole workflow from the battery
    // AND from both silent-drop guards, which `continue` on a non-PR file —
    // the one shape no guard in this file can see.
    assert.equal(isPullRequestTriggered('"on":\n  pull_request:\njobs:\n'), true)
    assert.equal(isPullRequestTriggered("'on':\n  pull_request:\njobs:\n"), true)
    assert.equal(isPullRequestTriggered('on:\n    pull_request:\njobs:\n'), true)
    assert.equal(isPullRequestTriggered('"on": [push, pull_request]\n'), true)
    // And still not fooled by the shapes that only mention it.
    assert.equal(isPullRequestTriggered('"on":\n  schedule:\n    - cron: x\njobs:\n  a:\n    if: github.event_name == \'pull_request\'\n'), false)
  })

  test('the set of workflows a whole-file grep would misclassify is exactly three', () => {
    // The docstring gives this as a re-derivation one-liner and nothing ran it.
    // Pinned here: it catches both the quoted-key and the indentation shapes
    // the day one appears, because either would move a file into this set.
    const mismatched = workflowFiles()
      .filter((f) => {
        const y = readFileSync(f, 'utf8')
        return isPullRequestTriggered(y) !== /pull_request/.test(y)
      })
      .map((f) => path.basename(f))
      .sort()
    assert.deepEqual(mismatched, [
      'claim-assignee.yml',
      'morning-report-note.yml',
      'update-visual-baselines.yml',
    ])
  })

  test('a workflow whose on: block ends before pull_request is not triggered', () => {
    // The `break` on a column-0 line is what stops the scan leaving the block.
    const yaml = 'on:\n  push:\n    branches: [main]\n\njobs:\n  pull_request:\n    runs-on: x\n'
    assert.equal(isPullRequestTriggered(yaml), false)
  })
})

describe('splitCommands', () => {
  test('splits && and ; chains', () => {
    assert.deepEqual(splitCommands('npm run a && npm run b'), ['npm run a', 'npm run b'])
    assert.deepEqual(splitCommands('npm run a; npm run b'), ['npm run a', 'npm run b'])
  })

  test('one command per line of a block', () => {
    assert.deepEqual(splitCommands('npm run a\nnpm run b\n'), ['npm run a', 'npm run b'])
  })

  test('joins a backslash continuation', () => {
    // Whitespace is preserved verbatim rather than collapsed: the joined string
    // is the map key a `notGates` entry has to match exactly, so normalising it
    // here would make the map's keys unwritable by reading the workflow.
    assert.deepEqual(splitCommands('npm run a \\\n  --flag'), ['npm run a    --flag'])
  })

  test('returns a line with shell syntax WHOLE, never split', () => {
    // Splitting `if [ "$x" = "y" ]; then` on `;` invents a command `then`.
    const line = 'if [ "${{ needs.changes.outputs.backend }}" = "true" ]; then'
    assert.deepEqual(splitCommands(line), [line])
  })

  test('keeps a multi-line quoted block in one piece', () => {
    // db-concurrency-proof.yml's `node -e "` … `"`. Split per line it yields a
    // bare `node -e "` and a bare `"`, each of which reads as its own command
    // and lands in the drift check as an unclassifiable mystery.
    const body = 'node -e "\n  const pg = require(\'pg\');\n"'
    const out = splitCommands(body)
    assert.equal(out.length, 1)
    assert.ok(out[0].startsWith('node -e "'))
  })

  test('drops comments and blank lines', () => {
    assert.deepEqual(splitCommands('# a comment\n\nnpm run a\n'), ['npm run a'])
  })
})

describe('surfacesInCondition', () => {
  test('extracts every changes output an if: depends on', () => {
    assert.deepEqual(surfacesInCondition("needs.changes.outputs.backend == 'true'"), ['backend'])
    assert.deepEqual(
      surfacesInCondition("always() && needs.changes.outputs.frontend == 'true' && needs.frontend_checks.result == 'success'"),
      ['frontend'],
    )
  })

  test('an if: naming no surface does not narrow the gate', () => {
    // null means "runs on every PR". Returning [] instead would make the job's
    // gates unreachable from any diff — the orphan case the plan test pins.
    assert.equal(surfacesInCondition("github.repository == 'd-hinders/Haven-AI'"), null)
    assert.equal(surfacesInCondition('always()'), null)
  })
})

describe('parseWorkflow', () => {
  test('reads both run: shapes and attributes them to the job', () => {
    const yaml = [
      'jobs:',
      '  build_it:',
      '    name: Build it',
      "    if: needs.changes.outputs.sdk == 'true'",
      '    steps:',
      '      - name: One',
      '        run: npm run lint:one',
      '      - name: Many',
      '        run: |',
      '          npm run lint:two',
      '          npm run lint:three',
      '      - name: After',
      '        run: npm run lint:four',
    ].join('\n')
    const found = parseWorkflow('fixture.yml', yaml).commands
    assert.deepEqual(
      found.map((f) => f.command),
      ['npm run lint:one', 'npm run lint:two', 'npm run lint:three', 'npm run lint:four'],
    )
    for (const f of found) {
      assert.equal(f.jobDisplay, 'Build it')
      assert.deepEqual(f.surfaceGate, ['sdk'])
    }
  })

  test('a block ends at the first line dedented out of it', () => {
    // Without the indentation test the block swallows the next step's `name:`
    // and every later command is attributed to the wrong job.
    const yaml = [
      'jobs:',
      '  a:',
      '    name: A',
      '    steps:',
      '      - name: Block',
      '        run: |',
      '          npm run lint:inside',
      '      - name: Outside',
      '        run: npm run lint:outside',
      '  b:',
      '    name: B',
      '    steps:',
      '      - run: npm run lint:other-job',
    ].join('\n')
    const found = parseWorkflow('fixture.yml', yaml).commands
    assert.deepEqual(
      found.map((f) => [f.jobDisplay, f.command]),
      [
        ['A', 'npm run lint:inside'],
        ['A', 'npm run lint:outside'],
        ['B', 'npm run lint:other-job'],
      ],
    )
  })

  test('reads a run: whose command is on the next line', () => {
    // A plain multi-line scalar. Valid YAML, and the first version of this
    // parser read it as empty — dropping whatever gate it held with nothing to
    // say so, which is the silent drop the whole file exists to prevent. Found
    // by `unreadableRunKeys`, not by review.
    const yaml = [
      'jobs:',
      '  a:',
      '    name: A',
      '    steps:',
      '      - name: Next-line',
      '        run:',
      '          npm run lint:next-line',
      '      - name: After',
      '        run: npm run lint:after',
    ].join('\n')
    assert.deepEqual(
      parseWorkflow('fixture.yml', yaml).commands.map((f) => f.command),
      ['npm run lint:next-line', 'npm run lint:after'],
    )
  })

  test('a new job resets the display name and the surface gate', () => {
    // Carrying them over attributes an ungated job's gates to the previous
    // job's surface, and they vanish from every other diff's battery.
    const yaml = [
      'jobs:',
      '  gated:',
      '    name: Gated',
      "    if: needs.changes.outputs.backend == 'true'",
      '    steps:',
      '      - run: npm run lint:gated',
      '  ungated:',
      '    name: Ungated',
      '    steps:',
      '      - run: npm run lint:ungated',
    ].join('\n')
    const found = parseWorkflow('fixture.yml', yaml).commands
    const ungated = found.find((f) => f.command === 'npm run lint:ungated')
    assert.equal(ungated.jobDisplay, 'Ungated')
    assert.equal(ungated.surfaceGate, null)
  })
})

describe('the workflow directory is read whole', () => {
  test('every PR-triggered workflow contributes commands', () => {
    // The failure this pins is reading ci.yml alone. FIVE of the eight
    // PR-triggered workflows own gates, and the strict coupling gate — the one
    // two of the four incidents were about — is in none of ci.yml.
    const byFile = new Map()
    for (const c of collectCiCommands()) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1)
    for (const f of ['ci.yml', 'docs-coupling.yml', 'docs.yml', 'frontend-copy-lint.yml', 'design-system-coupling.yml']) {
      assert.ok((byFile.get(f) ?? 0) > 0, `no commands collected from ${f}`)
    }
  })

  test('PREFLIGHT_WORKFLOW_DIR really redirects the module, in a child process', () => {
    // WORKFLOW_DIR is resolved at MODULE LOAD, so setting the variable inside a
    // test body is too late and proves nothing — an earlier version of this test
    // called `workflowFiles(dir)` with an explicit argument, which exercises a
    // parameter default and leaves the override untested. Deleting the override
    // outright kept that version green.
    //
    // A child process is the only honest way to drive it: the env var has to be
    // set before the import.
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-'))
    try {
      writeFileSync(
        path.join(dir, 'x.yml'),
        'on:\n  pull_request:\njobs:\n  j:\n    name: J\n    steps:\n      - run: npm run lint:fixture-only\n',
      )
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {buildPlan} from './scripts/ci/preflight.mjs';" +
            'process.stdout.write(JSON.stringify(buildPlan().map((g) => g.command)))',
        ],
        {
          cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
          env: { ...process.env, PREFLIGHT_WORKFLOW_DIR: dir },
          encoding: 'utf8',
        },
      )
      assert.equal(child.status, 0, child.stderr)
      assert.deepEqual(JSON.parse(child.stdout), ['npm run lint:fixture-only'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('PREFLIGHT_GATE_MAP really redirects the map, in a child process', () => {
    // Same shape, same reason: GATE_MAP_PATH is resolved at module load, and
    // every other call site passes no argument, so nothing exercised it.
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-map-'))
    try {
      const mapPath = path.join(dir, 'gates.json')
      writeFileSync(
        mapPath,
        JSON.stringify({ $comment: [], notGates: { 'npm run lint:deps': 'x'.repeat(50) } }),
      )
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import {loadGateMap} from './scripts/ci/preflight.mjs';" +
            'process.stdout.write(JSON.stringify(Object.keys(loadGateMap().notGates)))',
        ],
        {
          cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
          env: { ...process.env, PREFLIGHT_GATE_MAP: mapPath },
          encoding: 'utf8',
        },
      )
      assert.equal(child.status, 0, child.stderr)
      assert.deepEqual(JSON.parse(child.stdout), ['npm run lint:deps'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('unreadableRunKeys REPORTS a key the parser cannot read', () => {
    // The positive direction. Asserting only `[]` against a clean corpus proves
    // the corpus is clean, not that the guard can see anything — neutering this
    // function to `return []` kept the whole suite green, which is the fourth
    // round running that one of my own guards read correct and proved nothing.
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-unreadable-'))
    try {
      writeFileSync(
        path.join(dir, 'a.yml'),
        [
          'on:',
          '  pull_request:',
          'jobs:',
          '  j:',
          '    name: J',
          '    steps:',
          '      - name: under-indented body',
          '        run: |',
          '         npm run lint:hidden',
          '',
        ].join('\n'),
      )
      const rows = unreadableRunKeys(dir)
      assert.equal(rows.length, 1, JSON.stringify(rows))
      assert.equal(rows[0].file, 'a.yml')
      assert.equal(rows[0].text, 'run: |')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('suspiciousCommands REPORTS a YAML artifact', () => {
    // Same, for the guard with teeth. `return []` kept this green too.
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-suspicious-'))
    try {
      writeFileSync(
        path.join(dir, 'a.yml'),
        [
          'on:',
          '  pull_request:',
          'jobs:',
          '  j:',
          '    name: J',
          '    steps:',
          '      - name: anchored',
          '        run: &g npm run lint:anchored',
          '',
        ].join('\n'),
      )
      const rows = suspiciousCommands(dir)
      assert.equal(rows.length, 1, JSON.stringify(rows))
      assert.match(rows[0].command, /^&g/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Discovered the way the guard discovers: RECURSIVELY, and accepting
  // `action.yaml`. A first-level walk hardcoding `action.yml` would die with an
  // unrelated ENOENT the first time someone nests an action — the very layout
  // the guard was just taught to handle. Hoisted out of the floor test below so
  // the nested fixture can prove it, which the (flat) real tree cannot.
  const actionFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? actionFiles(path.join(dir, e.name))
        : e.name === 'action.yml' || e.name === 'action.yaml'
          ? [path.join(dir, e.name)]
          : [],
    )

  test('no gate hides in a local composite action', () => {
    // The battery reads .github/workflows only. A gate factored into an action
    // file is invisible to it and to the drift check — the last silent path,
    // and a file-discovery one rather than a parsing one.
    //
    // Green at rest, so this alone would survive `return []` and would also
    // survive `.github/actions` being renamed out from under the constant.
    // Pinned below: the directory really exists and really parses. Today it
    // holds one action producing one command, so the floor is a real assertion
    // and not a tautology.
    const found = actionFiles(ACTIONS_DIR)
    assert.ok(found.length > 0, `${ACTIONS_DIR} holds no composite actions — did the path drift?`)
    const parsed = found.flatMap((f) => parseWorkflowCommands(f, readFileSync(f, 'utf8')))
    assert.ok(parsed.length > 0, 'the guard parsed nothing: green would mean nothing')

    assert.deepEqual(compositeActionGates(), [], 'move it into a workflow, or the battery will never run it')
  })

  test('compositeActionGates REPORTS a gate planted in an action file', () => {
    // The assertion above is green at rest, so `return []` would satisfy it
    // forever. This drives it in the failing direction — and nests the action
    // one level down, which GitHub resolves as
    // `uses: ./.github/actions/gates/strict` and a one-level walk misses.
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-actions-'))
    try {
      mkdirSync(path.join(dir, 'gates', 'strict'), { recursive: true })
      writeFileSync(
        path.join(dir, 'gates', 'strict', 'action.yml'),
        [
          'name: planted',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - name: strict coupling',
          '      shell: bash',
          '      run: node scripts/docs/coupling-gate.mjs --strict --out=/dev/null',
          '',
        ].join('\n'),
      )
      const rows = compositeActionGates(dir)
      assert.equal(rows.length, 1, JSON.stringify(rows))
      assert.match(rows[0].command, /coupling-gate\.mjs --strict/)
      assert.equal(rows[0].file, 'gates/strict/action.yml')
      // And the floor test's discovery survives this layout too. A flat walk
      // throws ENOENT on `<dir>/gates/action.yml` instead of finding anything.
      assert.deepEqual(actionFiles(dir), [path.join(dir, 'gates', 'strict', 'action.yml')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a TEMPLATED command in an action file is a KNOWN hole, not a pass', () => {
    // Pins the limitation `preflight.mjs`'s docstring and `preflight-gates.json`
    // both write down, so the prose cannot drift from the behaviour.
    //
    // The cause is HEAD-templating, not `$` anywhere: every rule and shield
    // entry starts with a literal head, and `node "${{ inputs.script }}"` — how
    // `advisory-gate-comment` is built — is not one. A templated ARGUMENT is
    // caught normally; the sibling assertion below pins that, so the two
    // together say which half of the shape is the hole. The real tree being
    // green above therefore says only that no LITERAL gate is written into an
    // action.
    //
    // If this test ever goes red the hole closed: delete it and the paragraphs
    // in those two files.
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-templated-'))
    try {
      mkdirSync(path.join(dir, 'templated'))
      writeFileSync(
        path.join(dir, 'templated', 'action.yaml'),
        [
          'name: templated',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - shell: bash',
          '      run: node "${{ inputs.script }}" --strict --out=/dev/null',
          '',
        ].join('\n'),
      )
      assert.deepEqual(compositeActionGates(dir), [], 'the templated hole closed')

      // The other half: a templated ARGUMENT on a literal head IS caught. This
      // is what makes the claim above specific rather than "anything with a
      // `$` hides", which measurement disproves.
      writeFileSync(
        path.join(dir, 'templated', 'action.yaml'),
        [
          'name: templated-arg',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - shell: bash',
          '      run: node scripts/docs/coupling-gate.mjs --strict --out="${{ inputs.out }}"',
          '',
        ].join('\n'),
      )
      assert.equal(compositeActionGates(dir).length, 1, 'a templated ARGUMENT must still be caught')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('compositeActionGates THROWS when it cannot look, rather than passing', () => {
    // A missing directory is a legitimate empty state. Anything else means the
    // guard could not look, and a check that passes when it cannot look is the
    // defect this whole file exists to remove.
    assert.deepEqual(compositeActionGates(path.join(tmpdir(), 'preflight-absent-xyz')), [])
    const file = mkdtempSync(path.join(tmpdir(), 'preflight-notdir-'))
    try {
      const notADir = path.join(file, 'a.yml')
      writeFileSync(notADir, 'name: x\n')
      assert.throws(() => compositeActionGates(notADir), /ENOTDIR/)
    } finally {
      rmSync(file, { recursive: true, force: true })
    }
  })

  test('every runnable claim the composite-action prose makes is true', () => {
    // #2163's enumerating sweep, made durable. Three review rounds in a row
    // each corrected a comment and introduced a FRESH mechanism error in the
    // correction — a class, not three incidents. Patching the next instance
    // would have lost that race too, so every sentence in `preflight.mjs`'s
    // `compositeActionGates` docstring, `preflight-gates.json`'s `$comment` and
    // the commit message that asserts runnable behaviour is executed here
    // rather than read. A prose edit that outruns the code now reddens.
    const plant = (dir, rel, run) => {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true })
      writeFileSync(
        path.join(dir, rel),
        `runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: ${run}\n`,
      )
    }
    const withDir = (fn) => {
      const d = mkdtempSync(path.join(tmpdir(), 'preflight-claims-'))
      try {
        return fn(d)
      } finally {
        rmSync(d, { recursive: true, force: true })
      }
    }

    // "Every rule and every shield entry begins with a LITERAL head."
    for (const r of GATE_RULES) {
      assert.ok(literalHead(r.source).length > 0, `no literal head: ${r.source}`)
    }
    // "...and `node \"${{ …` is not one of them, so the command matches nothing."
    assert.equal(
      GATE_SHAPED_ANYWHERE.some((r) => r.test('node "${{ inputs.script }}" --out=x')),
      false,
    )

    // "A top-level action.yml is still handled" — the recursion did not lose it.
    assert.deepEqual(
      withDir((d) => {
        plant(d, 'action.yml', 'npm run lint:db-mocks')
        return compositeActionGates(d).map((r) => r.file)
      }),
      ['action.yml'],
    )

    // "an ENOENT here means the guard cannot read a file it can SEE" — the
    // asymmetry with the readdirSync catch, which the docstring argues for.
    withDir((d) => {
      mkdirSync(path.join(d, 'a'))
      symlinkSync(path.join(d, 'nothing-here'), path.join(d, 'a', 'action.yml'))
      assert.throws(() => compositeActionGates(d), /ENOENT/)
    })

    // "it is the ADVISORY half of BOTH coupling pairs."
    const users = workflowFiles()
      .filter((f) => /advisory-gate-comment/.test(readFileSync(f, 'utf8')))
      .map((f) => path.basename(f))
      .sort()
    assert.deepEqual(users, ['design-system-coupling.yml', 'docs-coupling.yml'])
  })

  test('a run:-shaped line inside a block BODY is not counted as its own key', () => {
    // What the `consumed` spans are for. Without them a step that writes a
    // workflow file — a body line reading `run: …` — is reported as an
    // unreadable key forever, and the guard gets switched off as noisy.
    // Deleting the span machinery kept the suite green.
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-spans-'))
    try {
      writeFileSync(
        path.join(dir, 'a.yml'),
        [
          'on:',
          '  pull_request:',
          'jobs:',
          '  j:',
          '    name: J',
          '    steps:',
          '      - name: writes a workflow',
          '        run: |',
          '          cat > out.yml <<EOF',
          '          run: npm run lint:not-really-a-key',
          '          EOF',
          '',
        ].join('\n'),
      )
      assert.deepEqual(unreadableRunKeys(dir), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no PR-triggered workflow has a run: key the parser cannot read', () => {
    // Half one of the silent-drop detector, PER KEY. A file-level version of
    // this (`commands === 0` for the whole file) saw nothing when one key among
    // ci.yml's 88 went unread, while three comments claimed it was per-key.
    assert.deepEqual(unreadableRunKeys(), [])
  })

  test('no parsed command is a YAML parse artifact', () => {
    // Half two, and the half with teeth. Most malformed shapes yield a GARBAGE
    // command rather than none, so the key looks productive and the detector
    // above stays quiet: `run: |+` produced the literal string `|+`, which then
    // matched NOT_GATE_RULES through its own pipe and vanished with the block's
    // real gate. A command never starts with a YAML indicator.
    assert.deepEqual(suspiciousCommands(), [])
  })

  test('every block-scalar indicator is read as a block, not as a command', () => {
    // `|+` and `>+` are as valid as `|` and `|-`, and an explicit indentation
    // indicator (`|2`) is too. Listing only the common four is what produced
    // the `|+` artifact above.
    for (const indicator of ['|', '|-', '|+', '>', '>-', '>+', '|2']) {
      const yaml = [
        'jobs:',
        '  a:',
        '    name: A',
        '    steps:',
        `      - run: ${indicator}`,
        '          npm run lint:in-block',
      ].join('\n')
      assert.deepEqual(
        parseWorkflow('fixture.yml', yaml).commands.map((c) => c.command),
        ['npm run lint:in-block'],
        `indicator ${indicator} was not read as a block`,
      )
    }
  })
})

describe('the real-DB skip detector', () => {
  test('its marker matches both signals the backend actually prints', () => {
    // The detector reads the gate's OUTPUT rather than the environment, which
    // makes it correct — and couples it to two strings in another package. A
    // reword there would silently stop it detecting: a silent skip inside the
    // guard against silent skips. So the coupling is asserted against the
    // literals, read out of the files that own them.
    //
    // The probes below are deliberately a THIRD copy of each string. That is
    // the cost: a legitimate reword of the harness banner has to touch the
    // source, DB_SKIP_MARKER and this probe. An independent probe is the only
    // way the test can fail when the marker and the source drift apart — one
    // derived from the marker would agree with it by construction.
    const harness = readFileSync(
      new URL('../../packages/backend/src/infra/__tests__/helpers/db-harness.ts', import.meta.url),
      'utf8',
    )
    const inline = /real-DB suites SKIPPED/.exec(harness)
    assert.ok(inline, 'db-harness.ts no longer prints the inline marker this detector reads')
    assert.ok(DB_SKIP_MARKER.test(inline[0]), 'the marker stopped matching db-harness.ts')

    const globalSetup = readFileSync(
      new URL('../../packages/backend/vitest.global-setup.ts', import.meta.url),
      'utf8',
    )
    const banner = /REAL-DB SUITES SKIPPED/.exec(globalSetup)
    assert.ok(banner, 'vitest.global-setup.ts no longer prints the end-of-run banner')
    // Case-insensitivity is the load-bearing part: #1763 made the end-of-run
    // banner the authoritative signal and it shouts in caps, so a
    // case-sensitive marker keyed to the inline one would miss it.
    assert.ok(DB_SKIP_MARKER.test(banner[0]), 'the marker misses the authoritative banner')
  })

  test('it does not fire on ordinary green output', () => {
    assert.equal(DB_SKIP_MARKER.test('✓ 36 gate(s) green.'), false)
    assert.equal(DB_SKIP_MARKER.test('real-DB suites ENABLED'), false)
  })
})

describe('the gate map file', () => {
  test('is valid JSON with the two expected keys', () => {
    const raw = JSON.parse(readFileSync(new URL('./preflight-gates.json', import.meta.url), 'utf8'))
    assert.ok(Array.isArray(raw.$comment))
    assert.equal(typeof raw.notGates, 'object')
  })
})
