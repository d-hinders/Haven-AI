#!/usr/bin/env node
// Shrink-only ratchet over the typed next-step contract (#3104, epic #3105).
//
// Every place a Haven MCP surface tells an agent what to call next must name
// the tool with arguments in that tool's vocabulary, or say why no tool
// follows (`next_tool_omitted_reason`). The three packages reached that state
// through #3100–#3103; this gate keeps them there. The numerator is DEFINED,
// not grepped loosely:
//
//   unnamed — an emission block that carries a `next_action` decision and
//     names neither a tool nor a reason. A block is: a builder call
//     (`buildAgentGuidance(`, `refusalNextStep(`, `signerRefusalStep(`), a
//     `new HostedToolError({` whose literal carries `nextAction:`, a signer
//     `next_action: AgentPaymentNextAction.…` object literal, or a local
//     `nextAction: AgentPaymentNextAction.…` object literal. It is NAMED when
//     the block's OWN top-level keys (comments stripped, nested literals
//     blanked — `topLevelText`) contain `nextTool:`, `nextStep:`,
//     `nextToolOmittedReason:`, `next_tool_omitted_reason:`, a `…Handoff(` /
//     `…Step(` spread, or `nextStepWireFields(`. A handoff must therefore be
//     named at the emission's top level: one placed inside a spread branch or
//     a nested literal reads as unnamed (a false red, never a false green).
//   discovery_without_arguments — a `suggested_tool:` inside a discovery
//     entry literal (one carrying `resource_url:`) with no
//     `suggested_arguments:` (the two discovery maps, decision 4).
//
// The `wrongTool()` failure hints carry the caller's own arguments and are
// outside the numerator by decision 7. Positive control: run it with
// `--root=<a tree at the epic's base 4ed69592>` — both counters are non-zero
// there (44 + 2 across 10 files, quoted in PR #3142's body; 43 under the
// pre-review balanced-block rule — the own-keys rule finds one more in
// plain-http-x402.ts); at the epic's head both are 0 and the
// committed baseline is all zeros, so any regrowth is a new violation.
//
// Baseline shape: `{ "<file>": { unnamed: n, discovery_without_arguments: n } }`
// (scripts/lib/ratchet.mjs). `--update` rewrites it from the scan;
// `--update --accept-new` is the only way to grow it.
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  newViolations,
  hasShrunk,
  writeBaseline,
  loadBaseline,
  updateRefusals,
  ACCEPT_NEW_BASELINE_FLAG,
  firstRunRefusalMessage,
  runGate,
} from './lib/ratchet.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT = join(HERE, '..')
export const BASELINE_PATH = join(HERE, 'lint-next-steps-baseline.json')

/** The surfaces the epic converted; relative to the repo root. */
export const SCAN_TARGETS = [
  'packages/mcp-server/src/tools.ts',
  'packages/mcp-server/src/tools',
  'packages/signer/src/sign-context.ts',
  'packages/signer/src/tools.ts',
  'packages/mcp/src/tools.ts',
]

const BLOCK_OPENERS = [
  /buildAgentGuidance\(\s*\{/g,
  /refusalNextStep\(\s*\{/g,
  /signerRefusalStep\(\s*\{/g,
  /new HostedToolError\(\s*\{/g,
]
const NAMED = /nextTool:|nextStep:|nextToolOmittedReason:|next_tool_omitted_reason:|\.\.\.[A-Za-z]+(Handoff|Step)\(|nextStepWireFields\(/

/** The block with every nested `{…}` blanked, so only the emission's OWN keys are read (a nested `{ nextTool }` elsewhere does not name it). */
export function topLevelText(block) {
  let depth = 0
  let out = ''
  for (const c of block) {
    if (c === '{') {
      depth += 1
      out += depth === 1 ? c : ' '
    } else if (c === '}') {
      out += depth === 1 ? c : ' '
      depth -= 1
    } else out += depth <= 1 ? c : ' '
  }
  return out
}
const DECISION_IN_LITERAL = /(nextAction|next_action):\s*AgentPaymentNextAction\./g

/** Returns the source slice of the balanced `{…}` starting at `open` (index of `{`). */
export function balancedBlock(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const c = source[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return source.slice(open)
}

/** Enclosing `{…}` literal of a match position: walk back to the nearest unmatched `{`. */
function enclosingLiteral(source, at) {
  let depth = 0
  for (let i = at; i >= 0; i -= 1) {
    const c = source[i]
    if (c === '}') depth += 1
    else if (c === '{') {
      if (depth === 0) return balancedBlock(source, i)
      depth -= 1
    }
  }
  return ''
}

/** Comments never name a tool: `/* nextStep: … */` or a `// nextTool:` line must not read as NAMED. */
export function stripComments(source) {
  // A single pass that knows where string literals are, so a `/*` or `//`
  // inside one ('Accept: */*', 'https://…') neither opens nor closes a
  // comment (#3142 review, round 2: the regex version read a `/*` in a string
  // as a comment opener and blanked the emission after it — fail-open).
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (c === '/' && next === '/') {
      let stop = source.indexOf('\n', i)
      if (stop === -1) stop = n
      out += ' '.repeat(stop - i)
      i = stop
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n && source[j] !== c) {
        if (source[j] === '\\') j += 1
        if (c !== '`' && source[j] === '\n') break
        j += 1
      }
      out += source.slice(i, j + 1)
      i = j + 1
    } else {
      out += c
      i += 1
    }
  }
  return out
}

export function scanSource(rawSource) {
  const source = stripComments(rawSource)
  const counts = { unnamed: 0, discovery_without_arguments: 0 }
  const seen = new Set()
  const consider = (block, key) => {
    if (seen.has(key)) return
    seen.add(key)
    if (!NAMED.test(topLevelText(block))) counts.unnamed += 1
  }
  for (const re of BLOCK_OPENERS) {
    for (const m of source.matchAll(re)) {
      const open = m.index + m[0].length - 1
      const block = balancedBlock(source, open)
      // A HostedToolError literal counts only when it carries a next_action decision.
      if (/HostedToolError/.test(m[0]) && !/nextAction:|nextStep:/.test(block)) continue
      consider(block, open)
    }
  }
  // Signer / local decision literals outside the builder family.
  for (const m of source.matchAll(DECISION_IN_LITERAL)) {
    const block = enclosingLiteral(source, m.index)
    const open = source.lastIndexOf('{', m.index)
    if (/buildAgentGuidance|refusalNextStep|signerRefusalStep/.test(source.slice(Math.max(0, open - 40), open))) continue
    consider(block, open)
  }
  // Discovery entries only: a `suggested_tool:` inside a literal that also
  // carries `resource_url:` (the catalog row shape). The failure envelopes'
  // `suggested_tool` hints (errors.ts, the signer) are not discovery and are
  // outside this counter.
  for (const m of source.matchAll(/suggested_tool:/g)) {
    // The entry literal, or — for a hint built in a spread branch — the parent
    // literal the branch is spread into (the one carrying `resource_url:`).
    let block = enclosingLiteral(source, m.index)
    if (!/resource_url:/.test(block)) {
      const open = source.lastIndexOf('{', m.index)
      block = open > 0 ? enclosingLiteral(source, open - 1) : ''
    }
    if (!/resource_url:/.test(block)) continue
    if (!/suggested_arguments:/.test(block)) counts.discovery_without_arguments += 1
  }
  return counts
}

async function listFiles(root, target) {
  const abs = join(root, target)
  try {
    const entries = await readdir(abs, { withFileTypes: true })
    const out = []
    for (const e of entries) {
      const p = join(target, e.name)
      if (e.isDirectory()) out.push(...(await listFiles(root, p)))
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
    }
    return out
  } catch {
    return [target]
  }
}

export async function scan(root = DEFAULT_ROOT) {
  const counts = {}
  for (const target of SCAN_TARGETS) {
    for (const file of await listFiles(root, target)) {
      let source
      try {
        source = await readFile(join(root, file), 'utf8')
      } catch {
        continue
      }
      const c = scanSource(source)
      if (c.unnamed || c.discovery_without_arguments) counts[file] = c
    }
  }
  return counts
}

const REMEDY =
  'A next-step emission names neither a tool nor next_tool_omitted_reason, or a discovery ' +
  'entry carries no suggested_arguments. Name the tool through the builder (a bare action ' +
  'is what the agent cannot follow), or say why no tool follows. Never grow this baseline.'

async function main() {
  const args = process.argv.slice(2)
  const rootFlag = args.find((a) => a.startsWith('--root='))
  const root = rootFlag ? rootFlag.slice('--root='.length) : DEFAULT_ROOT
  const counts = await scan(root)
  const total = Object.values(counts).reduce((n, c) => n + c.unnamed + c.discovery_without_arguments, 0)
  if (args.includes('--update')) {
    const { firstRun, refusal } = updateRefusals(BASELINE_PATH, counts, args.includes(ACCEPT_NEW_BASELINE_FLAG))
    if (refusal) {
      console.error(refusal)
      process.exitCode = 1
      return
    }
    writeBaseline(BASELINE_PATH, counts)
    console.log(`lint:next-steps baseline ${firstRun ? 'initialized' : 'updated'}: ${total} unnamed/argument-less emission(s) across ${Object.keys(counts).length} file(s)`)
    return
  }
  const baseline = loadBaseline(BASELINE_PATH)
  if (baseline === null) {
    console.error(firstRunRefusalMessage(true))
    process.exitCode = 1
    return
  }
  const violations = newViolations(counts, baseline)
  if (violations.length) {
    console.error(`✗ lint:next-steps — ${violations.length} new violation(s):`)
    for (const v of violations) console.error(`  ${v.file} ${v.key}: ${v.count} (baseline allows ${v.allowed})`)
    console.error(`\n${REMEDY}`)
    process.exitCode = 1
    return
  }
  const shrunk = hasShrunk(counts, baseline)
  console.log(`✓ lint:next-steps — every next-step emission names a tool or a reason (${total} allowed by baseline${shrunk ? '; baseline can shrink, run --update' : ''}) at ${relative(process.cwd(), root) || '.'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runGate('lint:next-steps', main)
