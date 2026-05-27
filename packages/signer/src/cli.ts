#!/usr/bin/env node

import { runSignerStdioServer, type SignerOptions } from './server.js'

function parseArgs(argv: string[]): SignerOptions {
  const options: SignerOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--credentials' || arg === '--credentials-path') {
      options.credentialsPath = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Haven edge signer (local, holds the delegate key)',
          '',
          'Runs a local stdio MCP server exposing sign-only tools (haven_sign,',
          'haven_x402_sign_header). Pair it with the hosted, keyless Haven MCP',
          'server: the hosted server constructs and relays, this one signs.',
          '',
          'Usage:',
          '  npx @haven_ai/signer --credentials /path/to/agent.json',
          '',
          'Options:',
          '  --credentials <path>   Haven credential JSON (delegate_key is read from it).',
          '                         Also supported: HAVEN_CREDENTIALS, or HAVEN_DELEGATE_KEY.',
          '',
        ].join('\n'),
      )
      process.exit(0)
    }
  }
  return options
}

async function main(): Promise<void> {
  await runSignerStdioServer(parseArgs(process.argv.slice(2)))
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
