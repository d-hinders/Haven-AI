// Read the one-turn `claude -p --output-format json` result the agent-evals
// workflow captures before the eval slice, and fail with claude's own reason
// when the login does not work (pilot run #5, 2026-10-19: five sessions all
// "claude exited 1" with no stderr and no stated cause).
//
// Prints only the result fields — subtype, is_error, the result text and the
// cost — never the environment or the token.
//
//   node scripts/ci/agent-evals-login-check.mjs <result.json> [<stderr.txt>]

import { readFileSync } from 'node:fs'

/** Judge one captured result. Returns { ok, message }. Exported for the test. */
export function judgeLoginCheck(stdout, stderr = '') {
  const lines = stdout.trim().split('\n').filter(Boolean)
  let result
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && parsed.type === 'result') {
        result = parsed
        break
      }
    } catch {
      // not JSON — keep looking
    }
  }
  if (!result) {
    const tail = stderr.trim().slice(-400) || '(no stderr)'
    return { ok: false, message: `claude printed no result line. stderr: ${tail}` }
  }
  const text = String(result.result ?? '').slice(0, 400)
  const cost = typeof result.total_cost_usd === 'number' ? ` cost=$${result.total_cost_usd}` : ''
  if (result.is_error) {
    return { ok: false, message: `claude login check failed (${result.subtype ?? 'error'}): ${text}${cost}` }
  }
  return { ok: true, message: `claude login check passed (${result.subtype ?? 'success'}): ${text}${cost}` }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [resultPath, stderrPath] = process.argv.slice(2)
  const read = (p) => {
    try {
      return p ? readFileSync(p, 'utf8') : ''
    } catch {
      return ''
    }
  }
  const { ok, message } = judgeLoginCheck(read(resultPath), read(stderrPath))
  if (ok) {
    console.log(message)
  } else {
    console.log(`::error::${message}`)
    process.exit(1)
  }
}
