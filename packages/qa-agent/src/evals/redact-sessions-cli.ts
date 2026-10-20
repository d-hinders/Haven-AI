/**
 * CLI entry for the session-transcript redactor (#4137): run by the
 * agent-evals workflow's "Redact the session transcripts" step as
 * `npm run evals:redact -w packages/qa-agent -- …`.
 *
 *   --in-prefix=<base>   the adapter's log base (QA_EVAL_CLAUDE_CODE_SESSION_LOG)
 *   --stage=<dir>        staging directory (must be empty or absent)
 *   --out=<dir>          upload directory (must be empty or absent)
 *   --required=A,B,…     secret env names that must be set, or nothing is written
 *   --optional=C,D,…     secret env names redacted only when set
 *
 * Secret VALUES come from the environment only, never from an argument.
 * Exit 0 only when every file was redacted, scanned clean and moved; `clean`
 * goes to $GITHUB_OUTPUT either way.
 */

import { runRedaction } from './redact-sessions.js'

function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length)
}

const names = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

async function main(): Promise<number> {
  const inPrefix = flag('in-prefix')
  const stageDir = flag('stage')
  const outDir = flag('out')
  if (!inPrefix || !stageDir || !outDir) {
    console.error('::error::redact-sessions: --in-prefix, --stage and --out are required')
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import('node:fs/promises')
      await appendFile(process.env.GITHUB_OUTPUT, 'clean=false\n')
    }
    return 1
  }
  const result = await runRedaction({
    inPrefix,
    stageDir,
    outDir,
    required: names(flag('required')),
    optional: names(flag('optional')),
    env: process.env,
    githubOutput: process.env.GITHUB_OUTPUT || undefined,
  })
  return result.clean ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  async (err: unknown) => {
    // Never print the error object: a stack could quote file content.
    console.error(`::error::redact-sessions crashed (${err instanceof Error ? err.name : 'unknown'}); nothing uploaded`)
    process.exit(1)
  },
)
