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
  type HostedToolName,
  type StrictInputToolName,
  type ToolPayload,
} from './tools.js'

/** Minimum valid arguments for each strict tool, plus the undeclared key to smuggle. */
const VALID_ARGS: Record<StrictInputToolName, Record<string, unknown>> = {
  haven_report_x402_outcome: { payment_id: 'pay_x402', outcome: 'rejected', merchant_status: 402 },
  haven_submit: { payment_id: 'pay_1', signature: '0x' + 'ab'.repeat(32) },
  haven_settle_mcp_tool: { payment_id: 'pay_1', signature: '0x' + 'ab'.repeat(32) },
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
  haven_send: 'idempotencyKey',
  haven_pay_mcp_tool: 'idempotencyKey',
  // The local surface's local-ONLY field, not a case variant: refusing it is
  // what stops a body-bearing POST being quoted with an empty body.
  haven_quote_x402: 'body',
  haven_pay_x402_quote: 'idempotencyKey',
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
      // validation: it reached the handler and made a Haven request.
      expect(text.toLowerCase()).not.toContain('unrecognized')
      expect(fetches.length).toBeGreaterThan(0)
    })
  }

  it('CONTROL: a deliberately permissive tool still strips, and the handler still runs', async () => {
    // haven_get_payment_status is NOT on the strict list. If this assertion
    // ever flips to a refusal, the strict set was widened without deciding to.
    // haven_complete_mcp_tool is checked here for a sharper reason: it was in
    // batch 1 until the shipped agent skill was found telling agents to pass it
    // an undeclared `payment_required` (#2353). Until that guidance is fixed,
    // strictness on this tool is a 400 for every agent following Haven's own
    // instructions, so its permissiveness is a DECISION and this pins it.
    expect(Object.keys(STRICT_INPUT_TOOLS)).not.toContain('haven_get_payment_status')
    expect(Object.keys(STRICT_INPUT_TOOLS)).not.toContain('haven_complete_mcp_tool')
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_get_payment_status', {
      payment_id: 'pay_1',
      tx_hash: 'smuggled',
    })
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(fetches.length).toBeGreaterThan(0)
  })
})

/**
 * #2353 — the measured half of the CONTROL above.
 *
 * The control asserts `haven_complete_mcp_tool` is absent from
 * `STRICT_INPUT_TOOLS`, which pins the DECISION. This block pins the
 * BEHAVIOUR that decision produces, over the same real transport, using the
 * exact call Haven's shipped `SKILL.md` used to instruct: `payment_required`
 * alongside the declared arguments.
 *
 * It is a characterization test of a live permissive path, not an endorsement
 * of it. Its job is to make the silent strip visible and to make the eventual
 * strictness switch impossible to land by accident: the day
 * `haven_complete_mcp_tool` joins `STRICT_INPUT_TOOLS`, this goes red and
 * whoever flips it has to come here and say so.
 */
describe('#2353 — haven_complete_mcp_tool silently drops `payment_required` today', () => {
  const SKILL_INSTRUCTED_ARGS = {
    payment_id: 'pay_1',
    payment_header: 'x402-header',
    // Everything below this line IS declared by the tool.
    merchant_url: 'https://merchant.test/mcp',
    tool_name: 'fetch_report',
    arguments: { tier: '50gb' },
    mcp_transport: { handshake_required: false, source: 'path' },
  } as const

  it('accepts the undeclared key at the transport and never carries it anywhere', async () => {
    const client = await connectedClient()
    const { text } = await callToolText(client, 'haven_complete_mcp_tool', {
      ...SKILL_INSTRUCTED_ARGS,
      payment_required: { accepts: [{ amount: '1000000', payTo: '0xMERCHANT' }] },
    })

    // 1. No refusal: validation let the undeclared key through, stripped.
    expect(text.toLowerCase()).not.toContain('unrecognized')
    expect(text).not.toContain('payment_required')
    // 2. The call reached the handler and talked to Haven — a strip, not a
    //    refusal. This is what makes the defect silent: the agent's call
    //    SUCCEEDS at the transport, so nothing tells it the 402 it pinned was
    //    discarded.
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
    expect(toolInputSchema('haven_get_payment_status')).toBe(toolSchemas.haven_get_payment_status)
  })
})

/**
 * #2363 — the `haven_complete_mcp_tool` exclusion's PREMISE, pinned where the
 * exclusion lives.
 *
 * `STRICT_INPUT_TOOLS`' doc block argues, in prose, that this tool stays
 * permissive because the shipped `SKILL.md` USED TO instruct an undeclared
 * `payment_required` — past tense since #2359 fixed it — and that what now
 * gates the switch is ROLLOUT of the corrected copy, not its correctness.
 * That argument is only as good as its premise, and #2363 exists because the
 * premise changed under the comment and nothing said so.
 *
 * `packages/sdk/src/skill-content.test.ts` already pins both literals, and
 * it is the primary guard — this is deliberately the SAME two assertions, not
 * a better one. What it adds is WHERE it goes red: a revert of the skill text
 * fails the suite of the file carrying the exclusion, with a message naming
 * the comment, so whoever repairs the skill is told the rationale above needs
 * re-reading too. Cross-package by design; `@haven_ai/sdk` is already a
 * dependency of this package and already imported at the top of this file.
 *
 * Two literals, no sentence interpretation — `ship-next` § Rework caps rule 1.
 * The broader "check skill prose against tool schemas" guard was prototyped
 * and REJECTED on measurement (1 true positive, 10 false positives; see
 * `docs/product/copy-guidelines.md` § Enforcement). This is the cheap literal
 * floor under human review, never a substitute for it.
 */
describe('#2363 — the shipped skill still matches what the exclusion comment claims', () => {
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
    // so the STRICT_INPUT_TOOLS bullet's "that guidance is FIXED" is false and
    // the blocker is correctness again, not rollout. Fix both.
    expect(completeSection).not.toMatch(/Pass\s+`payment_required`/)
  })

  it('the correction stays present, so the rollout framing keeps its subject', () => {
    // If this fails: there is no corrected copy to propagate, and "what gates
    // the switch is ROLLOUT" in the STRICT_INPUT_TOOLS bullet has nothing to
    // refer to.
    expect(completeSection).toMatch(/does not take\s+`payment_required`/)
    expect(completeSection).toMatch(/`payment_id`\s+and the signer's\s+`payment_header`\s+ONLY/)
  })

  it('and the tool it argues about is still permissive', () => {
    // The comment justifies an EXCLUSION. If the tool ever joins the set, this
    // whole block is about a decision that was reversed.
    expect(Object.keys(STRICT_INPUT_TOOLS)).not.toContain('haven_complete_mcp_tool')
  })
})
