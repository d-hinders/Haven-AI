/**
 * #4791 — the LOCAL `tools/list` contract golden.
 *
 * The hosted server has had this net since #3817
 * (`packages/mcp-server/src/tool-contract-snapshot.test.ts`): its tool
 * contract — names, input schemas, descriptions — can change in a release
 * without anything noticing it as a contract change, so a committed golden
 * turns such a change into a reviewed diff. This package, the one `latest`
 * resolves to for a bare `npx @haven_ai/mcp`, had no counterpart: its 20 tools
 * all live in `tools.ts`, and a change to any of them was an ordinary line.
 *
 * `local-tool-contract.golden.json` holds the `tools/list` payload CAPTURED
 * THROUGH THE MCP SDK the way a client receives it (`InMemoryTransport` +
 * `client.listTools()`), not `toolSchemas` read back out: serialization is
 * part of the contract, and a zod or MCP SDK bump can change it.
 *
 * Three deliberate choices:
 *
 * - The server is built with `buildMcpServer(haven)`, never
 *   `createHavenMcpServer`: the latter reads the credential file and the
 *   consent sidecar. Listing tools makes no network call, so the client's key
 *   and base URL are dummies.
 * - The golden holds `tools/list` ONLY — name, description, input schema. No
 *   `serverInfo`, no version: the release bump rewrites `MCP_VERSION` on every
 *   cut, and a golden that included it would go red on every release.
 * - The file is NOT named `tools-list.snapshot.json`. That basename is the
 *   hosted golden's, and `scripts/ci/check-stale-client-compat.mjs` and the
 *   release skill refer to the hosted file by it.
 *
 * Regenerate after an intended contract change:
 *
 *   npm run snapshot:regen -w packages/mcp
 *
 * Review the resulting diff as a contract change, not a test-fixture chore.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { HavenClient } from '@haven_ai/sdk'
import { buildMcpServer, MCP_VERSION } from './server.js'
import { toolSchemas } from './tools.js'

const GOLDEN_URL = new URL('./local-tool-contract.golden.json', import.meta.url)
const REGEN_ENV = 'UPDATE_LOCAL_TOOL_CONTRACT'
const REGEN_CMD = 'npm run snapshot:regen -w packages/mcp'

const GOLDEN_COMMENT =
  'The local @haven_ai/mcp tools/list contract exactly as a client receives it ' +
  '(InMemoryTransport + client.listTools(), see local-tool-contract.test.ts). ' +
  `Regenerate after an intended contract change: ${REGEN_CMD}.`

type ListedTool = { name: string; description?: string; inputSchema: unknown }
type Golden = { comment: string; tools: Record<string, { description?: string; inputSchema: unknown }> }

/** Capture `tools/list` through a real transport, exactly as a client would. */
async function captureToolsList(): Promise<ListedTool[]> {
  const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://127.0.0.1:9' })
  const server = buildMcpServer(haven)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'local-tool-contract', version: '0.0.0' })
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const { tools } = await client.listTools()
    return tools as ListedTool[]
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
}

function goldenFromTools(tools: ListedTool[]): Golden {
  const out: Golden['tools'] = {}
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    out[tool.name] = { description: tool.description, inputSchema: tool.inputSchema }
  }
  return { comment: GOLDEN_COMMENT, tools: out }
}

function readGolden(): Golden {
  return JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as Golden
}

describe('#4791 — the local tools/list contract golden', () => {
  it('the live tools/list equals the committed golden', async () => {
    const tools = await captureToolsList()
    // A listing that came back empty must never be able to match anything.
    expect(tools.length).toBeGreaterThan(0)

    const live = goldenFromTools(tools)
    if (process.env[REGEN_ENV] === '1') {
      writeFileSync(GOLDEN_URL, `${JSON.stringify(live, null, 2)}\n`)
      return
    }

    expect(
      live,
      `the local tools/list contract changed. If that is intended, regenerate with: ${REGEN_CMD} — ` +
        'and review the diff as a contract change.',
    ).toEqual(readGolden())
  })

  it('the golden names exactly the tools the package registers', () => {
    // The registry is the other witness: a tool that exists but is never
    // registered (or the reverse) is caught here by name, not by a deep diff.
    const golden = readGolden()
    const goldenNames = Object.keys(golden.tools).sort()
    expect(goldenNames.length).toBeGreaterThan(0)
    expect(goldenNames).toEqual(Object.keys(toolSchemas).sort())
  })

  it('the golden carries tools/list only — nothing a release bump rewrites', () => {
    // `release-bump.mjs` rewrites MCP_VERSION on every cut. The golden must
    // not hold it, the server name, or any other serverInfo field.
    const golden = readGolden()
    expect(Object.keys(golden).sort()).toEqual(['comment', 'tools'])
    for (const [name, tool] of Object.entries(golden.tools)) {
      expect(Object.keys(tool).sort(), name).toEqual(['description', 'inputSchema'])
    }
    // And no description or schema quotes the version in passing.
    expect(readFileSync(GOLDEN_URL, 'utf8')).not.toContain(MCP_VERSION)
  })
})
