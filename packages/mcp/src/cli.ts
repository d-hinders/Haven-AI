#!/usr/bin/env node

import { runStdioServer } from './server.js'

function parseArgs(argv: string[]): { credentialsPath?: string } {
  const options: { credentialsPath?: string } = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--credentials' || arg === '--credentials-path') {
      options.credentialsPath = argv[i + 1]
      i += 1
    } else if (arg === '--transport') {
      const transport = argv[i + 1]
      i += 1
      if (transport !== 'stdio') {
        throw new Error('Only local stdio transport is supported. Haven does not provide a remote MCP signer mode.')
      }
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Haven MCP server',
        '',
        'Usage:',
        '  npx @haven_ai/mcp --credentials /path/to/agent.json',
        '',
        'Options:',
        '  --credentials <path>       Haven credential JSON file. Also supported: HAVEN_CREDENTIALS.',
        '  --transport stdio          Local stdio transport. This is the only supported mode.',
        '',
      ].join('\n'))
      process.exit(0)
    }
  }
  return options
}

async function main(): Promise<void> {
  await runStdioServer(parseArgs(process.argv.slice(2)))
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
