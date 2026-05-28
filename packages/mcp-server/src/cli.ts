#!/usr/bin/env node

import { createHostedHttpServer } from './http.js'
import { assertHostedEnv, CustodyError } from './boot.js'

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8788)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`)
  }
  return port
}

function main(): void {
  // Process-level custody guard — refuses to boot if a delegate key was
  // accidentally injected. See boot.ts.
  try {
    assertHostedEnv()
  } catch (err) {
    if (err instanceof CustodyError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(2)
    }
    throw err
  }

  const port = parsePort(process.env.PORT)
  const baseUrl = process.env.HAVEN_API_URL
  const path = process.env.HAVEN_MCP_PATH ?? '/v1'

  const server = createHostedHttpServer({ baseUrl, path })

  server.listen(port, () => {
    process.stdout.write(
      `Haven hosted MCP server listening on :${port}${path} ` +
        `(relaying to ${baseUrl ?? 'http://localhost:3001'})\n`,
    )
  })

  const shutdown = (): void => {
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
