#!/usr/bin/env node
// CI change classifier (#1622, epic #1621).
//
// Decides which CI jobs a diff needs to run. This program used to be 164 lines
// of inline `bash` in the `changes` job of .github/workflows/ci.yml, where it
// had zero direct tests: the only way to exercise a routing rule was to push a
// commit touching the right file and read the job graph. #1206 records a test
// suite that consequently ran NOWHERE for months, and #1030 records a
// money-path safeguard that was simply wrong without anyone noticing. Routing
// logic that decides whether a guard runs is exactly the logic that must not
// be untestable.
//
// The contract with ci.yml is the TEN output names below, emitted as
// `name=value` lines. Nothing here decides what a job does with a flag; this
// only answers "was this surface touched, or does something it depends on
// force it true".
//
// Deliberately dependency-free (no npm ci, no YAML parser) so the `changes`
// job stays a bare checkout, and so its self-test can run in the
// `ci_config_checks` job alongside the other repo-config guards.
//
//   node scripts/ci/change-classifier.mjs                      # git-derived, from BASE_SHA/HEAD_SHA
//   node scripts/ci/change-classifier.mjs --files-from list.txt
//   git diff --name-only dev | node scripts/ci/change-classifier.mjs --files-from -

import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The output contract with ci.yml, in emission order.
 *
 * These names are consumed as `needs.changes.outputs.<name>` by downstream
 * jobs and as required-check gating. Renaming one silently disables whatever
 * job reads it, so change-classifier.test.mjs pins this list against the
 * `outputs:` block of the workflow itself.
 */
export const OUTPUT_NAMES = Object.freeze([
  'code',
  'frontend',
  'backend',
  'sdk',
  'connect',
  'mcp',
  'mcp_server',
  'signer',
  'cli',
  'full',
])

/** git reports an absent base (a branch's first push) as the all-zero SHA. */
export const ZERO_SHA = '0'.repeat(40)

/**
 * Translate one POSIX `case` pattern to a RegExp.
 *
 * The patterns below came from a shell `case`, and shell `case` globs are NOT
 * path-aware: `*` matches `/` like any other character, which is why
 * `packages/frontend/*` matches the whole subtree rather than one level of it.
 * Reproducing that exactly matters more than reproducing a prettier glob
 * dialect — the point of this extraction is that routing does not change.
 *
 * Only `*` and `?` are supported. Bracket expressions are rejected rather than
 * mis-handled: the epic asks for exact paths before glob semantics, so a
 * pattern needing more than this should be spelled out instead.
 */
export function globToRegExp(pattern) {
  if (pattern.includes('[') || pattern.includes(']')) {
    throw new Error(`unsupported bracket expression in pattern: ${pattern}`)
  }
  let source = ''
  for (const ch of pattern) {
    if (ch === '*') source += '.*'
    else if (ch === '?') source += '.'
    else source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

const matchesAny = (patterns, file) => patterns.some((p) => globToRegExp(p).test(file))

/**
 * Paths that are documentation-only and route nowhere.
 *
 * Checked BEFORE the surface rules and skipping the file entirely, mirroring
 * the shell's `continue`.
 */
export const DOC_ONLY_PATTERNS = Object.freeze(['*.md', 'docs/*', 'AGENTS.md', 'LICENSE', 'LICENSE.*'])

/**
 * Markdown that is NOT documentation-only.
 *
 * CLAUDE.md mirrors backend contracts (the API surface table and the chain
 * registry) that packages/backend/src/docs-drift pins. A CLAUDE.md-only edit
 * must therefore run the backend suite even though it is Markdown — otherwise
 * the drift test never guards it. This arm wins over `*.md` because the shell
 * `case` it came from takes the first matching arm.
 */
export const DOC_EXCEPTIONS = Object.freeze([{ patterns: ['CLAUDE.md'], surfaces: ['code', 'backend'] }])

/**
 * The root-guard ownership manifest: which job owns each guard that lives
 * outside the tree it polices (#1624).
 *
 * Read from .github/ rather than declared here because it is repo-governance
 * data, like money-path-globs.json and CODEOWNERS beside it — the question
 * "who owns this guard" outlives whichever program is currently asking it.
 * Parsed with JSON.parse to keep this file dependency-free.
 */
export const ROOT_GUARD_MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'root-guard-ownership.json',
)

/** @type {{path: string, jobs: string[], runsVia: string[], reason: string}[]} */
export const ROOT_GUARDS = Object.freeze(
  JSON.parse(readFileSync(ROOT_GUARD_MANIFEST_PATH, 'utf8')).guards,
)

/**
 * One routing rule per manifest entry.
 *
 * `code` is added to every entry's jobs because it is not a job — it is the
 * "some code changed at all" flag every surface rule sets. Keeping it out of
 * the manifest keeps that file about ownership.
 */
export const ROOT_GUARD_RULES = Object.freeze(
  ROOT_GUARDS.map((guard) => ({
    patterns: [guard.path],
    surfaces: ['code', ...guard.jobs],
  })),
)

/**
 * Surface rules, first match wins (shell `case` semantics).
 *
 * The cross-surface arms are the interesting ones: a guard that lives outside
 * packages/ but polices a package must trigger that package's job, or a PR
 * that only weakens the guard goes green with the guard never running. Those
 * arms are now generated from the manifest above.
 */
export const SURFACE_RULES = Object.freeze([
  {
    // Workflow and root build config can change any job's behaviour, so they
    // force the full matrix rather than a surface.
    patterns: [
      '.github/workflows/*.yml',
      '.github/workflows/*.yaml',
      'package.json',
      'package-lock.json',
      'tsconfig*.json',
    ],
    surfaces: ['code', 'full'],
  },
  // The guards that live outside the tree they police, one rule per entry in
  // .github/root-guard-ownership.json (#1624). These were four hand-written
  // arms; the ownership is data now, and the manifest is the only place it is
  // decided. Position in this list does not matter — every guard path is exact
  // and none collides with another rule — but they stay here so the routing
  // order reads the same as it did.
  ...ROOT_GUARD_RULES,
  { patterns: ['packages/frontend/*'], surfaces: ['code', 'frontend'] },
  { patterns: ['packages/backend/*'], surfaces: ['code', 'backend'] },
  { patterns: ['packages/sdk/*'], surfaces: ['code', 'sdk'] },
  { patterns: ['packages/connect/*'], surfaces: ['code', 'connect'] },
  { patterns: ['packages/mcp/*'], surfaces: ['code', 'mcp'] },
  { patterns: ['packages/mcp-server/*'], surfaces: ['code', 'mcp_server'] },
  { patterns: ['packages/signer/*'], surfaces: ['code', 'signer'] },
  { patterns: ['packages/cli/*'], surfaces: ['code', 'cli'] },
  {
    // Any other workspace — including packages/core, the shared kernel that
    // backend and frontend both consume — is not individually routed, so it
    // forces the full matrix.
    patterns: ['packages/*'],
    surfaces: ['code', 'full'],
  },
])

/**
 * The package dependency table: which workspace packages consume which
 * (#1625). Read from .github/ for the same reason as the guard manifest —
 * repo-governance data, dependency-free to parse.
 */
export const PACKAGE_DEPENDENCY_TABLE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.github',
  'package-dependencies.json',
)

/** @type {Record<string, {dependsOn: string[], note?: string}>} */
export const PACKAGE_DEPENDENCIES = Object.freeze(
  JSON.parse(readFileSync(PACKAGE_DEPENDENCY_TABLE_PATH, 'utf8')).packages,
)

/** Job flags that name a package with a CI job of its own, in table order. */
export const PACKAGE_JOBS = Object.freeze(Object.keys(PACKAGE_DEPENDENCIES))

/**
 * Every job that must re-run when `pkg` changes — its dependents, transitively.
 *
 * The table records only DIRECT dependencies, because that is what package.json
 * declares and therefore the only thing that can be checked against reality.
 * The closure is computed here so a chain (a -> b -> c) can never be half
 * expanded in the data, which is the failure mode of pre-expanded fan-out
 * lists: they look right until someone inserts a link in the middle.
 *
 * Exported for tests; cycles are impossible in a package graph and would hang
 * a naive walk, so this one tracks what it has seen.
 */
export function dependentsOf(pkg, table = PACKAGE_DEPENDENCIES) {
  const found = new Set()
  const queue = [pkg]
  while (queue.length) {
    const current = queue.shift()
    for (const [name, entry] of Object.entries(table)) {
      if (!entry.dependsOn.includes(current)) continue
      if (found.has(name)) continue
      found.add(name)
      queue.push(name)
    }
  }
  found.delete(pkg)
  return [...found]
}

/**
 * Fan-out applied after every file has been classified, in order.
 *
 * Derived from the dependency table rather than hand-written. `full` is not a
 * package and not a dependency — it is the directive "run everything", so it
 * fans out to every job the table names, and stays a separate concept from the
 * per-package rules that follow.
 *
 * Order is still part of the contract: `full` first, so the package rules that
 * follow see the flags it set.
 */
export const PROPAGATION_RULES = Object.freeze([
  { when: ['full'], then: [...PACKAGE_JOBS] },
  ...PACKAGE_JOBS.map((pkg) => ({ when: [pkg], then: dependentsOf(pkg) })).filter(
    (rule) => rule.then.length > 0,
  ),
])

/** All ten flags false. */
const noSurfaces = () => Object.fromEntries(OUTPUT_NAMES.map((name) => [name, false]))

/** All ten flags true — what `workflow_dispatch` forces. */
export function allSurfaces() {
  return Object.fromEntries(OUTPUT_NAMES.map((name) => [name, true]))
}

/**
 * Classify an explicit list of changed paths into the ten output flags.
 *
 * `propagationRules` is a seam for tests, not a runtime knob — CI always uses
 * the default. It exists so the characterization matrix can ask "would any
 * fixture actually notice if this propagation rule were deleted?", which is a
 * question you cannot answer from outside without re-implementing the fan-out
 * and thereby testing the copy instead of the original (#1623).
 *
 * @param {string[]} files repo-root-relative paths, as `git diff --name-only` emits them
 * @param {{propagationRules?: typeof PROPAGATION_RULES}} [options]
 * @returns {Record<string, boolean>} every name in OUTPUT_NAMES, always present
 */
export function classifyChangedFiles(files, { propagationRules = PROPAGATION_RULES } = {}) {
  const outputs = noSurfaces()
  const set = (surfaces) => {
    for (const surface of surfaces) {
      if (!(surface in outputs)) throw new Error(`rule names unknown surface: ${surface}`)
      outputs[surface] = true
    }
  }

  for (const raw of files) {
    const file = raw.trim()
    if (!file) continue

    const exception = DOC_EXCEPTIONS.find((rule) => matchesAny(rule.patterns, file))
    if (exception) {
      // Sets its surfaces and then falls through to the surface rules, exactly
      // as the shell arm did by not calling `continue`.
      set(exception.surfaces)
    } else if (matchesAny(DOC_ONLY_PATTERNS, file)) {
      continue
    }

    const rule = SURFACE_RULES.find((r) => matchesAny(r.patterns, file))
    if (rule) set(rule.surfaces)
  }

  for (const { when, then } of propagationRules) {
    if (when.some((name) => outputs[name])) set(then)
  }

  return outputs
}

/**
 * The git command that produces the changed-file list.
 *
 * An absent or all-zero base SHA means there is nothing to diff against — a
 * branch's first push, or a workflow event that carries no `before` — so the
 * whole tree at HEAD counts as changed. That is the conservative direction:
 * everything runs.
 *
 * KNOWN GAP, preserved deliberately: `core.quotepath` defaults to true, so git
 * emits a path containing non-ASCII or control characters in quoted, escaped
 * form (`"packages/frontend/caf\303\251.ts"`). The quotes are part of the
 * string, so it matches no rule and the file routes NOWHERE — in this script
 * and in the inline shell it replaces, identically. Fixing it means reading a
 * NUL-delimited list (`-z`), which is a behaviour CHANGE and so belongs in a
 * slice that is not "extraction with behaviour held fixed". Tracked as #1638.
 */
export function changedFilesCommand({ baseSha, headSha }) {
  if (baseSha && baseSha !== ZERO_SHA) return ['diff', '--name-only', baseSha, headSha]
  return ['ls-tree', '-r', '--name-only', headSha]
}

/**
 * Render the flags as GITHUB_OUTPUT lines.
 *
 * The value domain is closed to booleans, which is what makes this injection-proof:
 * GITHUB_OUTPUT is parsed line by line, so a value carrying a newline could
 * forge additional outputs. Nothing here is caller-controlled text, and this
 * throws rather than emitting anything that is not `true`/`false` so it cannot
 * quietly become caller-controlled later.
 */
export function formatGithubOutput(outputs) {
  return (
    OUTPUT_NAMES.map((name) => {
      const value = outputs[name]
      if (typeof value !== 'boolean') {
        throw new Error(`output ${name} must be a boolean, got ${JSON.stringify(value)}`)
      }
      return `${name}=${value}`
    }).join('\n') + '\n'
  )
}

function readFileList(source) {
  const raw = source === '-' ? readFileSync(0, 'utf8') : readFileSync(source, 'utf8')
  return raw.split('\n')
}

function main(argv) {
  const filesFrom = argv.indexOf('--files-from')

  let outputs
  if (process.env.EVENT_NAME === 'workflow_dispatch') {
    // A manual run is an explicit "test everything" request.
    outputs = allSurfaces()
    console.error('change-classifier: workflow_dispatch — forcing every surface true')
  } else {
    const files =
      filesFrom !== -1
        ? readFileList(argv[filesFrom + 1])
        : execFileSync(
            'git',
            changedFilesCommand({ baseSha: process.env.BASE_SHA, headSha: process.env.HEAD_SHA }),
            {
              encoding: 'utf8',
              // Roughly three orders of magnitude above the whole tree's worth
              // of path text, so a legitimate diff cannot hit it; a list that
              // did would be a bug worth failing on rather than truncating.
              maxBuffer: 64 * 1024 * 1024,
              // Let git's own warnings reach the job log. The inline shell this
              // replaced streamed them for free; the default 'pipe' would
              // swallow them on the success path.
              stdio: ['ignore', 'pipe', 'inherit'],
            },
          ).split('\n')
    outputs = classifyChangedFiles(files)
    console.error(`change-classifier: ${files.filter((f) => f.trim()).length} changed path(s)`)
  }

  const rendered = formatGithubOutput(outputs)
  console.error(rendered.trimEnd())

  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, rendered)
  else process.stdout.write(rendered)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`change-classifier: ${error.message}`)
    process.exit(1)
  }
}
