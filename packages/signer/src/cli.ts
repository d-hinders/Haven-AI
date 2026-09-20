#!/usr/bin/env node

import { parseSignerArgs } from './cli-args.js'
import { runSignerStdioServer } from './server.js'

async function main(): Promise<void> {
  const decision = parseSignerArgs(process.argv.slice(2))
  if (decision.kind === 'help') {
    process.stdout.write(decision.text)
    process.exit(0)
  }
  if (decision.kind === 'unknown-option') {
    process.stderr.write(`${decision.text}\n`)
    process.exit(2)
  }
  await runSignerStdioServer(decision.options)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
