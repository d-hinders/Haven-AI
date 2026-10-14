/**
 * #3817 — the hosted `tools/list` CONTRACT SNAPSHOT and the
 * next-arguments CORPUS behind the stale-client compatibility check.
 *
 * The hosted server's tool contract (names, input schemas, descriptions) can
 * change in a release without anything noticing it as a contract change —
 * 0.9.0-alpha.0 (#3739) did exactly that. Two committed goldens make such a
 * change a reviewed diff:
 *
 * 1. `tools-list.snapshot.json` — the `tools/list` payload CAPTURED THROUGH
 *    THE SDK the way a client receives it (`InMemoryTransport` +
 *    `client.listTools()`, the `server.test.ts` pattern), not the registry
 *    read back out of `toolSchemas`: serialization is part of the contract
 *    (zod or MCP SDK bumps can change it). This test fails when the live
 *    registry differs from the golden.
 *
 * 2. `next-arguments-corpus.json` — every `next_arguments` the server emits
 *    for a HOSTED `next_tool`, the input `scripts/ci/check-stale-client-compat.mjs`
 *    validates against `origin/main`'s snapshot in CI. Refusal and guidance
 *    fixtures (`EMISSION_SITES` / `REFUSAL_SITES`) are the pinned producers —
 *    their characterization tests prove `expect` is what the wire carries —
 *    plus the one success-path handoff no fixture pins: `haven_quote_x402` →
 *    `haven_pay_x402_quote` (`plain-http-x402.ts`'s `payNextArguments`),
 *    captured live through the real handler with every optional input passed.
 *    This test fails when the emissions drift from the golden, so the corpus
 *    can never go stale silently. Signer-role handoffs are deliberately out:
 *    a stale SIGNER is a different skew (the connector-upgrade path), and the
 *    hosted snapshot says nothing about signer tools.
 *
 * Regenerate BOTH after an intended contract change:
 *
 *   npm run snapshot:regen -w packages/mcp-server
 *
 * (or `UPDATE_TOOL_CONTRACT_SNAPSHOT=1 npm run test -w packages/mcp-server --
 * src/tool-contract-snapshot.test.ts`). Review the resulting diff as a
 * contract change, not a test-fixture chore.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { buildHostedMcpServer } from './server.js'
import {
  AGENT_RESPONSE,
  PAYMENT_REQUIRED,
  X402_INTENT_RESPONSE,
  handlers,
  installSharedFixtureLifecycle,
  keylessClient,
  ok,
  stubFetch,
} from './test-support/hosted-mcp.js'
import { EMISSION_SITES, REFUSAL_SITES } from './test-support/next-step-fixtures.js'
import { toolSchemas } from './tools/contracts.js'

const SNAPSHOT_URL = new URL('./tools-list.snapshot.json', import.meta.url)
const CORPUS_URL = new URL('./next-arguments-corpus.json', import.meta.url)
const REGEN_ENV = 'UPDATE_TOOL_CONTRACT_SNAPSHOT'
const REGEN_CMD = 'npm run snapshot:regen -w packages/mcp-server'

const SNAPSHOT_COMMENT =
  'The hosted tools/list contract exactly as a client receives it ' +
  '(InMemoryTransport + client.listTools(), see tool-contract-snapshot.test.ts). ' +
  `Regenerate after an intended contract change: ${REGEN_CMD}.`
const CORPUS_COMMENT =
  'Every next_arguments the hosted server emits for a HOSTED next_tool — the corpus ' +
  'scripts/ci/check-stale-client-compat.mjs validates against origin/main\'s snapshot. ' +
  `Regenerate after an intended contract change: ${REGEN_CMD}. The quote→pay entry's ` +
  'idempotency_key is the placeholder <x402q-uuid>; the live emission is a fresh uuid.'

type CorpusEntry = { site: string; tool: string; arguments: Record<string, unknown> }

/** Capture `tools/list` through a real transport, exactly as server.test.ts does. */
async function captureToolsList(): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
  const server = buildHostedMcpServer(keylessClient())
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'tool-contract-snapshot', version: '0.0.0' })
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const { tools } = await client.listTools()
    return tools as Array<{ name: string; description?: string; inputSchema: unknown }>
  } finally {
    await Promise.allSettled([client.close(), server.close()])
  }
}

function snapshotFromTools(
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>,
): { comment: string; tools: Record<string, { description?: string; inputSchema: unknown }> } {
  const out: Record<string, { description?: string; inputSchema: unknown }> = {}
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    out[tool.name] = { description: tool.description, inputSchema: tool.inputSchema }
  }
  return { comment: SNAPSHOT_COMMENT, tools: out }
}

/**
 * The fixture-pinned half of the corpus: every EMISSION_SITES / REFUSAL_SITES
 * row that names a HOSTED tool with arguments. The characterization tests own
 * the proof that `expect` is what the wire carries; here it is only collected.
 */
function fixtureCorpusEntries(): CorpusEntry[] {
  const sites = [...EMISSION_SITES, ...REFUSAL_SITES] as unknown as ReadonlyArray<{
    site: string
    expect: Record<string, any>
  }>
  return sites
    .filter(
      (f) =>
        typeof f.expect.next_tool_name === 'string' &&
        f.expect.next_tool_server_role === 'hosted' &&
        f.expect.next_arguments !== undefined,
    )
    .map((f) => ({
      site: f.site,
      tool: f.expect.next_tool_name as string,
      arguments: f.expect.next_arguments as Record<string, unknown>,
    }))
}

/**
 * The success-path half: the quote→pay handoff built in plain-http-x402.ts
 * (`payNextArguments` → `taskBudgetNextStep`) appears in no fixture — its
 * fields are conditional, so the capture passes every optional input
 * (method, headers, body), the `plain-http-x402-request-mode.test.ts` shape.
 * The fresh replay key is normalized to a placeholder so the golden is stable.
 */
const QUOTE_TO_PAY_SITE = 'plain-http-x402.ts haven_quote_x402 → haven_pay_x402_quote (request mode, every optional input)'

async function quoteToPayCorpusEntry(): Promise<CorpusEntry> {
  stubFetch({
    'GET /paid': { status: 402, body: PAYMENT_REQUIRED },
    'POST /paid': { status: 402, body: PAYMENT_REQUIRED },
    'GET /machine-payments/agent': { status: 200, body: AGENT_RESPONSE },
    'POST /x402': { status: 201, body: X402_INTENT_RESPONSE },
  })
  const res = ok(
    await handlers().haven_quote_x402({
      url: 'https://merchant.test/paid',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"invoice_id":"inv_123"}',
    }),
  ) as { data: Record<string, any> }
  const args = { ...(res.data.next_arguments as Record<string, unknown>) }
  if (typeof args.idempotency_key !== 'string' || !args.idempotency_key.startsWith('x402q:')) {
    throw new Error(`expected a fresh x402q: replay key in the quote→pay handoff, got ${JSON.stringify(args.idempotency_key)}`)
  }
  args.idempotency_key = '<x402q-uuid>'
  return { site: QUOTE_TO_PAY_SITE, tool: 'haven_pay_x402_quote', arguments: args }
}

function sortedCorpus(entries: CorpusEntry[]): { comment: string; entries: CorpusEntry[] } {
  return { comment: CORPUS_COMMENT, entries: [...entries].sort((a, b) => a.site.localeCompare(b.site)) }
}

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'))
}

function writeJson(url: URL, value: unknown): void {
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`)
}

const REGEN_MESSAGE =
  `The hosted tool contract changed. Review the diff as a contract change, then regenerate BOTH goldens with: ${REGEN_CMD} ` +
  `(or ${REGEN_ENV}=1 npm run test -w packages/mcp-server -- src/tool-contract-snapshot.test.ts)`

installSharedFixtureLifecycle()

describe('hosted tools/list contract snapshot (#3817)', () => {
  it('matches the golden — any name, schema or description drift is a reviewed contract change', async () => {
    const snapshot = snapshotFromTools(await captureToolsList())
    if (process.env[REGEN_ENV] === '1') {
      writeJson(SNAPSHOT_URL, snapshot)
      return
    }
    expect(snapshot, REGEN_MESSAGE).toEqual(readJson(SNAPSHOT_URL))
  })
})

describe('next-arguments corpus (#3817)', () => {
  it('matches the golden — a changed emission is a reviewed contract change', async () => {
    const corpus = sortedCorpus([...fixtureCorpusEntries(), await quoteToPayCorpusEntry()])
    if (process.env[REGEN_ENV] === '1') {
      writeJson(CORPUS_URL, corpus)
      return
    }
    expect(corpus, REGEN_MESSAGE).toEqual(readJson(CORPUS_URL))
  })

  it('only names hosted tools the registry serves (signer handoffs are a different skew)', () => {
    const corpus = readJson(CORPUS_URL) as { entries: CorpusEntry[] }
    expect(corpus.entries.length).toBeGreaterThan(10)
    for (const entry of corpus.entries) {
      expect(toolSchemas, entry.site).toHaveProperty(entry.tool)
    }
  })
})
