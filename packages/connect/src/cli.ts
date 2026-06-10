#!/usr/bin/env node

import { helpText, parseArgs } from './args.js'
import { runConnect } from './runtime.js'

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    process.stdout.write(`${helpText()}\n`)
    return
  }
  await runConnect(parsed.options)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
