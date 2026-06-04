#!/usr/bin/env node

import { runStdioServer, type HavenMcpServerOptions } from './server.js'

function parseArgs(argv: string[]): HavenMcpServerOptions {
  const options: HavenMcpServerOptions = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--credentials' || arg === '--credentials-path') {
      options.credentialsPath = argv[i + 1]
      i += 1
    } else if (arg === '--identity') {
      options.identityPath = argv[i + 1]
      i += 1
    } else if (arg === '--signer') {
      options.signerPath = argv[i + 1]
      i += 1
    } else if (arg === '--transport') {
      const transport = argv[i + 1]
      i += 1
      if (transport !== 'stdio') {
        throw new Error('Only local stdio transport is supported. Haven does not provide a remote MCP signer mode.')
      }
    } else if (arg === '--ack') {
      // Write the consent-gate acknowledgement next to the credential file
      // and proceed. Used on first-launch to opt the operator in once.
      options.writeAck = true
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Haven MCP server',
        '',
        'Usage:',
        '  npx @haven_ai/mcp --credentials /path/to/agent.json',
        '  npx @haven_ai/mcp --identity /path/to/identity.json --signer /path/to/signer.json',
        '',
        'Options:',
        '  --credentials <path>       Haven credential JSON file. Also supported: HAVEN_CREDENTIALS.',
        '  --identity <path>          Haven identity JSON file written by @haven_ai/connect.',
        '  --signer <path>            Haven signer JSON file written by @haven_ai/connect.',
        '  --transport stdio          Local stdio transport. This is the only supported mode.',
        '  --ack                      Acknowledge the first-launch consent block and write',
        '                             a sidecar acknowledgement file next to the credential.',
        '',
        'Consent:',
        '  On first launch the server prints the tool list and the on-chain',
        '  allowance summary, then refuses to start unless you have acknowledged.',
        '  Acknowledge with EITHER --ack OR HAVEN_MCP_ACK=<hash> in your environment.',
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
