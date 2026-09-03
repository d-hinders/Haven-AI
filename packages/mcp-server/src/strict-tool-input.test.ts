/**
 * #2312 — undeclared arguments are REFUSED, not silently stripped.
 *
 * These tests drive the real MCP transport rather than calling handlers
 * directly, and that is the whole point of the file. #2292's own strictness
 * test calls `createToolHandlers(...).haven_report_x402_outcome({...})`
 * directly, which is the only place its guard could pass: over the wire the
 * MCP SDK validates the call against the registered input schema and hands the
 * handler the already-STRIPPED arguments, so a handler-level `.strict()` never
 * sees the undeclared key. A guard that can only pass in the shape its own
 * test uses is the defect class #2307 removed 56 of.
 *
 * So: every assertion here goes client → transport → server → handler, and the
 * negative control below (`haven_get_payment_status`, deliberately permissive)
 * proves the harness can observe a strip as well as a refusal.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
// #2363: HAVEN_SKILL_MD is the canonical shipped skill text — imported, not
// restated, so the premise pin at the bottom of this file reads the real
// string rather than a copy that can drift from it.
import { HavenClient, HAVEN_SKILL_MD } from '@haven_ai/sdk'
// #2348: the LOCAL surface, imported rather than restated — the crossover keys
// this file smuggles have to be the ones @haven_ai/mcp really declares, or the
// tests prove nothing about the divergence they exist for.
//
// KEEP THIS IMPORT TEST-ONLY. `@haven_ai/mcp` is a devDependency, and the
// hosted server's Dockerfile does not `COPY packages/mcp` — its runner stage
// runs `npm ci --omit=dev`, and its builder stage bundles only src/index.ts and
// src/cli.ts, so nothing resolves this today. Moving it into non-test `src/`
// would break the Docker builder on a workspace link pointing at a directory
// the image never copied. (haven-reviewer, #2348.)
import { toolSchemas as localToolSchemas, computeConsentHash, type ConsentInput } from '@haven_ai/mcp'
import { buildHostedMcpServer } from './server.js'
import {
  createToolHandlers,
  toolSchemas,
  toolInputSchema,
  STRICT_INPUT_TOOLS,
  PERMISSIVE_INPUT_TOOLS,
  type HostedToolName,
  type StrictInputToolName,
  type PermissiveInputToolName,
  type ToolPayload,
} from './tools.js'

/** Minimum valid arguments for each strict tool, plus the undeclared key to smuggle. */
const VALID_ARGS: Record<StrictInputToolName, Record<string, unknown>> = {
  haven_report_x402_outcome: { payment_id: 'pay_x402', outcome: 'rejected', merchant_status: 402 },
  haven_submit: { payment_id: 'pay_1', signature: '0x' + 'ab'.repeat(32) },
  haven_settle_mcp_tool: { payment_id: 'pay_1', signature: '0x' + 'ab'.repeat(32) },
  // #2353's switch — the rehydration pair is enough to reach the handler (the
  // omitted merchant_url/tool_name take the rehydration branch, which issues
  // its GET), which is what the "still accepts its own arguments" loop reads.
  haven_complete_mcp_tool: { payment_id: 'pay_1', payment_header: 'x402-header' },
  // #2348 — the camelCase crossover four.
  haven_send: { asset: 'USDC', recipient: '0xabc', amount: '1' },
  haven_pay_mcp_tool: { merchant_url: 'http://merchant.test/mcp', tool_name: 'buy', max_amount_human: '1' },
  haven_quote_x402: { url: 'http://merchant.test/paid' },
  // A real payable option, so the tool gets PAST validation and actually
  // reaches Haven — an empty accepts[] short-circuits to WRONG_TOOL before any
  // fetch, which would make the "still accepts its own arguments" assertion
  // pass for the wrong reason.
  haven_pay_x402_quote: {
    payment_required: {
      x402Version: 1,
      resource: { url: 'https://merchant.test/paid', description: 'paid data' },
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          amount: '1000000',
          maxAmountRequired: '1500000',
          asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          payTo: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
          maxTimeoutSeconds: 60,
          extra: { name: 'USD Coin', version: '2' },
        },
      ],
    },
  },
  // #2349 — batch 3, the remainder. Each fixture is the least that gets PAST
  // validation and into the handler; the stubbed Haven answers `{}` to
  // everything, so most fail downstream, which is fine — see the loop.
  haven_sweep_delegate: {},
  haven_pay: { token: 'USDC', amount: '1', to: '0xabc' },
  haven_quote_mcp_tool: { merchant_url: 'http://merchant.test/mcp', tool_name: 'buy' },
  haven_prepare_catalog_purchase: { catalog_id: 'cat_1', max_amount_human: '1' },
  haven_quote_catalog_purchase: { catalog_id: 'cat_1' },
  haven_resume_x402_payment: { payment_id: 'pay_1' },
  haven_get_payment_status: { payment_id: 'pay_1' },
  haven_get_resume_state: { payment_id: 'pay_1' },
  haven_list_receipts: {},
  // A structurally valid receipt with an empty signature: verifyPaymentReceipt
  // answers { verified: false, reason: 'missing_signature' } without touching
  // the network, which is what the OFFLINE branch of the loop below expects.
  haven_verify_receipt: {
    receipt: { authorization: { delegate: '0xabc', signHash: '0x00', signature: '' } },
  },
  haven_discover_tools: {},
  haven_submit_catalog_entry: { resource_url: 'https://merchant.example/mcp' },
}

/**
 * #2349: tools whose happy path makes NO Haven request by design. The
 * "still accepts its own arguments" loop proves reach-the-handler by
 * observing a fetch; for these it observes the handler's own answer instead.
 */
const OFFLINE_TOOLS: Partial<Record<StrictInputToolName, string>> = {
  // verifyPaymentReceipt is pure — the response carries `verified` either way.
  haven_verify_receipt: '"verified"',
}

/**
 * One undeclared key per tool.
 *
 * Batch 1's keys are values the tool really does read from the payment's own
 * RECORD — the #2292 shape, not an invented key. Batch 2's are the exact
 * spelling the LOCAL MCP declares for the same-named tool
 * (`packages/mcp/src/tools.ts`), which is the whole point of #2348: these are
 * not hypothetical typos, they are the other half of Haven's own tool surface.
 */
const SMUGGLED_KEY: Record<StrictInputToolName, string> = {
  haven_report_x402_outcome: 'tx_hash',
  haven_submit: 'amount',
  haven_settle_mcp_tool: 'merchant_address',
  // #2353: the exact undeclared key the shipped SKILL.md used to instruct —
  // not an invented typo, the original defect itself.
  haven_complete_mcp_tool: 'payment_required',
  haven_send: 'idempotencyKey',
  haven_pay_mcp_tool: 'idempotencyKey',
  // The local surface's local-ONLY field, not a case variant: refusing it is
  // what stops a body-bearing POST being quoted with an empty body.
  haven_quote_x402: 'body',
  haven_pay_x402_quote: 'idempotencyKey',
  // #2349 — batch 3. Each is a key a real caller would plausibly reach for on
  // that tool, and the value the message says it is read from instead:
  // expected_auth is the signer call's argument echoed back; idempotencyKey is
  // the SDK's spelling (the #2348 total-loss shape, re-measured on haven_pay);
  // max_amount on the two quote tools is the cap #1351 put on the PAY leg —
  // and the very key tools.test.ts was passing to haven_quote_mcp_tool until
  // this change; `arguments` on the catalog prepare is the #2312 record-reading
  // shape, since the row supplies them; the rest are the natural mis-key on a
  // by-id read, a list, an offline verification, a filter, and a submission.
  haven_sweep_delegate: 'expected_auth',
  haven_pay: 'idempotencyKey',
  haven_quote_mcp_tool: 'max_amount',
  haven_prepare_catalog_purchase: 'arguments',
  haven_quote_catalog_purchase: 'max_amount',
  haven_resume_x402_payment: 'payment_header',
  haven_get_payment_status: 'tx_hash',
  haven_get_resume_state: 'idempotency_key',
  haven_list_receipts: 'offset',
  haven_verify_receipt: 'expected_signer',
  haven_discover_tools: 'query',
  haven_submit_catalog_entry: 'name',
}

let fetches: string[]

function stubFetch() {
  fetches = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    fetches.push(`${(init.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`)
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({}),
      text: async () => '{}',
    } as unknown as Response
  })
}

async function connectedClient() {
  const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
  const server = buildHostedMcpServer(haven)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'strict-input-test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

/** The text an MCP call came back with, whether it threw or returned isError. */
async function callToolText(client: Client, name: string, args: Record<string, unknown>) {
  try {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean
      content?: { type: string; text?: string }[]
    }
    return { threw: false, text: result.content?.map((c) => c.text ?? '').join('\n') ?? '' }
  } catch (err) {
    return { threw: true, text: err instanceof Error ? err.message : String(err) }
  }
}

beforeEach(stubFetch)
afterEach(() => vi.unstubAllGlobals())

describe('#2312 strict hosted tool input — over the real MCP transport', () => {
  for (const name of Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]) {
    it(`${name} REFUSES "${SMUGGLED_KEY[name]}" and never reaches the handler`, async () => {
      const client = await connectedClient()
      const { text } = await callToolText(client, name, {
        ...VALID_ARGS[name],
        [SMUGGLED_KEY[name]]: 'smuggled',
      })

      // Refused, and the refusal names the key rather than shrugging.
      expect(text).toContain(SMUGGLED_KEY[name])
      expect(text.toLowerCase()).toContain('unrecognized')
      // The load-bearing half: nothing was read and nothing was written. A
      // refusal that still made its Haven calls would be a strip with a
      // grumble, not a refusal.
      expect(fetches).toEqual([])
    })

    it(`${name} still accepts its own declared arguments`, async () => {
      const client = await connectedClient()
      const { text } = await callToolText(client, name, VALID_ARGS[name])
      // Not asserting success — these fixtures answer `{}` to every Haven call,
      // so the tool fails downstream. What matters is that it got PAST
      // validation: it reached the handler and made a Haven request — or, for
      // a tool that is offline by design, answered in its own vocabulary.
      expect(text.toLowerCase()).not.toContain('unrecognized')
      const offlineMarker = OFFLINE_TOOLS[name]
      if (offlineMarker) {
        expect(fetches).toEqual([])
        expect(text).toContain(offlineMarker)
      } else {
        expect(fetches.length).toBeGreaterThan(0)
      }
    })
  }

  it('CONTROL: a deliberately permissive tool still strips, and the handler still runs', async () => {
    // #2349 moved this control from haven_get_payment_status (now strict) to
    // haven_get_agent, one of the two `{}`-schema tools that are permissive on
    // purpose. If this assertion ever flips to a refusal, the strict set was
    // widened without deciding to. The decorated key is the one a supported
    // runtime is documented adding to parameterless tools (Cursor's
    // `random_string`), so this is the live shape, not an invented one.
    // haven_complete_mcp_tool was pinned here until #2353's switch PR moved it
    // to STRICT_INPUT_TOOLS (2026-09-03): its permissiveness used to be a
    // DECISION (the auto-installed SKILL.md propagated past a would-be
    // refusal); the #2353 block below now pins the refusal that replaced it.
    for (const permissive of ['haven_get_agent', 'haven_get_allowances']) {
      expect(Object.keys(STRICT_INPUT_TOOLS)).not.toContain(permissive)
      expect(Object.keys(PERMISSIVE_INPUT_TOOLS)).toContain(permissive)
    }
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_get_agent', { random_string: 'dummy' })
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(fetches).toContain('GET /machine-payments/agent')
  })
})

/**
 * #2349 — every hosted tool carries an input decision: the RUNTIME twin of the
 * compile-time guard in tools.ts (`_everyHostedToolCarriesAnInputDecision`).
 *
 * Two instruments on purpose. `tsc` sees a new `HostedToolName` on neither
 * list; `vitest` does not type-check, so a tool added to `toolSchemas` alone
 * would sail through every test here while the type guard sat unread. And
 * the anti-vacuity is explicit: a guard that iterates an empty set and passes
 * is the defect #2317's allowlist self-check had, so the set sizes are pinned
 * to the registered surface, not to each other.
 */
describe('#2349 — every hosted tool is on exactly one input list', () => {
  const hosted = Object.keys(toolSchemas) as HostedToolName[]
  const strict = Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]
  const permissive = Object.keys(PERMISSIVE_INPUT_TOOLS) as PermissiveInputToolName[]

  it('the instrument has something to measure', () => {
    // If toolSchemas were ever empty, or the two lists were, the loops below
    // would pass vacuously. Refuse that outright.
    expect(hosted.length).toBeGreaterThan(0)
    expect(strict.length).toBeGreaterThan(0)
    expect(permissive.length).toBeGreaterThan(0)
  })

  it('each hosted tool is strict XOR permissive — none undecided, none decided twice', () => {
    for (const name of hosted) {
      const isStrict = strict.includes(name as StrictInputToolName)
      const isPermissive = permissive.includes(name as PermissiveInputToolName)
      expect({ name, isStrict, isPermissive }).toEqual({ name, isStrict: !isPermissive, isPermissive: !isStrict })
    }
    // ...and the two lists name nothing that is not a hosted tool, so the
    // counts reconcile to the registered surface exactly.
    expect(strict.length + permissive.length).toBe(hosted.length)
    for (const name of [...strict, ...permissive]) expect(hosted).toContain(name)
  })

  it('the registered surface IS toolSchemas — no alias registers behind it', async () => {
    // The "one release cycle" legacy aliases (haven_x402_authorize,
    // haven_list_transactions) were defined in #314 and never registered; #2349
    // deleted the dead export. This pins that what tools/list advertises is the
    // decided surface and nothing else, so a future alias cannot skip the
    // decision by registering outside toolSchemas.
    const client = await connectedClient()
    const advertised = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(advertised).toEqual([...hosted].sort())
    expect(advertised).not.toContain('haven_x402_authorize')
    expect(advertised).not.toContain('haven_list_transactions')
  })
})

/**
 * #2349 — what strictness would MEAN on a `{}` schema, measured rather than
 * argued. The permissive decision on haven_get_agent / haven_get_allowances
 * rests on three facts about the transport, and each is pinned with the
 * control that makes it a measurement instead of a belief.
 */
describe('#2349 — the {} tools: strictness would change exactly one case', () => {
  it('ABSENT arguments are refused TODAY, on the permissive raw shape — strict would not change this', async () => {
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_get_agent', undefined as unknown as Record<string, unknown>)
    expect(text).toContain('invalid_type')
    expect(fetches).toEqual([])
  })

  it('EMPTY arguments pass, and a DECORATED call passes too — the strip, observed', async () => {
    const client = await connectedClient()
    await callToolText(client, 'haven_get_agent', {})
    expect(fetches).toContain('GET /machine-payments/agent')
    fetches.length = 0
    const { text } = await callToolText(client, 'haven_get_allowances', { random_string: 'dummy' })
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(fetches).toContain('GET /machine-payments/allowances')
  })

  it('CONTROL: a strict {} DOES refuse the same decoration over the same transport', async () => {
    // Without this, "the decorated call passed" cannot be told apart from "the
    // harness cannot observe a refusal on an empty schema". A scratch server
    // with the strict form of the identical shape, driven the identical way.
    const server = new McpServer({ name: 'scratch', version: '0' })
    let reached = false
    ;(server as unknown as {
      registerTool: (name: string, cfg: { description: string; inputSchema: unknown }, h: () => Promise<unknown>) => void
    }).registerTool('t', { description: 'scratch', inputSchema: z.object({}).strict() }, async () => {
      reached = true
      return { content: [{ type: 'text', text: 'reached' }] }
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'scratch-client', version: '0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const { text } = await callToolText(client, 't', { random_string: 'dummy' })
    expect(text).toContain('unrecognized_keys')
    expect(reached).toBe(false)
  })
})

/**
 * #2349 — the cap pair on haven_prepare_catalog_purchase. The issue asked
 * whether a strict parse changes which refusal a caller meets first. It does
 * not for a caller sending only declared keys: both cap spellings are
 * declared, so strict passes them through and `readMaxAmountCap` still
 * raises its own — more useful — refusals, before any network call.
 */
describe('#2349 — the cap refusals stay reachable behind strict', () => {
  it('both caps → AmbiguousMaxAmount, no network', async () => {
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_prepare_catalog_purchase', {
      catalog_id: 'cat_1',
      max_amount: '1000000',
      max_amount_human: '1',
    })
    expect(text).toContain('Both max_amount')
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(fetches).toEqual([])
  })

  it('no cap → the cap-required refusal, no network', async () => {
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_prepare_catalog_purchase', { catalog_id: 'cat_1' })
    expect(text).toContain('A spending cap is REQUIRED')
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(fetches).toEqual([])
  })

  it('an UNDECLARED key alongside both caps meets the strict refusal first — stated, not hidden', async () => {
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_prepare_catalog_purchase', {
      catalog_id: 'cat_1',
      max_amount: '1000000',
      max_amount_human: '1',
      tool_name: 'smuggled',
    })
    expect(text).toContain('tool_name')
    expect(text.toLowerCase()).toContain('unrecognized')
    expect(fetches).toEqual([])
  })
})

/**
 * #2353 — the SWITCH, measured over the real transport.
 *
 * History of this block: it began as the measured half of the CONTROL above —
 * a characterization test pinning the silent strip that
 * `haven_complete_mcp_tool`'s deliberate permissiveness produced, so the
 * eventual strictness switch could not land by accident without coming here.
 * #2359 fixed the shipped SKILL.md guidance and #2353's switch PR (2026-09-03)
 * then moved the tool to STRICT_INPUT_TOOLS once the corrected copy had
 * shipped to npm (@haven_ai/sdk@0.1.34-alpha.0, 2026-09-01T19:21Z), so this
 * block now pins the opposite behaviour — and it goes red if anyone ever
 * reverts the tool to permissive, in the file that carries the switch.
 *
 * The args are the ones the OLD skill copy instructed (payment_required
 * alongside the declared arguments), kept as the live regression shape: an
 * agent still carrying a pre-0.1.34 installed copy sends exactly this and
 * must now meet a refusal that names the key, before the handler runs.
 */
describe('#2353 — haven_complete_mcp_tool REFUSES `payment_required` over the transport', () => {
  const SKILL_INSTRUCTED_ARGS = {
    payment_id: 'pay_1',
    payment_header: 'x402-header',
    // Everything below this line IS declared by the tool.
    merchant_url: 'https://merchant.test/mcp',
    tool_name: 'fetch_report',
    arguments: { tier: '50gb' },
    mcp_transport: { handshake_required: false, source: 'path' },
  } as const

  it('the undeclared key is refused at the transport and never reaches the handler', async () => {
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_complete_mcp_tool', {
      ...SKILL_INSTRUCTED_ARGS,
      payment_required: { accepts: [{ amount: '1000000', payTo: '0xMERCHANT' }] },
    })

    // 1. Refused, and the refusal names the key rather than shrugging — an
    //    agent carrying the old skill copy is told exactly what is wrong.
    expect(text).toContain('payment_required')
    expect(text.toLowerCase()).toContain('unrecognized')
    // 2. The load-bearing half: nothing was read and nothing was written. The
    //    merchant call spends against the RECORDED 402 (rehydrated by
    //    payment_id since #1307); a refusal that still made its Haven calls
    //    would be a strip with a grumble, not a refusal.
    expect(fetches).toEqual([])
  })

  it('the same call WITHOUT the undeclared key still reaches the handler', async () => {
    // The other half of the mutation-proof: strictness must not take the
    // documented flow down with it. All-declared args pass validation and
    // reach Haven — the explicit-context branch of resolveMerchantCallContext
    // (merchant_url + tool_name supplied), so no rehydration GET appears.
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_complete_mcp_tool', SKILL_INSTRUCTED_ARGS)
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(fetches.length).toBeGreaterThan(0)
  })

  it('CONTROL: the same harness DOES see a declared key arrive', async () => {
    // Without this, the assertion above cannot distinguish "the key was
    // stripped" from "the harness cannot observe arguments at all" — the
    // false-zero shape. `merchant_url` + `tool_name` are declared, and
    // supplying them takes the EXPLICIT context branch of
    // resolveMerchantCallContext, which skips the rehydration GET. Omitting
    // them takes the rehydration branch and issues it. So the presence or
    // absence of that one request is a direct read of whether a declared
    // argument survived the transport.
    const withContext = await connectedClient()
    await callToolText(withContext, 'haven_complete_mcp_tool', SKILL_INSTRUCTED_ARGS)
    const explicit = [...fetches]

    fetches.length = 0
    const withoutContext = await connectedClient()
    await callToolText(withoutContext, 'haven_complete_mcp_tool', {
      payment_id: SKILL_INSTRUCTED_ARGS.payment_id,
      payment_header: SKILL_INSTRUCTED_ARGS.payment_header,
    })
    const rehydrated = [...fetches]

    const CONTEXT_GET = 'GET /x402/pay_1/merchant-call-context'
    expect(explicit).not.toContain(CONTEXT_GET)
    expect(rehydrated).toContain(CONTEXT_GET)
  })
})

describe('#2312 strict hosted tool input — the direct-embedder path', () => {
  // `createToolHandlers` is exported from index.ts, so a caller can bypass the
  // MCP server entirely. `parseStrict` is what covers that path.
  for (const name of Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]) {
    it(`${name} refuses "${SMUGGLED_KEY[name]}" when the handler is called directly`, async () => {
      const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })
      const handlers = createToolHandlers(haven)
      const payload = (await handlers[name]({
        ...VALID_ARGS[name],
        [SMUGGLED_KEY[name]]: 'smuggled',
      })) as ToolPayload
      expect(payload.success).toBe(false)
      const failure = payload as { success: false; code: string; message: string }
      expect(failure.code).toBe('INVALID_INPUT')
      expect(failure.message).toContain(SMUGGLED_KEY[name])
      // The refusal explains WHY this tool does not take the key, from the one
      // declaration in STRICT_INPUT_TOOLS — not a generic zod message.
      expect(failure.message).toContain(STRICT_INPUT_TOOLS[name])
      expect(fetches).toEqual([])
    })
  }
})

describe('#2348 — the crossover keys are the LOCAL surface\'s real spellings', () => {
  // Without this, SMUGGLED_KEY for the four could drift into an invented typo
  // and the tests above would still pass while proving nothing about the
  // divergence they exist for. Pinned against the published local package the
  // same way hosted-signer-integration.test.ts pins SIGNER_CAPABILITY_KEY.
  const CROSSOVER: Record<string, string> = {
    haven_send: 'idempotencyKey',
    haven_pay_mcp_tool: 'idempotencyKey',
    haven_quote_x402: 'body',
    haven_pay_x402_quote: 'idempotencyKey',
  }

  it('the strict set actually CONTAINS all four — the loops above self-scope', () => {
    // Found by mutation, not by reading: deleting the four entries from
    // STRICT_INPUT_TOOLS made the file go 30 tests → 18 PASSING, because every
    // other block in this file iterates `Object.keys(STRICT_INPUT_TOOLS)` and
    // a removed tool removes its own tests. Batch 1 pinned the two deliberate
    // EXCLUSIONS (`not.toContain`) and never pinned the inclusions, so the
    // suite could be silently emptied of exactly the guard it exists for.
    // This is the assertion that makes that mutation red.
    for (const tool of Object.keys(CROSSOVER)) {
      expect(Object.keys(STRICT_INPUT_TOOLS)).toContain(tool)
    }
    // Batch 1's three, pinned the same way and for the same reason.
    for (const tool of ['haven_report_x402_outcome', 'haven_submit', 'haven_settle_mcp_tool']) {
      expect(Object.keys(STRICT_INPUT_TOOLS)).toContain(tool)
    }
    // Batch 3's twelve (#2349). The literal list is the anti-vacuity pin: the
    // loops above self-scope to whatever STRICT_INPUT_TOOLS holds, so a
    // deletion removes its own tests; this is what makes that deletion red.
    for (const tool of [
      // #2353's switch (2026-09-03) — the last money-path tool to leave the
      // permissive set, after #2359's corrected SKILL.md had shipped to npm
      // (0.1.34-alpha.0, 2026-09-01). Pinned as a literal for the same reason
      // as the rest of this list: the loops self-scope, so only a literal
      // assertion goes red when the entry is deleted.
      'haven_complete_mcp_tool',
      'haven_sweep_delegate',
      'haven_pay',
      'haven_quote_mcp_tool',
      'haven_prepare_catalog_purchase',
      'haven_quote_catalog_purchase',
      'haven_resume_x402_payment',
      'haven_get_payment_status',
      'haven_get_resume_state',
      'haven_list_receipts',
      'haven_verify_receipt',
      'haven_discover_tools',
      'haven_submit_catalog_entry',
    ]) {
      expect(Object.keys(STRICT_INPUT_TOOLS)).toContain(tool)
    }
    expect(Object.keys(STRICT_INPUT_TOOLS)).toHaveLength(20)
    // And the two deliberate exclusions, as a literal list for the same reason.
    expect(Object.keys(PERMISSIVE_INPUT_TOOLS).sort()).toEqual(
      ['haven_get_agent', 'haven_get_allowances'],
    )
  })

  for (const [tool, key] of Object.entries(CROSSOVER)) {
    it(`${tool}: the local MCP declares "${key}" and the hosted surface does not`, () => {
      expect(Object.keys(localToolSchemas[tool as keyof typeof localToolSchemas])).toContain(key)
      expect(Object.keys(toolSchemas[tool as HostedToolName])).not.toContain(key)
      expect(SMUGGLED_KEY[tool as StrictInputToolName]).toBe(key)
    })
  }

  it('haven_pay_x402_quote\'s "quote" crossover ALREADY failed loudly — payment_required is required', async () => {
    // Measured, not assumed. #2348's divergence table reads as though `quote`
    // were as silent as `idempotencyKey`; it never was, because the field it
    // stands in for is required. Pinned so the claim in STRICT_INPUT_TOOLS'
    // message stays true.
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_pay_x402_quote', {
      quote: { paymentRequired: {} },
    })
    expect(text).toContain('payment_required')
    expect(fetches).toEqual([])
  })

  it('CONTROL: the consent hash takes no schema, so no operator is re-prompted', () => {
    // #2312 measured this; this batch RE-VERIFIES it rather than inheriting it.
    // computeConsentHash's inputs are credential identity, the sorted TOOL NAME
    // list and the allowance list — no schema anywhere, which is why adding
    // .strict() to four tools cannot invalidate a pre-embedded HAVEN_MCP_ACK.
    // The controls are the last two assertions: the instrument must be able to
    // say "changed", or "it did not change" is worth nothing.
    const cred = {
      apiKeyPrefix: 'sk_agent_abc',
      apiUrl: 'http://haven.test',
      agentId: 'agt_1',
      safeAddress: '0xSAFE',
      delegateAddress: '0xDELEGATE',
      chainId: 8453,
      // The LOCAL surface's names — `ConsentInput.toolNames` is typed to the
      // local union, which is itself the point: the consent gate lives in
      // @haven_ai/mcp and @haven_ai/signer, and the hosted server has no
      // consent gate at all. Hosted strictness is doubly out of its reach.
      toolNames: Object.keys(localToolSchemas) as ConsentInput['toolNames'],
      allowanceSummary: [{ token: 'USDC', amount: '10', resetMinutes: 1440 }],
    }
    const before = computeConsentHash(cred)
    // Same tool NAMES, same allowances, same identity — the four tools that
    // gained .strict() are hosted, and none was renamed on either surface.
    expect(computeConsentHash({ ...cred })).toBe(before)
    // CONTROL 1 — a tool-set change DOES move it.
    expect(
      computeConsentHash({
        ...cred,
        toolNames: [...cred.toolNames, 'haven_invented'] as unknown as ConsentInput['toolNames'],
      }),
    ).not.toBe(before)
    // CONTROL 2 — an allowance change DOES move it.
    expect(
      computeConsentHash({ ...cred, allowanceSummary: [{ token: 'USDC', amount: '11', resetMinutes: 1440 }] }),
    ).not.toBe(before)
  })
})

describe('#2312 — strictness does not change what is advertised', () => {
  it('every hosted tool advertises byte-identical JSON Schema strict or loose', () => {
    for (const name of Object.keys(toolSchemas) as HostedToolName[]) {
      const loose = toJsonSchemaCompat(z.object(toolSchemas[name]) as never, { pipeStrategy: 'input' })
      const strict = toJsonSchemaCompat(z.object(toolSchemas[name]).strict() as never, {
        pipeStrategy: 'input',
      })
      expect(JSON.stringify(strict)).toBe(JSON.stringify(loose))
      // ...and what both advertise is already `additionalProperties: false`,
      // which is why the loose behaviour was a mismatch with the contract
      // rather than an honest permissiveness.
      expect((loose as { additionalProperties?: unknown }).additionalProperties).toBe(false)
    }
  })

  it('the schema a strict tool registers is a strict ZodObject, not a raw shape', () => {
    for (const name of Object.keys(STRICT_INPUT_TOOLS) as StrictInputToolName[]) {
      const schema = toolInputSchema(name)
      expect(schema).toBeInstanceOf(z.ZodObject)
      expect((schema as z.ZodObject<z.ZodRawShape>)._def.unknownKeys).toBe('strict')
    }
    // And a permissive tool still hands the SDK the raw shape it always did.
    for (const name of Object.keys(PERMISSIVE_INPUT_TOOLS) as PermissiveInputToolName[]) {
      expect(toolInputSchema(name)).toBe(toolSchemas[name])
    }
  })
})

/**
 * #2363 — the premise the `haven_complete_mcp_tool` reasoning rests on,
 * pinned where that reasoning lives.
 *
 * `STRICT_INPUT_TOOLS`' doc block argues, in prose, from what the shipped
 * `SKILL.md` did and does say: that it USED TO instruct an undeclared
 * `payment_required` (fixed by #2359), and — since #2353's switch PR moved
 * the tool to STRICT_INPUT_TOOLS on 2026-09-03 — that the corrected copy is
 * what the refusal now presumes. That argument is only as good as its
 * premise, and #2363 exists because the premise changed under the comment and
 * nothing said so.
 *
 * `packages/sdk/src/skill-content.test.ts` already pins both literals, and
 * it is the primary guard — this is deliberately the SAME two assertions, not
 * a better one. What it adds is WHERE it goes red: a revert of the skill text
 * fails the suite of the file carrying the tool's input decision, with a
 * message naming the comment, so whoever repairs the skill is told the
 * rationale above needs re-reading too. Cross-package by design;
 * `@haven_ai/sdk` is already a dependency of this package and already
 * imported at the top of this file.
 *
 * Two literals, no sentence interpretation — `ship-next` § Rework caps rule 1.
 * The broader "check skill prose against tool schemas" guard was prototyped
 * and REJECTED on measurement (1 true positive, 10 false positives; see
 * `docs/product/copy-guidelines.md` § Enforcement). This is the cheap literal
 * floor under human review, never a substitute for it.
 */
describe('#2363 — the shipped skill still matches what the switch comment claims', () => {
  const completeSection = HAVEN_SKILL_MD.slice(HAVEN_SKILL_MD.indexOf('haven_complete_mcp_tool'))

  it('CONTROL: the skill really does discuss haven_complete_mcp_tool', () => {
    // The false-zero mode: if the tool is renamed in the skill, `indexOf`
    // returns -1 and `slice(-1)` yields the document's LAST CHARACTER — a
    // one-char string in which the negative assertion below passes for the
    // wrong reason and the positive ones fail for the wrong reason. The
    // `toContain` here is what actually catches that; the length check does
    // NOT, because a one-character slice is still length 1. The length check
    // is redundant belt-and-braces, not the sole catcher of anything — an
    // empty document fails `toContain` on its own too.
    expect(HAVEN_SKILL_MD).toContain('haven_complete_mcp_tool')
    expect(completeSection.length).toBeGreaterThan(0)
  })

  it('the deleted imperative stays deleted, so the comment\'s past tense stays true', () => {
    // If this fails: `SKILL.md` tells agents to pass `payment_required` again,
    // so the refusal now hard-400s Haven's own documented flow and the
    // STRICT_INPUT_TOOLS entry's "the guidance is FIXED" premise is false.
    // Fix both — and re-derive whether the tool can stay strict at all.
    expect(completeSection).not.toMatch(/Pass\s+`payment_required`/)
  })

  it('the correction stays present, so the switch comment keeps its subject', () => {
    // If this fails: there is no corrected copy for the refusal to presume,
    // and the STRICT_INPUT_TOOLS entry's propagation record (0.1.34-alpha.0)
    // has nothing to refer to.
    expect(completeSection).toMatch(/does not take\s+`payment_required`/)
    expect(completeSection).toMatch(/`payment_id`\s+and the signer's\s+`payment_header`\s+ONLY/)
  })

  it('and the refusal it argues for is in force — the switch has landed', () => {
    // This block once pinned the EXCLUSION (not.toContain): the comment
    // justified keeping the tool permissive, and #2363's job was to keep that
    // argument honest. #2353's switch PR (2026-09-03) resolved the rollout
    // question — the corrected skill shipped in @haven_ai/sdk@0.1.34-alpha.0
    // (2026-09-01T19:21Z) — and the pin flipped with the decision it tracks.
    // The whole block now argues for the INCLUSION; if the tool ever leaves
    // the set again, this is where that reversal must be re-decided, and the
    // STRICT_INPUT_TOOLS comment re-read with it.
    expect(Object.keys(STRICT_INPUT_TOOLS)).toContain('haven_complete_mcp_tool')
    expect(Object.keys(PERMISSIVE_INPUT_TOOLS)).not.toContain('haven_complete_mcp_tool')
  })
})
