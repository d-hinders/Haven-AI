#!/usr/bin/env node
// The canonical pre-push gate battery (#3150).
//
// Four review rounds ended the same way, between 2026-09-09 and 2026-09-18 as
// #3150 records them: the builder reported "all
// repo gates green", the local battery really was green, and the PR's FIRST CI
// run went red on a gate that exists only inside a CI job. #3126 r2 hit three at
// once (`lint:next-steps`, `check:route-modules`, a workspace typecheck); #3126
// r1 hit the strict coupling gate; #3054 hit `lint:request-schemas`; #2732 hit
// the coupling gates again.
//
// The cause is not that any one gate was forgotten. It is that THE GATE LIST
// EXISTS NOWHERE A BUILDER READS. `npm run quality` is the script whose name
// promises this, and it chains `typecheck && test:unit && build`. That is not
// as narrow as a raw 3-of-70 would suggest — `--workspaces` covers every
// `typecheck -w` and `test -w` — but it covers NONE of the 21 ratchets, and the
// ratchets are what these four incidents reddened on. Not even the covered part
// is total: root `build` is not `--workspaces`, it is a hand-written
// nine-package chain that omits two of the eleven packages with a build script
// (`demo-merchant-mcp`, which IS a CI gate, and `qa-agent`, which is not) — a
// second copy of the workspace list, drifted, which is this file's own thesis
// one level down. So every builder assembles the
// list by hand, from memory, and the list keeps growing: #3135 added
// `check:route-modules` the same week #3126 was reviewed.
//
// THE FIX IS NOT ANOTHER HAND-MAINTAINED LIST. A second copy of the gate set
// would drift from CI exactly as the first one did — that is the defect, not an
// accident of it. So this battery DERIVES its gate list by reading the workflow
// files themselves, which are the things that actually create the check
// contexts, and a sibling test refuses to pass when a command appears in a
// workflow that this battery has never been told about.
//
//   node scripts/ci/preflight.mjs              # gates for the surfaces you changed
//   node scripts/ci/preflight.mjs --all        # every gate, regardless of diff
//   node scripts/ci/preflight.mjs --list       # print the plan, run nothing
//   node scripts/ci/preflight.mjs --base=<ref> # diff against something else
//   node scripts/ci/preflight.mjs --static     # only the static ratchets, then stop
//
// Static entries run first (#4175), and a timeout-shaped red is re-run alone at
// the end, at any load: see `runBattery`.
//
// Dependency-free (no YAML parser), like everything in this directory, so it
// runs from a bare checkout and its self-test runs in `ci_config_checks`.
//
// ── Why the workflows and not the ruleset ────────────────────────────────────
//
// #3150 asks for the list to derive from ruleset 18021461's required contexts.
// It does not, and the reason is not convenience. Reading the ruleset needs
// `gh api repos/.../rules/branches/dev`, and `gh` is absent from at least one
// builder environment in use today — so that battery would degrade to a silent
// skip in exactly the place this issue is about. A workflow file is checked in,
// needs no auth, and is what GitHub reads to create the contexts in the first
// place: a required context that no workflow produces cannot ever go green, so
// the workflows are the tighter constraint of the two.
//
// The ruleset half is still available to anyone who has `gh` — `--verify-ruleset`
// — and it SAYS SO when it cannot run rather than reporting a pass.

import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpus, loadavg } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyChangedFiles } from './change-classifier.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')

// WORKFLOW_DIR is how the self-test points this at a fixture directory. An env
// var, not argv: `node --test` owns argv (the ci-config-gate suite's precedent).
export const WORKFLOW_DIR = process.env.PREFLIGHT_WORKFLOW_DIR
  ? path.resolve(process.env.PREFLIGHT_WORKFLOW_DIR)
  : path.join(ROOT, '.github/workflows')

// Local composite actions. A `run:` in one is invisible to WORKFLOW_DIR, so a
// gate could live there unseen — the one silent path the classification work
// above cannot reach, because it is a file-discovery hole and not a parsing one.
export const ACTIONS_DIR = process.env.PREFLIGHT_ACTIONS_DIR
  ? path.resolve(process.env.PREFLIGHT_ACTIONS_DIR)
  : path.join(ROOT, '.github/actions')

export const GATE_MAP_PATH = process.env.PREFLIGHT_GATE_MAP
  ? path.resolve(process.env.PREFLIGHT_GATE_MAP)
  : path.join(HERE, 'preflight-gates.json')

/**
 * Does this workflow run on pull requests?
 *
 * Only the `on:` block counts. A workflow can mention `pull_request` in a job
 * condition, a `concurrency:` group, a comment or a `gh` command line without
 * being triggered by one. Measured at ce79bf0c, a whole-file grep for the
 * string — the obvious shortcut — misclassifies exactly three
 * workflows: `claim-assignee.yml`, `morning-report-note.yml` and
 * `update-visual-baselines.yml`, none of which run on a pull request. Their
 * steps would join every builder's battery.
 *
 * `db-concurrency-proof.yml` is NOT one of them, though its name says nightly:
 * it really is `pull_request`-triggered, path-filtered to the advisory-lock
 * files, so a builder touching those does get that job on their PR. An earlier
 * revision of this comment used it as the example and was wrong about it.
 *
 * Re-derive the three with:
 *   node --input-type=module -e "import {isPullRequestTriggered, workflowFiles}
 *     from './scripts/ci/preflight.mjs'; import {readFileSync} from 'node:fs';
 *     for (const f of workflowFiles()) { const y = readFileSync(f,'utf8');
 *       if (isPullRequestTriggered(y) !== /pull_request/.test(y)) console.log(f) }"
 */
export function isPullRequestTriggered(yaml) {
  const lines = yaml.split('\n')
  // `on` is QUOTED in many workflows — YAML 1.1 reads a bare `on` as the boolean
  // true, so `"on":` and `'on':` are both common and both valid. Missing them
  // drops the whole workflow from the battery AND from both silent-drop guards,
  // which `continue` on a non-PR file: the one shape no guard here can see.
  const KEY = /^["']?on["']?:\s*(\S?)/
  const start = lines.findIndex((l) => KEY.test(l))
  if (start === -1) return false
  // Inline form: `on: [push, pull_request]` or `on: pull_request`.
  if (KEY.exec(lines[start])[1]) return /\bpull_request\b/.test(lines[start])
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\S/.test(line)) break // dedented to column 0: the `on:` block ended
    // ANY indentation, not exactly two. A four-space `on:` block is as valid as
    // a two-space one and dropped the workflow silently.
    if (/^\s+pull_request(_target)?:/.test(line)) return true
  }
  return false
}

/** Every `.yml`/`.yaml` under the workflow directory, sorted for stable output. */
export function workflowFiles(dir = WORKFLOW_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => path.join(dir, f))
}

/**
 * Split one shell `run:` body into the individual commands a builder would run.
 *
 * Conservative on purpose. `&&` and `;` separate commands; a continuation line
 * (`\` at end) joins; anything with a pipe, a redirect, a subshell or a shell
 * keyword is returned WHOLE and will be classified as not-a-gate, because this
 * is a command splitter and not a shell. Being wrong in that direction costs a
 * `notGates` entry with a reason; being wrong the other way would silently drop
 * half a compound gate.
 */
export function splitCommands(body) {
  const joined = body.replace(/\\\n/g, ' ')
  const out = []
  // A line with an ODD number of double quotes OPENS a multi-line quoted
  // string — `node -e "` and its closing `"` in db-concurrency-proof.yml. Split
  // per line and each half reads as its own command: `node -e "` classified as
  // a gate-shaped nothing, and a bare `"` as a command. Rejoin them first, so
  // the whole block reaches the shell-syntax test as one unrunnable string.
  const lines = []
  let pending = null
  for (const rawLine of joined.split('\n')) {
    if (pending !== null) {
      pending += `\n${rawLine}`
      if ((rawLine.match(/"/g) ?? []).length % 2 === 1) {
        lines.push(pending)
        pending = null
      }
      continue
    }
    if ((rawLine.match(/"/g) ?? []).length % 2 === 1) pending = rawLine
    else lines.push(rawLine)
  }
  if (pending !== null) lines.push(pending)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    if (/[|><`$(]/.test(line) || /^(if|for|while|case|echo|set|export)\b/.test(line)) {
      out.push(line)
      continue
    }
    for (const piece of line.split(/&&|;/)) {
      const cmd = piece.trim()
      if (cmd !== '') out.push(cmd)
    }
  }
  return out
}

/**
 * Every command any PR-triggered workflow runs, with the job that owns it.
 *
 * A hand-rolled block reader rather than a YAML parse, matching the sibling
 * suites. The shapes it handles are `run: <cmd>` and `run: |` followed by an
 * indented block.
 *
 * A `run:` key it cannot read would drop a gate SILENTLY, which is the defect
 * this file exists to close — so every command records the LINE of the `run:`
 * key that produced it, and `unreadableRunKeys` below reports any key that
 * produced none. Per key, not per file: ci.yml has 88 keys and 165 commands, so
 * a file-level count (`commands === 0`) would see nothing when one key among the
 * 88 goes unread. An earlier revision named this guard before it existed, and
 * the revision after that made it file-level while claiming per-key.
 */
export function parseWorkflow(file, yaml) {
  const lines = yaml.split('\n')
  const found = []
  const consumed = []
  let job = null
  let jobDisplay = null
  let surfaceGate = null

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]

    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (jobMatch) {
      job = jobMatch[1]
      jobDisplay = null
      surfaceGate = null
      continue
    }
    if (job) {
      const nameMatch = /^    name:\s*(.+?)\s*$/.exec(line)
      if (nameMatch) jobDisplay = stripQuotes(nameMatch[1])
      const ifMatch = /^    if:\s*(.+?)\s*$/.exec(line)
      if (ifMatch) surfaceGate = surfacesInCondition(ifMatch[1])
    }

    const runMatch = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line)
    if (!runMatch) continue
    const [, indent, rest] = runMatch
    const runLineNo = i + 1
    let body
    if (rest === '') {
      // `run:` with the command on the NEXT line — a plain multi-line scalar,
      // valid YAML and a shape the first version of this parser read as empty,
      // dropping whatever gate it held with nothing to say so. No workflow here
      // uses it today, so this is defensive robustness rather than a gap the
      // guard caught in the corpus; the shape that the guard DID catch is `|+`,
      // above.
      const blockLines = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const bl = lines[j]
        if (bl.trim() === '' || !bl.startsWith(indent + '  ')) break
        blockLines.push(bl.slice(indent.length + 2))
        i = j
      }
      body = blockLines.join('\n')
    } else if (/^[|>][+-]?\d*$/.test(rest)) {
      // EVERY block-scalar indicator, not the four common ones: `|`, `|-`,
      // `|+`, `>`, `>-`, `>+`, and the explicit-indentation forms (`|2`). A
      // listed-four test read `|+` as a literal command `|+`, which then
      // matched NOT_GATE_RULES through its `|` and vanished silently — the
      // block's real gate with it, and the zero-command detector saw a key that
      // had "produced a command" so it said nothing either.
      const blockLines = []
      for (let j = i + 1; j < lines.length; j += 1) {
        const bl = lines[j]
        if (bl.trim() !== '' && !bl.startsWith(indent + '  ')) break
        blockLines.push(bl.slice(indent.length + 2))
        i = j
      }
      body = blockLines.join('\n')
    } else {
      body = rest
    }
    for (const command of splitCommands(body)) {
      found.push({
        file: path.basename(file),
        job,
        jobDisplay,
        surfaceGate,
        command,
        // The 1-based line of the `run:` key this command came from. What makes
        // the silent-drop detector PER-KEY rather than per-file.
        runLine: runLineNo,
      })
    }
    // The span this `run:` consumed, so a `run:`-looking line inside a block
    // BODY — a step that writes a workflow file, say — is not counted as a key
    // of its own and reported unreadable.
    consumed.push([runLineNo, i + 1])
  }
  return { commands: found, consumed }
}

/** Back-compat shape: just the commands. */
export function parseWorkflowCommands(file, yaml) {
  return parseWorkflow(file, yaml).commands
}

const stripQuotes = (s) => s.replace(/^["'](.*)["']$/, '$1')

/**
 * The `changes` outputs a job's `if:` condition depends on.
 *
 * `null` means the job is ungated — it runs on every pull request, so its gates
 * are always in the battery. An `if:` naming no surface output (a `needs.*.result`
 * guard, say) is also `null`: it does not narrow by surface.
 */
export function surfacesInCondition(condition) {
  const found = [...condition.matchAll(/needs\.changes\.outputs\.([a-z_]+)\s*==\s*'true'/g)].map(
    (m) => m[1],
  )
  return found.length > 0 ? [...new Set(found)] : null
}

/**
 * `run:` keys that produced no command, per workflow.
 *
 * The silent-drop detector, PER KEY. A `run:` key always runs SOMETHING, so a
 * key that produced no command means the parser did not understand its shape —
 * `|+`, an anchor, a form nobody has used here yet — and whatever gate it held
 * is missing from every builder's battery with nothing to say so.
 *
 * Returns `{ file, line, text }` rows, so a failure names the key rather than
 * the file.
 *
 * Two things it cannot see, neither of which produces a false alarm today
 * because the parser misreads the same lines identically and the two therefore
 * agree by construction: a `run:`-shaped line inside a block BODY that the
 * parser did not record as consumed, and a commented-out `# run:`. Written down
 * rather than guarded — a guard for either would have to out-parse the parser
 * it is checking.
 */
export function unreadableRunKeys(dir = WORKFLOW_DIR) {
  const rows = []
  for (const file of workflowFiles(dir)) {
    const yaml = readFileSync(file, 'utf8')
    if (!isPullRequestTriggered(yaml)) continue
    const { commands, consumed } = parseWorkflow(file, yaml)
    const produced = new Set(commands.map((c) => c.runLine))
    const lines = yaml.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\s*(?:- )?run:/.test(lines[i])) continue
      const lineNo = i + 1
      // A `run:`-looking line INSIDE a block body is not a key — a step that
      // writes a workflow file contains one. The parser reports the spans it
      // consumed so the detector and the parser cannot disagree about what a
      // key is.
      if (consumed.some(([from, to]) => lineNo > from && lineNo <= to)) continue
      if (!produced.has(lineNo)) rows.push({ file: path.basename(file), line: lineNo, text: lines[i].trim() })
    }
  }
  return rows
}

/**
 * Parsed "commands" that are really YAML the parser failed to consume.
 *
 * The zero-command detector above has a blind spot by construction: most
 * malformed shapes yield a garbage command rather than none, so the key looks
 * productive. `|+` produced the literal string `|+`, which then matched
 * NOT_GATE_RULES through its own pipe and disappeared without a word.
 *
 * A real command never begins with a YAML indicator, so anything that does is a
 * parse artifact and the suite fails on it. This is the half of the silent-drop
 * guard that actually has teeth against a shape nobody anticipated.
 */
export function suspiciousCommands(dir = WORKFLOW_DIR) {
  const bad = []
  for (const entry of collectCiCommands(dir)) {
    if (/^[|>*&%@`]/.test(entry.command.trim())) {
      bad.push({ file: entry.file, line: entry.runLine, command: entry.command })
    }
  }
  return bad
}

/**
 * Gate-shaped commands written LITERALLY into a local composite action (#3150).
 *
 * The battery reads WORKFLOW_DIR only, so a gate factored into
 * `.github/actions/<path>/action.yml` would be absent from every builder's battery
 * with nothing to say so — the same silent drop this file exists to stop, one
 * directory over. A gate does not belong in an action file at all: nothing a
 * builder runs can discover it there. So this refuses one outright rather than
 * resolving `uses:` back to the calling workflows to ask whether it is
 * PR-triggered.
 *
 * WHAT IT DOES NOT CATCH, and the reason it is not "green because the one
 * action holds nothing gate-shaped": a gate whose IDENTITY is a `with:` input.
 * The single action in the tree, `advisory-gate-comment`, runs
 * `node "${{ inputs.script }}" --out="…"`, with the script path passed in from
 * `docs-coupling.yml` and `design-system-coupling.yml` — it is the advisory
 * half of BOTH coupling pairs. Every rule and every shield entry begins with a
 * LITERAL head (`npm run lint:`, `node scripts/`, `node --test `), and
 * `node "${{ …` is not one of them, so the command matches nothing. Note what
 * this is NOT: a templated ARGUMENT is caught normally —
 * `node scripts/docs/coupling-gate.mjs --strict --out="${{ inputs.out }}"` is
 * reported, because its head is still literal. Only head-templating hides.
 * Factoring a gate that same parameterised way would slip past. Catching it
 * means flagging the existing action, which is legitimate, so the hole is
 * WRITTEN DOWN rather than guarded — the same disposition the gate map gives
 * `working-directory:`.
 *
 * It DOES walk nested action directories (`.github/actions/gates/strict/`),
 * which GitHub resolves as `uses: ./.github/actions/gates/strict`.
 *
 * There is no `notGates` escape hatch: an action holding CI PLUMBING that
 * happens to be gate-shaped reddens too. That is the safe direction, and the
 * remedy the failure names is to move it into a workflow, where the map can
 * argue it like everything else.
 *
 * Returns `{ file, line, command }` rows; empty is the passing state.
 */
export function compositeActionGates(dir = ACTIONS_DIR) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    // ENOENT is a legitimate empty state: a tree with no composite actions.
    // Anything else — EACCES, ENOTDIR, a typo'd PREFLIGHT_ACTIONS_DIR — means
    // the guard CANNOT LOOK, and a check that passes when it cannot look is the
    // exact defect this file exists to remove. Fail loud instead.
    if (err?.code === 'ENOENT') return []
    throw err
  }
  const rows = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      rows.push(
        ...compositeActionGates(child).map((r) => ({ ...r, file: `${entry.name}/${r.file}` })),
      )
      continue
    }
    if (entry.name !== 'action.yml' && entry.name !== 'action.yaml') continue
    // No catch here, and the asymmetry with readdirSync above is deliberate:
    // there, ENOENT means the tree has no composite actions. HERE the directory
    // walk just told us this file exists, so an ENOENT (a dangling symlink) or
    // an EACCES means the guard cannot read a file it can SEE. Same rule as
    // above — fail rather than pass when you cannot look.
    for (const cmd of parseWorkflowCommands(child, readFileSync(child, 'utf8'))) {
      const shaped =
        GATE_RULES.some((r) => r.test(cmd.command)) ||
        GATE_SHAPED_ANYWHERE.some((r) => r.test(cmd.command))
      if (shaped) rows.push({ file: entry.name, line: cmd.runLine, command: cmd.command })
    }
  }
  return rows
}

/** Every command across every PR-triggered workflow. */
export function collectCiCommands(dir = WORKFLOW_DIR) {
  const all = []
  for (const file of workflowFiles(dir)) {
    const yaml = readFileSync(file, 'utf8')
    if (!isPullRequestTriggered(yaml)) continue
    all.push(...parseWorkflow(file, yaml).commands)
  }
  return all
}

export function loadGateMap(mapPath = GATE_MAP_PATH) {
  return JSON.parse(readFileSync(mapPath, 'utf8'))
}

/**
 * Commands that are gates BY SHAPE, and need no entry in the map.
 *
 * The rules carry the mechanical majority so the map stays small enough to
 * argue with. They are also what makes the battery pick up a NEW gate for free:
 * add `npm run lint:whatever` to a workflow and it is in the next builder's
 * battery without anyone editing a list — which is the defect #3150 is about,
 * solved rather than re-created one entry at a time.
 *
 * Anything these rules do not recognise falls through to the map, and the
 * sibling test fails when it is in neither.
 *
 * Each rule also carries the gate's CLASS (#4175), so a new workflow command
 * gets a class the same way it gets gate status, with no second list:
 *
 * - `static`: a ratchet or lint that reads the tree and runs no test suite, no
 *   compiler and no build. Seconds each, and they run first.
 * - `suite`: everything else — `node --test`, `test -w`, a lint's `:test`
 *   self-test, `typecheck -w`, `build -w`.
 *
 * The npm script NAME is not the test: `lint:network-pins` is
 * `node --test scripts/network-map-pins.test.mjs`. A command whose rule gives
 * the wrong class is corrected in `preflight-gates.json` → `gateClasses`, and
 * `preflight.test.mjs` resolves every static gate down to the files it runs
 * and fails when a piece names a test runner, compiler or build, when a file
 * imports `node:test` or vitest, or when a file's child-process call names one
 * (`spawnSync('npx', ['vitest', …])`). A runner reached any other way — a name
 * built at runtime, a further script the file runs — is not seen.
 *
 * Order matters for the class only: it is the class of the FIRST rule that
 * matches, which is why each `:test` rule sits above its general rule.
 */
export const GATE_RULE_TABLE = Object.freeze([
  // A lint's own self-test (`lint:deps:test` → `node --test …`).
  Object.freeze({ rule: /^npm run lint:[a-z:-]+:test$/, kind: 'suite' }),
  Object.freeze({ rule: /^npm run lint:[a-z:-]+$/, kind: 'static' }),
  Object.freeze({ rule: /^npm run check:[a-z:-]+$/, kind: 'static' }),
  Object.freeze({ rule: /^npm run docs:check$/, kind: 'static' }),
  Object.freeze({ rule: /^npm run typecheck -w packages\/[a-z-]+$/, kind: 'suite' }),
  Object.freeze({ rule: /^npm run test -w packages\/[a-z-]+$/, kind: 'suite' }),
  // A targeted single-file run (`-- src/openapi/spec.test.ts`), which CI does
  // ahead of the full suite for fast feedback. A gate in its own right.
  Object.freeze({ rule: /^npm run test -w packages\/[a-z-]+ -- [\w./-]+$/, kind: 'suite' }),
  Object.freeze({ rule: /^npm run build -w packages\/[a-z-]+$/, kind: 'suite' }),
  Object.freeze({ rule: /^npm run design:lint -w packages\/frontend$/, kind: 'static' }),
  Object.freeze({ rule: /^npm run visual:baselines:test$/, kind: 'suite' }),
  // The inventory reads the committed PNGs; it compares nothing.
  Object.freeze({ rule: /^npm run visual:baselines$/, kind: 'static' }),
  // No `$` or backtick: an interpolated path (`node --test scripts/$WHICH.test.mjs`)
  // would otherwise classify as a gate and the battery would RUN it with the
  // variable unexpanded — worse than dropping it, because it fails for a reason
  // that has nothing to do with the diff. Excluded here, it falls through to
  // GATE_SHAPED_ANYWHERE and lands in the drift check instead.
  Object.freeze({ rule: /^node --test [^|><&;$`]+$/, kind: 'suite' }),
  Object.freeze({ rule: /^node scripts\/docs\/coupling-gate\.mjs --strict --out=\/dev\/null$/, kind: 'static' }),
  Object.freeze({ rule: /^node scripts\/docs\/[a-z-]+\.mjs$/, kind: 'static' }),
  Object.freeze({ rule: /^node scripts\/frontend-copy-lint\.mjs$/, kind: 'static' }),
  Object.freeze({ rule: /^node scripts\/workspace-pin-lint\.mjs$/, kind: 'static' }),
  Object.freeze({
    rule: /^node packages\/frontend\/scripts\/design-system-coupling\.mjs --strict --out=\/dev\/null$/,
    kind: 'static',
  }),
])

export const GATE_CLASSES = Object.freeze(['static', 'suite'])

/** The patterns alone, for every caller that only asks "is this a gate". */
export const GATE_RULES = Object.freeze(GATE_RULE_TABLE.map((r) => r.rule))

/**
 * Commands that are NOT gates by shape.
 *
 * SHELL SYNTAX IS NOT ON THIS LIST, and that is the whole design. A
 * `/[|><`$()]/` rule used to be, and it was the silent path every escape took:
 * review found a gate hidden behind an env prefix, then behind `echo … && …`,
 * then behind `|| …` and `| xargs …`, then behind an interpolated argument on
 * four of the battery's own gates — including the strict coupling gate, which
 * two of the four incidents were about. Four rounds, four instances, one class.
 *
 * Each was patched by enumerating something: separators, then gate shapes. Both
 * lists are un-enumerable, so both races were lost in advance. The fix is to
 * stop enumerating: a metacharacter alone never silences a command. What
 * remains here is structural — shell KEYWORDS (a line opening with `if`/`fi`
 * runs no gate), and `gh`, which by definition acts on a pull request that does
 * not exist at pre-push time.
 *
 * Measured cost over the corpus before landing: exactly ONE command was
 * silenced by the metacharacter rule alone — `db-concurrency-proof.yml`'s
 * `node -e "…"` block — and it now argues its case in the map like everything
 * else. One row, and the class closes on both axes by rule rather than by list.
 */
export const NOT_GATE_RULES = Object.freeze([
  /^(if|fi|else|for|while|case|esac|echo|set|export|return|exit|\})/,
  /^gh /,
  /^[A-Z_]+=/,
])

/**
 * The backend harness's own signal that it ran without a database.
 *
 * Exported and case-insensitive so the coupling is CHECKABLE: a test asserts
 * this matches the literal string in `db-harness.ts`, because a reword there
 * would otherwise make this detector silently stop detecting — a silent skip
 * inside the guard against silent skips. Case-insensitive also catches the
 * end-of-run banner, which #1763 made the authoritative signal and which shouts
 * in caps.
 */
export const DB_SKIP_MARKER = /real-DB suites SKIPPED/i

/**
 * Cap on the output a gate may emit before the harness stops reading it.
 *
 * Node's default `maxBuffer` for `spawnSync`/`execFile*` is 1 MiB, and the
 * battery PIPES every gate's stdout/stderr (it has to — the run matches gates'
 * output for the real-DB skip marker and prints tails on failure), so a gate
 * whose own output exceeds 1 MiB was killed mid-suite: the backend suite
 * prints ~1.47 MB and preflight reported it red while the same command run
 * directly passed (#3954). 64 MiB — the value the `git diff`/`status` reads in
 * `changedSurfaces` already use — is far above any real suite's chatter but
 * still bounded, so a runaway gate cannot balloon memory without limit.
 */
export const GATE_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Shapes that LOOK like a gate, anywhere in a line — the shield.
 *
 * Deliberately COARSER than GATE_RULES, and deliberately a separate list. The
 * two have opposite jobs: GATE_RULES must be PRECISE, because a match there
 * means the battery RUNS the command; this must be GENEROUS, because a match
 * here only means a human looks. One list cannot be both.
 *
 * That was learned twice. First there were two lists and they DRIFTED — four
 * gates existed in GATE_RULES with no counterpart here, so
 * `BASE_SHA=abc node scripts/docs/coupling-gate.mjs --strict` was silenced, the
 * strict contract-doc gate among them. Then the shield was derived from
 * GATE_RULES to stop the drift, and inherited its precision: `node --test
 * $FILE` stopped being shielded because that rule excludes `$` on purpose, so
 * the battery would never RUN an unexpanded variable. Deriving traded a drift
 * for a narrowing.
 *
 * So: two lists, and the COUPLING IS MACHINE-CHECKED instead. `preflight.test.mjs`
 * asserts every GATE_RULES entry's literal head is matched by something here, so
 * a rule added without a shield fails the build. Drift closed without making one
 * list do both jobs.
 *
 * Namespace-level on purpose: `npm run docs:audit` is not a gate today, and the
 * point is that a future one wrapped in a prefix still reaches a human rather
 * than the silent path.
 */
export const GATE_SHAPED_ANYWHERE = Object.freeze([
  /npm run (lint|check|docs|design|typecheck|test|build|visual):/,
  /npm run (typecheck|test|build) -w /,
  /node --test /,
  /node scripts\//,
  /node packages\/frontend\/scripts\//,
])

/**
 * The literal prefix of a regex source — everything before its first
 * metacharacter, with escapes resolved.
 *
 * `^npm run lint:[a-z:-]+$` → `npm run lint:`. Exported because the test that
 * pins the GATE_RULES/shield coupling needs exactly this: the shortest string
 * that must still look gate-shaped, so a rule whose head no shield matches
 * fails the build instead of silently losing its prefix-wrapped form.
 */
export function literalHead(source) {
  let out = ''
  for (let i = source.startsWith('^') ? 1 : 0; i < source.length; i += 1) {
    const c = source[i]
    if (c === '\\') {
      i += 1
      out += source[i] ?? ''
      continue
    }
    if ('[](){}*+?|.^$'.includes(c)) break
    out += c
  }
  return out
}

/** `gate`, `not-a-gate`, or `unclassified` — the last one is what fails the test. */
export function classifyCommand(command, map) {
  if (command in (map.notGates ?? {})) return 'not-a-gate'
  if (GATE_RULES.some((r) => r.test(command))) return 'gate'
  // Before the silent path: a gate-shaped head that no rule matched is a gate
  // someone has to look at, not something to drop.
  // A gate ANYWHERE in the line, not just at its head or in a `&&`/`;` segment.
  //
  // This started as a head test, then grew a segment split on `&&`/`;`, and
  // review found a new separator each round: an env prefix, then `echo … && …`,
  // then `… || …` and `… | xargs …`. Every one was the same class — a gate the
  // line really runs, hidden from the head by one more piece of shell — and
  // patching separators one at a time was losing that race, because the set of
  // ways to put a command somewhere other than first is not enumerable.
  //
  // So the test is now positional-free: if a gate-shaped command appears
  // anywhere in the line and no rule claimed the whole line as a gate, a human
  // decides. Enumerated over the corpus before landing: exactly ONE command
  // flips to `unclassified` under it, and it is prose — a `gh issue` body that
  // quotes a repro command — which now has its own map row saying so. That is
  // the price of closing the class instead of its instances.
  if (GATE_SHAPED_ANYWHERE.some((r) => r.test(command))) return 'unclassified'
  if (NOT_GATE_RULES.some((r) => r.test(command))) return 'not-a-gate'
  return 'unclassified'
}

/**
 * `static` or `suite` for a gate, or `null` for a command that is not one.
 *
 * The map's `gateClasses` row wins, then the class of the first GATE_RULE_TABLE
 * rule that matches — the same precedence `classifyCommand` gives `notGates`.
 */
export function gateClass(command, map) {
  const rows = map.gateClasses ?? {}
  if (Object.hasOwn(rows, command)) return rows[command].class
  return GATE_RULE_TABLE.find((r) => r.rule.test(command))?.kind ?? null
}

/**
 * The battery's plan: one entry per distinct LOCAL command, with every CI job
 * that runs it and the union of the surfaces those jobs gate on.
 *
 * Deduplicated because `lint:next-steps` appears in four jobs and a builder
 * needs to run it once — but the four jobs are all named in the plan, so the
 * output still says which contexts a failure would redden.
 *
 * Static entries come first, each group in the order the workflow files give
 * it (#4175). Workflow order interleaves them: `lint:retired-rail-prose` was
 * entry 40 of 77 under `--all`, after the SDK, CLI and core suites, so PR #4155
 * found its retired-rail hit only at the end of a full battery.
 */
export function buildPlan({ dir = WORKFLOW_DIR, mapPath = GATE_MAP_PATH } = {}) {
  const map = loadGateMap(mapPath)
  const commands = collectCiCommands(dir)
  const plan = new Map()
  for (const entry of commands) {
    if (classifyCommand(entry.command, map) !== 'gate') continue
    const existing = plan.get(entry.command) ?? {
      command: entry.command,
      kind: gateClass(entry.command, map),
      jobs: [],
      surfaces: [],
      alwaysRuns: false,
    }
    if (entry.jobDisplay && !existing.jobs.includes(entry.jobDisplay)) {
      existing.jobs.push(entry.jobDisplay)
    }
    if (entry.surfaceGate === null) existing.alwaysRuns = true
    else for (const s of entry.surfaceGate) if (!existing.surfaces.includes(s)) existing.surfaces.push(s)
    plan.set(entry.command, existing)
  }
  const entries = [...plan.values()]
  return [...entries.filter((g) => g.kind === 'static'), ...entries.filter((g) => g.kind !== 'static')]
}

/** Which surfaces the working tree's diff touches, by CI's own classifier. */
export function changedSurfaces(base) {
  const files = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: GATE_OUTPUT_MAX_BUFFER,
  })
    .split('\n')
    .filter((f) => f.trim() !== '')
  // Uncommitted work counts: the battery runs BEFORE the commit as often as
  // after it, and a gate that only sees committed files would miss the change
  // the builder is about to push.
  // `--porcelain -z` rather than the line form: the line form quotes a path
  // containing a space and renders a rename as `old -> new`, so a naive
  // `slice(3)` yields a quoted string or a two-paths-in-one string and the
  // surface classifier sees a file that does not exist. `-z` emits the raw
  // path, and a rename emits BOTH paths as separate NUL-terminated fields —
  // the new one first, then the old — which is what we want: a rename touches
  // two surfaces.
  const dirty = execFileSync('git', ['status', '--porcelain', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: GATE_OUTPUT_MAX_BUFFER,
  })
    .split('\0')
    .map((entry) => (/^[ MADRCU?!]{2} /.test(entry) ? entry.slice(3) : entry))
    .filter((f) => f.trim() !== '')
  const outputs = classifyChangedFiles([...new Set([...files, ...dirty])])
  return Object.entries(outputs)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
}

/** The plan narrowed to what this diff can actually redden. */
export function selectGates(plan, surfaces) {
  return plan.filter((g) => g.alwaysRuns || g.surfaces.some((s) => surfaces.includes(s)))
}

/**
 * Run one gate, from the repository root, with the environment as-is.
 *
 * NOT with CI's `BASE_SHA`/`HEAD_SHA`. The two strict coupling gates take them
 * in CI (`docs-coupling.yml`, `design-system-coupling.yml`) and compute the pull
 * request's exact three-dot range; without them they fall back to
 * `origin/dev...HEAD` PLUS the working tree. That is a different mode, and the
 * difference is deliberate in the gate rather than an oversight here: the local
 * mode is BROADER, because a committed-only range reports a clean bill of health
 * for an uncommitted diff — the false green that let #1076's contract-doc
 * failure reach CI. Setting the variables to make the modes match would trade
 * the broader check for the narrower one, in a battery whose whole purpose is to
 * catch things before the commit.
 *
 * So preflight-green on a coupling gate is a slightly STRONGER claim than CI's,
 * not a weaker one — but it is not the identical claim, and AGENTS.md says so.
 *
 * `--base` does not reach these gates either — they compare against
 * `origin/dev` whatever base the surface selection used.
 *
 * It runs workflow-authored strings locally with `shell: true`. That is the
 * point — these are the commands CI runs — but it is worth naming: checking out
 * a branch and running the battery executes whatever that branch's workflow
 * files say. CI would run them on that branch anyway, so the battery adds no
 * reach a push does not already have; it does move the moment of execution to
 * before the push.
 *
 * `working-directory:` is discarded for the same reason it is not read: no gate
 * in the corpus carries one today (every live use sits on an excluded
 * command), and a gate that did would be run from the root. Written down
 * rather than guarded.
 *
 * Output is captured (not inherited) because the battery matches gate output
 * for the real-DB skip marker and prints a tail per red gate — so the child
 * must be given a generous `maxBuffer` (GATE_OUTPUT_MAX_BUFFER), not the
 * 1 MiB default that killed a verbose backend suite mid-run (#3954).
 */
export function runGate(gate, { maxBuffer = GATE_OUTPUT_MAX_BUFFER } = {}) {
  const result = spawnSync(gate.command, {
    cwd: ROOT,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer,
  })
  return {
    ...gate,
    ok: result.status === 0,
    status: result.status,
    // Set when the gate was ENDED by a signal instead of exiting (`status` is
    // then null). SIGTERM counts as timeout-shaped: see `isTimeoutShaped`.
    signal: result.signal ?? null,
    // `ENOBUFS` when the output passed `maxBuffer`: spawnSync then kills the
    // gate with SIGTERM itself, which must not read as a timeout.
    error: result.error?.code ?? null,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd(),
  }
}

/**
 * Exit codes. `RED_UNDER_LOAD` is the only red that a re-run alone turned green
 * (#4175). It is NOT a pass, and it is non-zero on purpose: #4126 and #4134
 * were real defects (a cold import inside a timed test body) that showed only
 * under load, so a forgiven red must stay visible. The summary prints the list
 * for the PR body. Per captain decision on #4171's spec review.
 */
export const EXIT = Object.freeze({ GREEN: 0, RED: 1, USAGE: 2, RED_UNDER_LOAD: 3 })

/**
 * Output that means a test ran out of time, pinned from the runners' own text.
 *
 * - vitest (`@vitest/runner` 3.2.4, `chunk-hooks.js`): `Test timed out in
 *   5000ms.` for a test, `Hook timed out in 10000ms.` for a hook;
 * - vitest's worker RPC (`vitest/dist/chunks/rpc.*.js`): `[vitest-worker]:
 *   Timeout calling "onTaskUpdate"`. Only `onTaskUpdate`: a `fetch` or
 *   `transform` RPC timeout is module loading, not a timed test;
 * - `node --test` (Node 24), a per-test `{ timeout }` or `--test-timeout`:
 *   `'test timed out after 120000ms'`;
 * - `node --test`, the runner cancelled by SIGTERM: it prints `Interrupted
 *   while running:` on a line of its own, lists the files in flight and exits 1;
 * - the gate's own shell ended by SIGTERM (`runGate`'s `signal`), which prints
 *   nothing at all.
 *
 * `preflight.test.mjs` produces the `node --test` and shell shapes LIVE through
 * `runGate`, so a Node release that rewords one reddens the suite rather than
 * silently disabling the re-run. vitest is not installed where that suite runs
 * (`ci_config_checks` has no workspace install), so its strings are pinned as
 * fixtures copied from the installed dist, with the version above.
 *
 * Not a shape: `signal: 'SIGTERM'` in a file's failure details. Only the TAP
 * reporter prints it; the default (spec) reporter that the battery's pipes get
 * on Node 24 prints a bare `'test failed'` for that file, which says nothing.
 */
export const TIMEOUT_SHAPES = Object.freeze([
  /\bTest timed out in \d+ms\b/,
  /\bHook timed out in \d+ms\b/,
  /Timeout calling "onTaskUpdate"/,
  /\btest timed out after \d+ms\b/,
  /^Interrupted while running:$/m,
])

/**
 * Output that makes a red a red whatever the load, even beside a timeout.
 *
 * An assertion failure (`AssertionError` is how both `node:assert` and vitest's
 * `expect` report one), a module that does not resolve, and a missing file —
 * which is what an unbuilt `dist` looks like. A state or ordering failure
 * reports through one of these too. A gate whose output carries any of them is
 * never re-run, so none of them is ever attributed to load.
 *
 * What stays out: a plain `Error` or `TypeError` thrown NEXT TO a timeout (an
 * `afterAll` that tears down what a timed-out `beforeAll` never built is the
 * common one). Such a gate can be re-run, and if it is green alone it lands in
 * the "timed out, green alone" group with exit 3, never in a pass.
 */
export const NEVER_LOAD_SHAPES = Object.freeze([
  /\bAssertionError\b/,
  /\bERR_ASSERTION\b/,
  /\bERR_MODULE_NOT_FOUND\b/,
  /\bCannot find (?:module|package)\b/,
  /\bFailed to (?:resolve|load)\b/,
  /\bENOENT\b/,
])

/** A red whose output says it ran out of time, and says nothing else. */
export function isTimeoutShaped(result) {
  if (result.ok) return false
  // spawnSync's own SIGTERM for output past `maxBuffer` (#3954's shape).
  if (result.error === 'ENOBUFS') return false
  const output = result.output ?? ''
  if (NEVER_LOAD_SHAPES.some((r) => r.test(output))) return false
  return result.signal === 'SIGTERM' || TIMEOUT_SHAPES.some((r) => r.test(output))
}

/**
 * The 1-minute load average and the CPU count, read immediately BEFORE a gate
 * starts. Evidence only: the reading is recorded and printed beside a re-run
 * gate, and it decides nothing (#4191).
 *
 * It used to gate the re-run (`load > cpus`), and that missed the reds it
 * existed for: on 2026-10-20 three timeout-shaped reds started at 11.78, 9.36
 * and 9.18 on 12 CPUs, none was re-run, and the battery exited 1 over reds that
 * were green by hand. A reading before the start mostly carries the decaying
 * tail of the PREVIOUS gate, and it does not predict the contention during the
 * run: a vitest suite that starts at 9 on 12 cores passes its core count once
 * its own pool spins up. A reading at the end would mostly measure that gate's
 * own workers, so neither end is a predictor. `ops-probe-standalone.test.ts`
 * measured the same thing from the other side: sibling vitest workers, not the
 * load average, are what slows a timed test.
 *
 * Platform: `os.loadavg()` is `[0, 0, 0]` on Windows, and `os.cpus()` can be
 * empty in some containers. Neither matters now that the reading gates
 * nothing; it prints as `0.00 on N CPU(s)`.
 */
export function readMachineLoad() {
  return { load: loadavg()[0], cpus: cpus().length }
}

/**
 * Run the selected gates in order, then re-run the timeout-shaped reds alone.
 *
 * Exported, with the runner, the load reader and the clock injected, so
 * `preflight.test.mjs` drives it with no real gate and no real load.
 *
 * A gate is queued for a re-run when it is red and its output is
 * timeout-shaped (`isTimeoutShaped`), whatever the load (#4191). A red that is
 * not timeout-shaped is never queued, at any load. After the LAST selected
 * gate, each queued gate runs once more, by itself. The load is read before
 * every attempt, re-runs included, and both readings are kept and printed as
 * evidence; neither decides anything (`readMachineLoad`). "Alone" means alone
 * in this battery: other agents on the machine still run.
 *
 * Why no load condition: the cost of a looser predicate is bounded by the exit
 * code. A re-run that is green alone exits `EXIT.RED_UNDER_LOAD` (3), never 0,
 * so a forgiven red stays visible; a timeout that recurs alone is red (1). The
 * price is one extra run of a gate that times out for real.
 *
 * The groups:
 * - `red`: red, not queued;
 * - `redAlone`: queued, red again on the re-run. Red;
 * - `greenAlone`: queued, green on the re-run. Exit `EXIT.RED_UNDER_LOAD`.
 *
 * The real-DB skip marker (`DB_SKIP_MARKER`) is read from the run whose verdict
 * counts: the RE-RUN's output for a re-run gate, the original output for every
 * other gate. A green-alone gate whose re-run skipped the database is flagged;
 * one whose first, timed-out run printed the banner but whose re-run did not is
 * not.
 */
export function runBattery(
  gates,
  { run = runGate, readLoad = readMachineLoad, now = Date.now, onStart = () => {}, onResult = () => {} } = {},
) {
  const attempt = (gate, phase) => {
    onStart(gate, phase)
    const sample = readLoad()
    const started = now()
    const result = run(gate)
    const seconds = ((now() - started) / 1000).toFixed(1)
    const attempted = { ...result, phase, seconds, load: sample.load, cpus: sample.cpus }
    onResult(attempted)
    return attempted
  }

  const results = []
  for (const gate of gates) {
    const first = attempt(gate, 'first')
    const queued = !first.ok && isTimeoutShaped(first)
    results.push({ gate, ...first, queued, rerun: null })
  }
  for (const entry of results) {
    if (entry.queued) entry.rerun = attempt(entry.gate, 'rerun')
  }

  const red = results.filter((r) => !r.ok && !r.queued)
  const redAlone = results.filter((r) => r.queued && !r.rerun.ok)
  const greenAlone = results.filter((r) => r.queued && r.rerun.ok)
  const skippedDb = results.filter((r) => DB_SKIP_MARKER.test((r.rerun ?? r).output ?? ''))
  let code = EXIT.GREEN
  if (red.length > 0 || redAlone.length > 0) code = EXIT.RED
  else if (greenAlone.length > 0) code = EXIT.RED_UNDER_LOAD
  return { code, results, red, redAlone, greenAlone, skippedDb }
}

const describeLoad = (attempted) => `${attempted.load.toFixed(2)} on ${attempted.cpus} CPU(s)`

const NAMES_A_TEST = /\bFAIL\b|^\s*not ok\b|^\s*✖/

/**
 * The first run's own evidence for a green-alone gate: each line that matches
 * a TIMEOUT_SHAPE, preceded by the nearest `FAIL` / `not ok` / `✖` line above
 * it, which names the test. With no such line (a shell ended by SIGTERM prints
 * nothing) it falls back to the last few lines. Bounded either way, so the
 * re-run's green does not erase what the timed-out run said.
 */
export function timeoutEvidence(output, { maxLines = 8, tailLines = 5, maxWidth = 200 } = {}) {
  const lines = (output ?? '').split('\n')
  const perLine = TIMEOUT_SHAPES.map((r) => new RegExp(r.source, r.flags.replace('m', '')))
  const picked = []
  for (let i = 0; i < lines.length; i += 1) {
    if (!perLine.some((r) => r.test(lines[i]))) continue
    let j = i - 1
    while (j >= 0 && !NAMES_A_TEST.test(lines[j])) j -= 1
    if (j >= 0 && !picked.includes(j)) picked.push(j)
    if (!picked.includes(i)) picked.push(i)
  }
  const chosen = picked.length > 0 ? picked.map((i) => lines[i]) : lines.filter((l) => l.trim() !== '').slice(-tailLines)
  if (chosen.length === 0) return ['(no output)']
  return chosen.slice(0, maxLines).map((l) => (l.length > maxWidth ? `${l.slice(0, maxWidth)}…` : l))
}

/**
 * The end-of-run summary as `{ out, err }` line arrays, so the test reads the
 * text the builder reads.
 */
export function summarize({ code, results, red, redAlone, greenAlone, skippedDb }, { staticOnly = false } = {}) {
  const out = []
  const err = []
  const tail = (output) => (output ?? '').split('\n').slice(-25).join('\n')

  if (red.length > 0 || redAlone.length > 0) {
    err.push(`\n✗ ${red.length + redAlone.length} of ${results.length} gate(s) red:\n`)
    for (const f of red) {
      err.push(`── ${f.command}  → reddens: ${f.jobs.join(', ')}`)
      if (f.error === 'ENOBUFS') {
        err.push(
          '   ENOBUFS: its output passed GATE_OUTPUT_MAX_BUFFER and spawnSync killed it with\n' +
            '   SIGTERM. Not a timeout and not re-run: the gate may well be green (#3954).',
        )
      } else if (f.error) {
        err.push(`   spawn error: ${f.error}`)
      }
      err.push(tail(f.output))
      err.push('')
    }
    for (const f of redAlone) {
      err.push(
        `── ${f.command}  → reddens: ${f.jobs.join(', ')}\n` +
          `   red at load ${describeLoad(f)}, red alone at load ${describeLoad(f.rerun)}`,
      )
      err.push(tail(f.rerun.output))
      err.push('')
    }
  } else if (greenAlone.length === 0) {
    out.push(
      staticOnly
        ? `\n✓ ${results.length} static gate(s) green (static only: no suite ran).`
        : `\n✓ ${results.length} gate(s) green.`,
    )
  }

  if (greenAlone.length > 0) {
    err.push(
      `\n! ${greenAlone.length} gate(s) timed out, green alone (exit ${EXIT.RED_UNDER_LOAD}, not a pass).\n` +
        '! Each was timeout-shaped and red, then green re-run by itself; the loads are\n' +
        '! evidence, not the reason it was re-run. Investigate before you quote it: open\n' +
        '! the timed-out test and look for work inside the timed body that is slow only\n' +
        '! under contention. #4126 and #4134 were real defects of this shape (a cold\n' +
        '! import inside a timed test). If it is not plainly load, file an issue and\n' +
        '! link it next to this list in the PR body. Do not re-run until green.',
    )
    for (const g of greenAlone) {
      err.push(`!   ${g.command}  red at load ${describeLoad(g)}, green alone at load ${describeLoad(g.rerun)}`)
      for (const line of timeoutEvidence(g.output)) err.push(`!       ${line}`)
    }
  }

  // A green run that skipped the data layer must not read as an unqualified
  // green. With no database reachable and `HAVEN_SKIP_DB_TESTS=1` set, the
  // backend suite degrades to a narrowed run and exits 0 with a banner
  // hundreds of lines above the summary (#1763) — so a builder would see
  // `✓ N gate(s) green` from a battery that proved nothing about the data
  // layer. This issue's own defect shape, one layer in.
  //
  // MEASURED, not inferred from the environment. An earlier revision read
  // `process.env.HAVEN_SKIP_DB_TESTS` and claimed the files "did NOT run",
  // which is false whenever a database IS up: `decideDbMode` returns `run`
  // when the DB is available regardless of the acknowledgement, which
  // `db-availability.ts` calls "deliberately powerless". The gate's own OUTPUT
  // is the only thing that knows what happened, and `runGate` captures stdout
  // and stderr together — the harness prints this marker on stderr, and the
  // end-of-run banner shouts it in caps, so the match is case-insensitive to
  // catch whichever arrives. `runBattery` picks WHICH output: the re-run's for
  // a re-run gate.
  if (code !== EXIT.RED && skippedDb.length > 0) {
    const lines = [
      `\n! ${skippedDb.length} gate(s) reported "real-DB suites SKIPPED" — no database\n` +
        '! was reachable and HAVEN_SKIP_DB_TESTS accepted a narrowed run. Those\n' +
        '! real-DB files did not execute; CI has a database and will run them.\n' +
        '! `docker compose up -d postgres`, then re-run, before calling this green.',
      ...skippedDb.map((r) => `!   ${r.command}`),
    ]
    ;(code === EXIT.GREEN ? out : err).push(...lines)
  }
  return { out, err }
}

const FLAGS = Object.freeze({
  '--all': 'all',
  '--list': 'list',
  '--static': 'static',
  '--verify-ruleset': 'verifyRuleset',
  '--help': 'help',
  '-h': 'help',
})

/**
 * Parse argv, refusing anything it does not know.
 *
 * Refusing, not ignoring: `--statc --list` used to run the default plan and
 * exit 0, so a typo of a narrowing flag ran a different battery from the one
 * the builder asked for and said nothing. Returns `{ opts }` or `{ error }`.
 */
export function parseArgs(argv) {
  const opts = { all: false, list: false, static: false, verifyRuleset: false, help: false, base: 'origin/dev' }
  for (const arg of argv) {
    if (Object.hasOwn(FLAGS, arg)) {
      opts[FLAGS[arg]] = true
    } else if (arg.startsWith('--base=')) {
      const ref = arg.slice('--base='.length)
      if (ref === '') return { error: '--base= needs a ref, e.g. --base=origin/dev' }
      opts.base = ref
    } else {
      return { error: `unknown argument: ${arg}` }
    }
  }
  return { opts }
}

export function usage() {
  return [
    'usage: node scripts/ci/preflight.mjs [--all] [--static] [--list] [--base=<ref>] [--verify-ruleset]',
    '',
    '  --all             run every gate, not just the ones your diff can redden',
    '  --static          run only the static ratchets the diff selects (with --all: every one), then stop',
    '  --list            print the plan and exit 0 without running anything',
    '  --base=<ref>      diff against <ref> instead of origin/dev',
    '  --verify-ruleset  additionally compare against the live branch ruleset (needs gh)',
    '',
    'Static gates run first. A timeout-shaped red is re-run alone after the last gate,',
    'at any load; the load before each run is printed as evidence only.',
    '',
    `exit ${EXIT.GREEN}  every gate green`,
    `exit ${EXIT.RED}  a gate is red`,
    `exit ${EXIT.USAGE}  a usage error: an unknown argument, or --base= with no ref`,
    `exit ${EXIT.RED_UNDER_LOAD}  the only reds timed out and were green alone. Not a pass, and not`,
    '        a reason to re-run until green: open the timed-out test and look for work in',
    '        the timed body that is slow only under contention (#4126 and #4134 were real',
    '        defects of this shape). If it is not plainly load, file an issue and link it',
    '        next to the printed list you quote in the PR body.',
    '',
    'Pass flags after `--` (`npm run preflight -- --static`). Without it npm keeps',
    'the flag for itself and preflight refuses to run (exit 2).',
  ].join('\n')
}

/**
 * Preflight flags npm kept for itself.
 *
 * `npm run preflight --static`, without `--`, does not pass `--static` on: npm
 * reads it as its own config and exports `npm_config_static=true`, and the
 * battery would run the FULL plan. Measured with `npm run env --static`.
 */
export function npmSwallowedFlags(env) {
  return ['all', 'list', 'static', 'base', 'verify_ruleset']
    .filter((name) => env[`npm_config_${name}`] !== undefined)
    .map((name) => (name === 'base' ? `--base=${env.npm_config_base}` : `--${name.replace('_', '-')}`))
}

async function main(argv) {
  const swallowed = npmSwallowedFlags(process.env)
  if (swallowed.length > 0) {
    console.error(
      `preflight: npm kept ${swallowed.join(', ')} for itself and did not pass it on.\n` +
        `preflight: put flags after \`--\`: npm run preflight -- ${swallowed.join(' ')}\n\n${usage()}`,
    )
    return EXIT.USAGE
  }
  const parsed = parseArgs(argv)
  if (parsed.error) {
    console.error(`preflight: ${parsed.error}\n\n${usage()}`)
    return EXIT.USAGE
  }
  const { opts } = parsed
  if (opts.help) {
    console.log(usage())
    return EXIT.GREEN
  }

  const plan = buildPlan()
  let selected = plan
  let surfaces = null
  if (!opts.all) {
    surfaces = changedSurfaces(opts.base)
    selected = selectGates(plan, surfaces)
  }
  if (opts.static) selected = selected.filter((g) => g.kind === 'static')

  if (opts.verifyRuleset) reportRulesetComparison(plan)

  console.log(
    `preflight: ${plan.length} gate(s) known, ${selected.length} selected${opts.static ? ' (static only)' : ''}`,
  )
  if (surfaces) console.log(`preflight: surfaces touched vs ${opts.base}: ${surfaces.join(', ') || '(none)'}`)
  console.log('')

  if (opts.list) {
    for (const g of selected) {
      const where = g.alwaysRuns ? 'always' : g.surfaces.join('/')
      console.log(`  ${g.command}`)
      console.log(`      ${g.kind} · ${where} — ${g.jobs.join(', ')}`)
    }
    return EXIT.GREEN
  }

  let announcedRerun = false
  const outcome = runBattery(selected, {
    onStart: (gate, phase) => {
      if (phase === 'rerun' && !announcedRerun) {
        announcedRerun = true
        console.log('\npreflight: re-running the timeout-shaped reds alone:')
      }
      // TTY only: `\r` does not overwrite in a pipe, so a redirected run would
      // carry a duplicate half-line for every gate.
      if (process.stdout.isTTY) process.stdout.write(`  … ${gate.command}\r`)
    },
    onResult: (r) => {
      const mark = r.ok ? '✓' : '✗'
      const alone = r.phase === 'rerun' ? ', alone' : ''
      console.log(`  ${mark} ${r.command}  (${r.seconds}s, load ${describeLoad(r)}${alone})`)
    },
  })
  const { out, err } = summarize(outcome, { staticOnly: opts.static })
  for (const line of out) console.log(line)
  for (const line of err) console.error(line)
  return outcome.code
}

/**
 * Compare the battery's job coverage against the live branch ruleset.
 *
 * Opt-in, and LOUD when it cannot run. A required context this battery has no
 * gate for is the #3150 failure in its purest form, but a missing `gh` must
 * never read as a pass — that is the same silent skip the issue is about.
 */
function reportRulesetComparison(plan) {
  const probe = spawnSync('gh', ['--version'], { encoding: 'utf8' })
  if (probe.error || probe.status !== 0) {
    console.error('preflight: --verify-ruleset SKIPPED — `gh` is not available here.')
    console.error('preflight: this is not a pass. The workflow-derived check in')
    console.error('preflight: scripts/ci/preflight.test.mjs is the one that always runs.')
    return
  }
  const res = spawnSync(
    'gh',
    [
      'api',
      'repos/d-hinders/Haven-AI/rules/branches/dev',
      '--jq',
      '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]',
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) {
    console.error(`preflight: --verify-ruleset SKIPPED — gh api failed: ${(res.stderr ?? '').trim()}`)
    console.error('preflight: this is not a pass.')
    return
  }
  const required = JSON.parse(res.stdout)
  const covered = new Set(plan.flatMap((g) => g.jobs))
  const uncovered = required.filter((c) => !covered.has(c))
  console.error(`preflight: ruleset requires ${required.length} context(s); ${uncovered.length} have no local gate:`)
  for (const c of uncovered) console.error(`preflight:   ${c}`)
  console.error(
    'preflight: NOTE — a context counts as covered when ANY command in its job is a\n' +
      'preflight: runnable gate, which is weaker than it sounds. `Design visual regression`\n' +
      "preflight: reads covered on the strength of a `build -w packages/core` step while its\n" +
      'preflight: blocking step (`test:visual`) is excluded. Read this as a floor.',
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`preflight: ${error.message}`)
      process.exit(1)
    })
}
