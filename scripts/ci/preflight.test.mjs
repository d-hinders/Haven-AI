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
  GATE_OUTPUT_MAX_BUFFER,
  runGate,
  GATE_RULE_TABLE,
  GATE_CLASSES,
  gateClass,
  TIMEOUT_SHAPES,
  NEVER_LOAD_SHAPES,
  isTimeoutShaped,
  isHighLoad,
  readMachineLoad,
  runBattery,
  summarize,
  parseArgs,
  usage,
  EXIT,
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
    // And every gate among them has a class (#4175): static or suite, from the
    // rule that matched it or from a `gateClasses` row. A gate with no class
    // would sort after every static gate and be dropped by `--static`, which is
    // a silent reclassification as suite.
    const unclassed = commands
      .filter((c) => classifyCommand(c, map) === 'gate')
      .filter((c) => !GATE_CLASSES.includes(gateClass(c, map)))
    assert.deepEqual(unclassed, [], `gates with no static/suite class:\n${unclassed.join('\n')}`)
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
  test('is valid JSON with the expected keys', () => {
    const raw = JSON.parse(readFileSync(new URL('./preflight-gates.json', import.meta.url), 'utf8'))
    assert.ok(Array.isArray(raw.$comment))
    assert.equal(typeof raw.notGates, 'object')
    assert.equal(typeof raw.gateClasses, 'object')
  })
})

describe('the gate output buffer (#3954)', () => {
  test('a gate whose own output exceeds 1 MiB is not killed and its output is captured', () => {
    // The backend suite prints ~1.47 MB; under Node's default 1 MiB
    // `maxBuffer`, `spawnSync` killed it mid-run (~34 s in) and preflight
    // reported the gate red while the same command run directly passed.
    // The buffer the battery passes must therefore exceed that measured
    // chatter — assert against 1.5 MiB, and against the constant itself.
    const emitted = Math.round(1.5 * 1024 * 1024)
    const result = runGate({
      command: `node -e "process.stdout.write('x'.repeat(${emitted}))"`,
      jobs: ['ci'],
    })
    assert.equal(result.status, 0, `gate killed or failed: status=${result.status}`)
    assert.equal(result.ok, true)
    assert.equal(result.output.length, emitted, 'captured output was truncated')
  })

  test('the buffer is sized well above the suite that was killed', () => {
    // The measured floor is the backend suite's ~1.47 MB of stdout. Anything
    // at or below that would leave the original defect standing.
    assert.ok(GATE_OUTPUT_MAX_BUFFER >= 10 * 1024 * 1024)
  })
})

// ── #4175: static/suite classes, static-first order, --static, flag refusal,
//    and the load-aware re-run ────────────────────────────────────────────────

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

/** Run preflight.mjs as the builder does, in a child process. */
const preflightCli = (args) =>
  spawnSync(process.execPath, ['scripts/ci/preflight.mjs', ...args], { cwd: REPO, encoding: 'utf8' })

/** The `--list` output as [command, class] pairs, in printed order. */
const listedClasses = (stdout) => {
  const lines = stdout.split('\n')
  const rows = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}(\S.*)$/.exec(lines[i])
    if (!m) continue
    const kind = /^ {6}(static|suite) · /.exec(lines[i + 1] ?? '')
    rows.push([m[1], kind ? kind[1] : null])
  }
  return rows
}

/**
 * Real `node --test` output, captured the way the battery captures it: through
 * `runGate`, from a fixture file in a scratch directory.
 */
const liveNodeTest = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'preflight-live-'))
  try {
    const file = path.join(dir, 'fixture.test.mjs')
    writeFileSync(file, `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\n${body}\n`)
    // `env -u NODE_TEST_CONTEXT`: this suite runs under `node --test`, and a
    // child that inherits the variable skips its files ("run() is being called
    // recursively") and exits 0 — a green that is about nothing.
    return runGate({ command: `env -u NODE_TEST_CONTEXT node --test "${file}"`, jobs: ['fixture'] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('static and suite classes (#4175)', () => {
  const scriptsOf = (pkgDir) =>
    JSON.parse(readFileSync(path.join(REPO, pkgDir, 'package.json'), 'utf8')).scripts ?? {}

  /**
   * Every shell piece a gate ends up running, following `npm run` aliases into
   * the package that owns them, with the directory npm runs each piece in.
   */
  const resolvePieces = (command, cwd = '.', seen = new Set()) => {
    const m = /^npm run ([\w:-]+)(?: -w (packages\/[\w-]+))?$/.exec(command.trim())
    if (!m) return [{ piece: command.trim(), cwd }]
    const [, name, ws] = m
    const dir = ws ?? cwd
    if (seen.has(`${dir}:${name}`)) return []
    seen.add(`${dir}:${name}`)
    const body = scriptsOf(dir)[name]
    assert.ok(body, `no script ${name} in ${dir}/package.json`)
    return body.split('&&').flatMap((piece) => resolvePieces(piece, dir, seen))
  }

  // A test runner, a compiler or a build: what `static` promises a gate is not.
  const RUNNER = /\bnode --test\b|\bvitest\b|\bjest\b|\bplaywright\b|\btsc\b|\bnext build\b/
  const runsASuite = ({ piece, cwd }) => {
    if (RUNNER.test(piece)) return true
    // `node x.mjs` / `tsx x.ts` over a file that is itself a test file.
    const file = /^(?:node|tsx) ([\w./-]+\.(?:mjs|js|ts))(?:\s|$)/.exec(piece)?.[1]
    if (!file) return false
    return /from ['"](?:node:test|vitest)['"]/.test(readFileSync(path.join(REPO, cwd, file), 'utf8'))
  }

  test('lint:network-pins is a suite, though its name says lint', () => {
    assert.equal(gateClass('npm run lint:network-pins', map), 'suite')
    assert.equal(buildPlan().find((g) => g.command === 'npm run lint:network-pins')?.kind, 'suite')
    // The `gateClasses` row is what makes it one: the rule alone says static.
    assert.equal(gateClass('npm run lint:network-pins', { notGates: {} }), 'static')
  })

  test('no static gate runs a test suite, a compiler or a build', () => {
    // The guard that makes the class honest without a hand list: every static
    // gate's script body is resolved and read. A new `lint:foo` that is
    // `node --test …` reddens here until a `gateClasses` row says suite.
    const wrong = buildPlan()
      .filter((g) => g.kind === 'static')
      .filter((g) => resolvePieces(g.command).some(runsASuite))
      .map((g) => g.command)
    assert.deepEqual(wrong, [], `static gates that run a suite:\n${wrong.join('\n')}`)
  })

  test('the resolver can say yes', () => {
    // Without these the check above is green about nothing.
    assert.equal(resolvePieces('npm run lint:network-pins').some(runsASuite), true)
    assert.equal(resolvePieces('npm run lint:deps:test').some(runsASuite), true)
    assert.equal(runsASuite({ piece: 'node scripts/network-map-pins.test.mjs', cwd: '.' }), true)
    // And follows an alias into a workspace: root `check:route-modules` is
    // `npm run check:route-modules -w packages/backend`, which is `tsx …`.
    assert.deepEqual(resolvePieces('npm run check:route-modules'), [
      { piece: 'tsx scripts/generate-route-modules.ts --check', cwd: 'packages/backend' },
    ])
  })

  test('a lint self-test is a suite: the :test rule sits above the lint rule', () => {
    for (const c of ['npm run lint:deps:test', 'npm run lint:wire-types:test', 'npm run visual:baselines:test']) {
      assert.equal(gateClass(c, map), 'suite', c)
    }
    for (const c of ['npm run lint:deps', 'npm run visual:baselines', 'npm run docs:check']) {
      assert.equal(gateClass(c, map), 'static', c)
    }
  })

  test('every rule and every gateClasses row names a known class, with a reason', () => {
    for (const r of GATE_RULE_TABLE) assert.ok(GATE_CLASSES.includes(r.kind), r.rule.source)
    for (const [command, row] of Object.entries(map.gateClasses)) {
      assert.ok(GATE_CLASSES.includes(row.class), `${command}: class ${row.class}`)
      assert.ok(row.reason.trim().length >= 40, `${command}: needs a real reason`)
    }
  })

  test('no gateClasses row is stale or redundant', () => {
    const plan = new Set(buildPlan().map((g) => g.command))
    for (const [command, row] of Object.entries(map.gateClasses)) {
      assert.ok(plan.has(command), `gateClasses row for a command no plan entry runs: ${command}`)
      assert.notEqual(gateClass(command, { notGates: {} }), row.class, `redundant row: ${command}`)
    }
  })
})

describe('static-first order and --static (#4175)', () => {
  test('buildPlan puts static entries first and keeps the derived order in each group', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'preflight-order-'))
    try {
      writeFileSync(
        path.join(dir, 'x.yml'),
        [
          'on:',
          '  pull_request:',
          'jobs:',
          '  j:',
          '    name: J',
          '    steps:',
          '      - run: npm run test -w packages/aaa',
          '      - run: npm run lint:first',
          '      - run: npm run build -w packages/aaa',
          '      - run: npm run lint:second',
          '      - run: npm run lint:third:test',
          '',
        ].join('\n'),
      )
      assert.deepEqual(
        buildPlan({ dir }).map((g) => [g.command, g.kind]),
        [
          ['npm run lint:first', 'static'],
          ['npm run lint:second', 'static'],
          ['npm run test -w packages/aaa', 'suite'],
          ['npm run build -w packages/aaa', 'suite'],
          ['npm run lint:third:test', 'suite'],
        ],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('--all --list prints every static entry before the first suite entry', () => {
    const child = preflightCli(['--all', '--list'])
    assert.equal(child.status, 0, child.stderr)
    const rows = listedClasses(child.stdout)
    assert.equal(rows.length, buildPlan().length)
    assert.ok(rows.every(([, kind]) => kind !== null), 'a listed entry carries no class')
    const firstSuite = rows.findIndex(([, kind]) => kind === 'suite')
    const lastStatic = rows.findLastIndex(([, kind]) => kind === 'static')
    assert.ok(lastStatic >= 0 && firstSuite >= 0, 'both groups must be non-empty for this to mean anything')
    assert.ok(lastStatic < firstSuite, `static entry at ${lastStatic} after the first suite at ${firstSuite}`)
  })

  test('--static --list prints only static entries, under --all and under --base', () => {
    const staticCount = buildPlan().filter((g) => g.kind === 'static').length
    assert.ok(staticCount > 0)
    for (const args of [
      ['--static', '--all', '--list'],
      ['--list', '--static', '--base=HEAD'],
    ]) {
      const child = preflightCli(args)
      assert.equal(child.status, 0, `${args.join(' ')}: ${child.stderr}`)
      const rows = listedClasses(child.stdout)
      assert.deepEqual(
        rows.filter(([, kind]) => kind !== 'static'),
        [],
        `${args.join(' ')} listed a non-static entry`,
      )
      if (args.includes('--all')) assert.equal(rows.length, staticCount)
      assert.match(child.stdout, /selected \(static only\)/)
    }
  })

  test('usage() lists --static and every exit code', () => {
    const text = usage()
    assert.match(text, /^ {2}--static {10}run only the static ratchets/m)
    for (const code of Object.values(EXIT)) assert.match(text, new RegExp(`^exit ${code} `, 'm'))
  })
})

describe('argument parsing (#4175)', () => {
  test('known flags parse, --base= takes its ref', () => {
    assert.deepEqual(parseArgs(['--all', '--static', '--list', '--verify-ruleset', '--base=abc123']), {
      opts: { all: true, list: true, static: true, verifyRuleset: true, help: false, base: 'abc123' },
    })
    assert.equal(parseArgs([]).opts.base, 'origin/dev')
    assert.equal(parseArgs(['-h']).opts.help, true)
  })

  test('an unknown flag, a positional or an empty --base= is refused', () => {
    assert.deepEqual(parseArgs(['--statc', '--list']), { error: 'unknown argument: --statc' })
    assert.deepEqual(parseArgs(['--list', 'extra']), { error: 'unknown argument: extra' })
    assert.deepEqual(parseArgs(['--base']), { error: 'unknown argument: --base' })
    assert.match(parseArgs(['--base=']).error, /needs a ref/)
    // Prototype keys are not flags.
    assert.deepEqual(parseArgs(['constructor']), { error: 'unknown argument: constructor' })
  })

  test('--statc --list exits 2 with the usage text and runs nothing', () => {
    // It used to run the default plan and exit 0 (measured on #4175).
    const child = preflightCli(['--statc', '--list'])
    assert.equal(child.status, EXIT.USAGE)
    assert.equal(EXIT.USAGE, 2)
    assert.equal(child.stdout, '', 'a refused run printed a plan')
    assert.ok(child.stderr.startsWith('preflight: unknown argument: --statc\n\n'), child.stderr)
    assert.ok(child.stderr.includes(usage()), 'the refusal does not carry the usage text')
  })
})

// The runners' own words, as the battery's pipes capture them. vitest's are
// copied from `@vitest/runner` 3.2.4 `dist/chunk-hooks.js` (makeTimeoutError)
// and `vitest` 3.2.4 `dist/chunks/rpc.*.js` (onTimeoutError), because vitest is
// not installed where this suite runs; `node --test`'s are produced live below.
const VITEST_TEST_TIMEOUT =
  ' FAIL  src/infra/__tests__/reconcile.test.ts > reconcile > settles once\n' +
  'Error: Test timed out in 5000ms.\n' +
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".'
const VITEST_HOOK_TIMEOUT =
  ' FAIL  src/infra/__tests__/reconcile.test.ts > reconcile\n' +
  'Error: Hook timed out in 10000ms.\n' +
  'If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".'
const VITEST_RPC_TIMEOUT = 'Error: [vitest-worker]: Timeout calling "onTaskUpdate"'
const VITEST_ASSERTION =
  ' FAIL  src/routes/x.test.ts > x > answers\nAssertionError: expected 500 to be 200 // Object.is equality'

describe('timeout shapes (#4175)', () => {
  const red = (output, extra = {}) => ({ ok: false, status: 1, signal: null, output, ...extra })

  test('vitest test, hook and onTaskUpdate timeouts are timeout-shaped', () => {
    for (const output of [VITEST_TEST_TIMEOUT, VITEST_HOOK_TIMEOUT, VITEST_RPC_TIMEOUT]) {
      assert.equal(isTimeoutShaped(red(output)), true, output)
    }
  })

  test('a node --test timeout, produced live, is timeout-shaped', () => {
    const live = liveNodeTest("test('slow', { timeout: 20 }, () => new Promise((r) => setTimeout(r, 300)))")
    assert.equal(live.ok, false, live.output)
    assert.match(live.output, /'test timed out after 20ms'/)
    assert.equal(isTimeoutShaped(live), true)
  })

  test('a node --test runner cancelled by SIGTERM, produced live, is timeout-shaped', () => {
    // The file's test sends SIGTERM to the runner (its parent), which is what an
    // outer timeout does to a gate.
    const live = liveNodeTest(
      "test('runner killed', () => { process.kill(process.ppid, 'SIGTERM'); return new Promise((r) => setTimeout(r, 1500)) })",
    )
    assert.equal(live.ok, false, live.output)
    assert.match(live.output, /^Interrupted while running:$/m)
    assert.equal(isTimeoutShaped(live), true)
  })

  test("a gate whose shell is ended by SIGTERM, produced live, is timeout-shaped", () => {
    const live = runGate({ command: 'kill -TERM $$', jobs: ['fixture'] })
    assert.equal(live.status, null)
    assert.equal(live.signal, 'SIGTERM')
    assert.equal(isTimeoutShaped(live), true)
    assert.equal(isTimeoutShaped({ ...live, signal: 'SIGKILL' }), false, 'only SIGTERM is timeout-shaped')
  })

  test('a node --test assertion failure, produced live, is not timeout-shaped', () => {
    const live = liveNodeTest("test('eq', () => { assert.equal(1, 2) })")
    assert.equal(live.ok, false)
    assert.match(live.output, /AssertionError \[ERR_ASSERTION\]/)
    assert.equal(isTimeoutShaped(live), false)
  })

  test('a timeout beside an assertion failure, a missing dist or a missing module is not', () => {
    for (const other of [
      VITEST_ASSERTION,
      "Error: ENOENT: no such file or directory, open '/repo/packages/sdk/dist/index.js'",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/packages/sdk/dist/index.js'",
      'Error: Failed to resolve entry for package "@haven_ai/sdk".',
    ]) {
      assert.equal(isTimeoutShaped(red(`${VITEST_TEST_TIMEOUT}\n${other}`)), false, other)
    }
  })

  test('a red that names no timeout is not timeout-shaped', () => {
    for (const output of [
      'Error: boom',
      VITEST_ASSERTION,
      // A vitest RPC timeout on module loading is not a timed test.
      'Error: [vitest-worker]: Timeout calling "fetch" with "["/src/x.ts","web"]"',
      // Words, not the runner's shape.
      'request timed out while connecting to 127.0.0.1:5432',
      '',
    ]) {
      assert.equal(isTimeoutShaped(red(output)), false, JSON.stringify(output))
    }
    assert.equal(isTimeoutShaped({ ok: true, status: 0, signal: null, output: VITEST_TEST_TIMEOUT }), false)
  })

  test('every shape is exercised by a fixture above', () => {
    const fixtures = [VITEST_TEST_TIMEOUT, VITEST_HOOK_TIMEOUT, VITEST_RPC_TIMEOUT, "'test timed out after 20ms'", '\nInterrupted while running:\n']
    for (const r of TIMEOUT_SHAPES) assert.ok(fixtures.some((f) => r.test(f)), `no fixture for ${r.source}`)
    assert.ok(NEVER_LOAD_SHAPES.length > 0)
  })
})

describe('load reading (#4175)', () => {
  test('high means strictly above the CPU count', () => {
    assert.equal(isHighLoad({ load: 8.01, cpus: 8 }), true)
    assert.equal(isHighLoad({ load: 8, cpus: 8 }), false)
    assert.equal(isHighLoad({ load: 3, cpus: 8 }), false)
  })

  test('a zero reading on either side never reads as high (Windows, empty os.cpus())', () => {
    assert.equal(isHighLoad({ load: 0, cpus: 8 }), false)
    assert.equal(isHighLoad({ load: 0, cpus: 0 }), false)
    assert.equal(isHighLoad({ load: 5, cpus: 0 }), false)
  })

  test('readMachineLoad reads the 1-minute average and the CPU count', () => {
    const sample = readMachineLoad()
    assert.equal(typeof sample.load, 'number')
    assert.ok(Number.isInteger(sample.cpus) && sample.cpus >= 0)
  })
})

describe('the load-aware re-run (#4175)', () => {
  /**
   * Drive `runBattery` with a scripted runner, a modelled machine and a clock.
   * Each command maps to the attempts it will make, in order. An attempt can
   * move the machine's load at its start (`loadDuring`, the gate's own
   * workers) or at its end (`loadAfter`, what the next reading sees).
   */
  const drive = (script, { load = 12, cpus = 8 } = {}) => {
    const machine = { load, cpus }
    const calls = []
    const samples = []
    let clock = 0
    const outcome = runBattery(
      Object.keys(script).map((command) => ({ command, jobs: [`${command} job`] })),
      {
        run: (gate) => {
          calls.push(gate.command)
          const step = script[gate.command].shift()
          assert.ok(step, `runner called more often than scripted for ${gate.command}`)
          if (step.loadDuring !== undefined) machine.load = step.loadDuring
          const result = { ...gate, ok: step.ok, status: step.ok ? 0 : 1, signal: null, output: step.output ?? '' }
          if (step.loadAfter !== undefined) machine.load = step.loadAfter
          return result
        },
        readLoad: () => {
          samples.push(machine.load)
          return { ...machine }
        },
        now: () => (clock += 500),
      },
    )
    return { outcome, calls, samples, summary: summarize(outcome) }
  }

  test('a timeout-shaped red above the CPU count, green alone: its own group, exit 3', () => {
    const { outcome, calls, samples, summary } = drive({
      'npm run test -w packages/x': [{ ok: false, output: VITEST_TEST_TIMEOUT, loadAfter: 3 }, { ok: true }],
    })
    assert.equal(outcome.code, EXIT.RED_UNDER_LOAD)
    assert.equal(EXIT.RED_UNDER_LOAD, 3)
    assert.deepEqual(calls, ['npm run test -w packages/x', 'npm run test -w packages/x'])
    assert.deepEqual(samples, [12, 3])
    assert.deepEqual(outcome.greenAlone.map((r) => r.command), ['npm run test -w packages/x'])
    assert.deepEqual([outcome.red, outcome.redAlone], [[], []])
    assert.ok(
      summary.err.includes(
        '!   npm run test -w packages/x  red under load 12.00 on 8 CPU(s), green alone at load 3.00 on 8 CPU(s)',
      ),
      summary.err.join('\n'),
    )
    assert.ok(summary.err.some((l) => l.includes('red under load, green alone (exit 3, not a pass)')))
    assert.deepEqual(summary.out, [], 'a load-red run printed a green line')
    // The injected clock reached the result.
    assert.equal(outcome.results[0].seconds, '0.5')
  })

  test('the same gate red again alone is red, exit 1', () => {
    const { outcome, calls, summary } = drive({
      'npm run test -w packages/x': [
        { ok: false, output: VITEST_TEST_TIMEOUT, loadAfter: 4 },
        { ok: false, output: VITEST_HOOK_TIMEOUT },
      ],
    })
    assert.equal(outcome.code, EXIT.RED)
    assert.equal(calls.length, 2)
    assert.deepEqual(outcome.redAlone.map((r) => r.command), ['npm run test -w packages/x'])
    assert.deepEqual(outcome.greenAlone, [])
    assert.ok(
      summary.err.includes(
        '── npm run test -w packages/x  → reddens: npm run test -w packages/x job\n' +
          '   red under load 12.00 on 8 CPU(s), red alone at load 4.00 on 8 CPU(s)',
      ),
      summary.err.join('\n'),
    )
    // The tail printed is the re-run's.
    assert.ok(summary.err.some((l) => l.includes('Hook timed out in 10000ms.')))
  })

  test('an assertion failure at high load is not re-run', () => {
    const { outcome, calls } = drive({ 'npm run test -w packages/x': [{ ok: false, output: VITEST_ASSERTION }] }, {
      load: 40,
    })
    assert.deepEqual(calls, ['npm run test -w packages/x'])
    assert.equal(outcome.code, EXIT.RED)
    assert.deepEqual(outcome.red.map((r) => r.command), ['npm run test -w packages/x'])
  })

  test('a timeout-shaped red at load equal to the CPU count is not re-run', () => {
    const { outcome, calls } = drive({ 'npm run test -w packages/x': [{ ok: false, output: VITEST_TEST_TIMEOUT }] }, {
      load: 8,
    })
    assert.deepEqual(calls, ['npm run test -w packages/x'])
    assert.equal(outcome.code, EXIT.RED)
    assert.deepEqual(outcome.red.map((r) => r.command), ['npm run test -w packages/x'])
  })

  test("load is read BEFORE the gate starts, so the gate's own workers do not count", () => {
    // The machine is quiet (2 on 8 CPUs) until the gate's own pool lifts the
    // 1-minute average to 20, and the average is still 20 when it ends. A
    // reading taken at the end would call that other agents' load.
    const { outcome, calls, samples } = drive(
      { 'npm run test -w packages/x': [{ ok: false, output: VITEST_TEST_TIMEOUT, loadDuring: 20 }] },
      { load: 2 },
    )
    assert.deepEqual(samples, [2])
    assert.deepEqual(calls, ['npm run test -w packages/x'])
    assert.equal(outcome.code, EXIT.RED)
  })

  test('each queued gate is re-run exactly once, after the last selected gate', () => {
    const { calls, samples, outcome } = drive({
      'npm run lint:a': [{ ok: true, loadAfter: 13 }],
      'npm run test -w packages/b': [{ ok: false, output: VITEST_RPC_TIMEOUT, loadAfter: 14 }, { ok: true, loadAfter: 6 }],
      'npm run test -w packages/c': [{ ok: true, loadAfter: 15 }],
      'npm run test -w packages/d': [{ ok: false, output: VITEST_HOOK_TIMEOUT, loadAfter: 5 }, { ok: true, loadAfter: 7 }],
    })
    assert.deepEqual(calls, [
      'npm run lint:a',
      'npm run test -w packages/b',
      'npm run test -w packages/c',
      'npm run test -w packages/d',
      'npm run test -w packages/b',
      'npm run test -w packages/d',
    ])
    // One reading before every attempt, re-runs included.
    assert.deepEqual(samples, [12, 13, 14, 15, 5, 6])
    assert.deepEqual(
      outcome.greenAlone.map((r) => [r.command, r.load, r.rerun.load]),
      [
        ['npm run test -w packages/b', 13, 5],
        ['npm run test -w packages/d', 15, 6],
      ],
    )
    assert.equal(outcome.code, EXIT.RED_UNDER_LOAD)
  })

  test('never exit 0 while a green-alone group exists, and a plain red still wins', () => {
    const onlyLoad = drive({
      'npm run lint:a': [{ ok: true }],
      'npm run test -w packages/b': [{ ok: false, output: VITEST_TEST_TIMEOUT }, { ok: true }],
    })
    assert.equal(onlyLoad.outcome.code, EXIT.RED_UNDER_LOAD)
    assert.notEqual(onlyLoad.outcome.code, EXIT.GREEN)

    const mixed = drive({
      'npm run lint:a': [{ ok: false, output: 'lint:a: 1 new violation' }],
      'npm run test -w packages/b': [{ ok: false, output: VITEST_TEST_TIMEOUT }, { ok: true }],
    })
    assert.equal(mixed.outcome.code, EXIT.RED)
    // The forgiven gate is still listed beside the red one, never folded away.
    assert.ok(
      mixed.summary.err.some((l) => l.startsWith('!   npm run test -w packages/b  red under load 12.00')),
      mixed.summary.err.join('\n'),
    )
  })

  test('all green is exit 0 and prints the green line', () => {
    const { outcome, calls, summary } = drive({ 'npm run lint:a': [{ ok: true }], 'npm run lint:b': [{ ok: true }] })
    assert.equal(outcome.code, EXIT.GREEN)
    assert.equal(calls.length, 2)
    assert.deepEqual(summary.out, ['\n✓ 2 gate(s) green.'])
    assert.deepEqual(summary.err, [])
  })

  test("the DB-skip marker is read from the re-run's output for a re-run gate", () => {
    const BANNER = 'REAL-DB SUITES SKIPPED (no database)'
    // The timed-out first run printed the banner; the green re-run did not.
    const cleared = drive({
      'npm run test -w packages/backend': [{ ok: false, output: `${BANNER}\n${VITEST_TEST_TIMEOUT}` }, { ok: true, output: 'ok' }],
    })
    assert.deepEqual(cleared.outcome.skippedDb, [])

    // The first run did not; the green re-run skipped the database.
    const skipped = drive({
      'npm run test -w packages/backend': [{ ok: false, output: VITEST_TEST_TIMEOUT }, { ok: true, output: BANNER }],
    })
    assert.deepEqual(skipped.outcome.skippedDb.map((r) => r.command), ['npm run test -w packages/backend'])
    assert.ok(skipped.summary.err.includes('!   npm run test -w packages/backend'), 'the skip is not reported')

    // A gate that was not re-run is read from its one output.
    const plain = drive({ 'npm run test -w packages/backend': [{ ok: true, output: BANNER }] })
    assert.deepEqual(plain.outcome.skippedDb.map((r) => r.command), ['npm run test -w packages/backend'])
    assert.ok(plain.summary.out.includes('!   npm run test -w packages/backend'))
  })
})
