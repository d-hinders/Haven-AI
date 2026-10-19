// Judge the one-turn `claude -p --output-format json` login check the
// agent-evals workflow runs before the eval slice, and fail with claude's own
// reason when the login does not work (pilot run #5, 2026-10-19: five
// sessions all "claude exited 1" with no stderr and no stated cause).
//
// Prints only the result fields (subtype, is_error, the result text, the
// cost), never the environment or the token. Fails closed: anything other
// than a `success` result with exit code 0 is a failure.
//
//   node scripts/ci/agent-evals-login-check.mjs <result.json> [<stderr.txt>] [<exit-code-file>]

import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Find the `type: 'result'` object in claude's output (one object, an array, or JSON lines). */
function findResult(stdout) {
  const pick = (value) => {
    if (Array.isArray(value)) return [...value].reverse().find((v) => v && v.type === 'result')
    return value && value.type === 'result' ? value : undefined
  }
  try {
    const whole = pick(JSON.parse(stdout))
    if (whole) return whole
  } catch {
    // not one JSON document — fall through to JSON lines
  }
  for (const line of stdout.trim().split('\n').filter(Boolean).reverse()) {
    try {
      const found = pick(JSON.parse(line))
      if (found) return found
    } catch {
      // not JSON — keep looking
    }
  }
  return undefined
}

/** Judge one captured check. Returns { ok, message }. Exported for the test. */
export function judgeLoginCheck(stdout, stderr = '', exitCode = 0) {
  const result = findResult(stdout)
  if (!result) {
    const tail = stderr.trim().slice(-400) || '(no stderr)'
    return { ok: false, message: `claude printed no result (exit ${exitCode}). stderr: ${tail}` }
  }
  const text = String(result.result ?? '').slice(0, 400)
  const cost = typeof result.total_cost_usd === 'number' ? ` cost=$${result.total_cost_usd}` : ''
  const subtype = result.subtype ?? 'unknown'
  if (result.is_error || subtype !== 'success' || exitCode !== 0) {
    return { ok: false, message: `claude login check failed (${subtype}, exit ${exitCode}): ${text}${cost}` }
  }
  return { ok: true, message: `claude login check passed (${subtype}): ${text}${cost}` }
}

const read = (p) => {
  try {
    return p ? readFileSync(p, 'utf8') : ''
  } catch {
    return ''
  }
}

let isMain = false
try {
  isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch {
  isMain = false
}

if (isMain) {
  const [resultPath, stderrPath, exitPath] = process.argv.slice(2)
  const exitText = read(exitPath).trim()
  // A missing exit-code file counts as a failure, not as success.
  const exitCode = exitPath ? (exitText === '' ? -1 : Number(exitText)) : 0
  const { ok, message } = judgeLoginCheck(read(resultPath), read(stderrPath), Number.isNaN(exitCode) ? -1 : exitCode)
  if (ok) {
    console.log(message)
  } else {
    console.log(`::error::${message}`)
    process.exit(1)
  }
}
