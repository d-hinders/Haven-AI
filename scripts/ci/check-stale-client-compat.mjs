#!/usr/bin/env node
// Stale-client tool-contract check (#3817).
//
// The hosted MCP's tool contract can change in a release without anything
// announcing it — 0.9.0-alpha.0 (#3739) added method/headers/body to the
// haven_quote_x402 → haven_pay_x402_quote handoff and made payment_required
// optional, and a client connected before the deploy refused the first three
// and required the fourth. This check makes such a change VISIBLE at PR time:
//
//   - every `next_arguments` the branch emits (the committed corpus,
//     `packages/mcp-server/src/next-arguments-corpus.json`) is validated
//     against `origin/main`'s snapshot schema (`tools-list.snapshot.json`)
//     for the tool it names — `additionalProperties: false` plus `required`,
//     plus the enum/pattern the stale client holds. Any failure means a
//     client connected to the last deploy cannot make that call.
//   - a tool or property the branch removes/renames is flagged the same way:
//     a stale client still sends it and the strict hosted tool refuses it.
//     A narrowed `enum`/`pattern` flags too (precedent: the #3172 hash
//     `pattern` change); a widened one does not, and neither does a purely
//     additive optional field no emission carries, nor a description-only
//     change.
//
// ADVISORY BY DESIGN: a contract change is legitimate, it only needs
// announcing. The script writes to the mcp_server_checks JOB SUMMARY and
// exits 0 whether or not it reports; it exits non-zero only when it is
// itself broken. Until the first promotion publishes a snapshot to main, it
// prints a notice and skips. Its logic is the sibling
// check-stale-client-compat.test.mjs's job.
//
// Dependency-free like everything in this directory: the stale-client
// contract is the TOP-LEVEL keys (required + additionalProperties + the
// property-level enum/pattern), which is what a client's strict validation
// refuses; nested values are validated downstream by the SDK, not here.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SNAPSHOT_REL = 'packages/mcp-server/src/tools-list.snapshot.json'
const CORPUS_REL = 'packages/mcp-server/src/next-arguments-corpus.json'

/** Resolve a repo-relative path against this script's location (scripts/ci/). */
function repoRoot(rel) {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', rel)
}

/** The flat stale-client rule: nothing undeclared, everything required. */
export function flatSchemaViolations(args, schema) {
  const violations = []
  const props = schema?.properties ?? {}
  if (schema?.additionalProperties === false) {
    for (const key of Object.keys(args ?? {})) {
      if (!(key in props)) {
        violations.push(`\`${key}\` is not in the stale client's schema (it refuses undeclared input)`)
        continue
      }
      const prop = props[key]
      if (Array.isArray(prop?.enum) && !prop.enum.includes(args[key])) {
        violations.push(`\`${key}\` value is outside the stale client's enum [${prop.enum.join(', ')}]`)
      }
      if (typeof prop?.pattern === 'string' && typeof args[key] === 'string' && !new RegExp(prop.pattern).test(args[key])) {
        violations.push(`\`${key}\` value does not match the stale client's pattern ${prop.pattern}`)
      }
    }
  }
  for (const req of schema?.required ?? []) {
    if (!(req in (args ?? {}))) {
      violations.push(`required \`${req}\` is missing (the stale client still requires it)`)
    }
  }
  return violations
}

/**
 * The whole check, pure. Returns `{ reports, notice }` — `reports` are the
 * reconnect-required findings (empty = silent), `notice` a skip reason.
 */
export function checkStaleClientCompat({ baseSnapshot, branchSnapshot, corpus }) {
  if (!baseSnapshot || typeof baseSnapshot !== 'object' || !baseSnapshot.tools) {
    return {
      reports: [],
      notice:
        '`origin/main` carries no tools/list snapshot yet — the stale-client check starts on the first promotion that publishes one.',
    }
  }
  const baseTools = baseSnapshot.tools
  const branchTools = branchSnapshot?.tools ?? {}
  const reports = []

  // Half 1 of #3739: the branch emits fields a stale client's schema refuses.
  // Half 2: the branch omits a field the stale client's schema still requires.
  const entries = corpus?.entries ?? []
  for (const entry of entries) {
    const base = baseTools[entry.tool]
    if (!base) {
      reports.push(`\`${entry.tool}\` is new or renamed — a client connected to the last deploy does not have it (emitted at: ${entry.site})`)
      continue
    }
    const violations = flatSchemaViolations(entry.arguments, base.inputSchema)
    if (violations.length > 0) {
      reports.push(
        `emission at ${entry.site} does not fit the schema a client connected to the last deploy holds for \`${entry.tool}\`: ${violations.join('; ')} — reconnect required`,
      )
    }
  }

  // Removed or renamed tool: the stale client lists it, the server refuses it.
  for (const name of Object.keys(baseTools)) {
    if (!branchTools[name]) {
      reports.push(`tool \`${name}\` was removed or renamed — stale clients still list it and their calls to it are refused — reconnect required`)
    }
  }

  // Removed or renamed property, and narrowed constraints, per shared tool.
  for (const [name, base] of Object.entries(baseTools)) {
    const branch = branchTools[name]
    if (!branch) continue
    const baseProps = base.inputSchema?.properties ?? {}
    const branchProps = branch.inputSchema?.properties ?? {}
    for (const prop of Object.keys(baseProps)) {
      if (!(prop in branchProps)) {
        reports.push(
          `property \`${prop}\` of \`${name}\` was removed or renamed — a stale client still sends it and the strict hosted tool refuses it — reconnect required`,
        )
      }
    }
    for (const [prop, baseProp] of Object.entries(baseProps)) {
      const branchProp = branchProps[prop]
      if (!branchProp) continue
      if (Array.isArray(baseProp?.enum) && Array.isArray(branchProp?.enum)) {
        const narrowed = branchProp.enum.every((v) => baseProp.enum.includes(v)) && branchProp.enum.length < baseProp.enum.length
        if (narrowed) {
          reports.push(
            `\`${name}\`.\`${prop}\` enum narrowed to [${branchProp.enum.join(', ')}] — a stale client may send a value the server no longer accepts — reconnect required`,
          )
        }
      }
      if (typeof baseProp?.pattern === 'string' && typeof branchProp?.pattern === 'string' && baseProp.pattern !== branchProp.pattern) {
        reports.push(
          `\`${name}\`.\`${prop}\` pattern changed (${baseProp.pattern} → ${branchProp.pattern}) — a stale client may send a value the server no longer accepts — reconnect required`,
        )
      }
    }
  }

  return { reports, notice: null }
}

function readBaseSnapshot(baseRef) {
  // The job's checkout is fetch-depth 1; main is not there unless fetched.
  if (baseRef.startsWith('origin/')) {
    const slash = baseRef.indexOf('/')
    const remote = baseRef.slice(0, slash)
    const branch = baseRef.slice(slash + 1)
    execFileSync('git', ['fetch', remote, branch, '--depth=1'], { stdio: 'ignore' })
  }
  const text = execFileSync('git', ['show', `${baseRef}:${SNAPSHOT_REL}`], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  return JSON.parse(text)
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function main() {
  const baseRef = argValue(process.argv.slice(2), '--base') ?? 'origin/main'
  console.log('### Stale-client tool-contract check (#3817)')
  console.log('')
  let baseSnapshot
  try {
    baseSnapshot = readBaseSnapshot(baseRef)
  } catch (err) {
    console.log(`> [NOTICE] Could not read ${SNAPSHOT_REL} from ${baseRef} (${String(err.message).split('\n')[0]}). Skipping — the check needs a base snapshot to compare against.`)
    return
  }
  const branchSnapshot = JSON.parse(readFileSync(repoRoot(SNAPSHOT_REL), 'utf8'))
  const corpus = JSON.parse(readFileSync(repoRoot(CORPUS_REL), 'utf8'))

  const { reports, notice } = checkStaleClientCompat({ baseSnapshot, branchSnapshot, corpus })
  if (notice) {
    console.log(`> [NOTICE] ${notice}`)
    return
  }
  const entryCount = corpus?.entries?.length ?? 0
  console.log(`Compared ${entryCount} committed next_arguments emissions and the branch snapshot against \`${baseRef}\`'s snapshot.`)
  console.log('')
  if (reports.length === 0) {
    console.log('**No reconnect-required changes detected.** Description-only and additive-optional changes are silent by design.')
    return
  }
  console.log(`**Reconnect required — ${reports.length} finding(s).** Connected agents holding the last deploy's schema must reconnect after this deploys (how-to: the \`haven-reset\` skill):`)
  console.log('')
  for (const report of reports) console.log(`- ${report}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
