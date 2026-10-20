/**
 * #4137: the session-transcript redactor. Every value below is SYNTHETIC,
 * with the real shapes (`sk_agent_…`, `sk-ant-…`, a 64-hex key, `0x` + 130
 * hex, `eyJ…` base64, an RPC URL with a key segment). None is a real secret.
 *
 * The fixture plants a canary for each rule class in each position a stream
 * can carry it: the line's own JSON (a `tool_use` input), a nested-JSON
 * `text` block of a `tool_result` (the hosted envelope, pretty-printed as
 * `toMcpResult` writes it), a bare-string `tool_result`, and a line cut off
 * mid-way (SIGKILL) that fails `JSON.parse`.
 */

import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deepFind } from './json-reading.js'
import {
  REDACTION_CLASSES,
  loadSecrets,
  marker,
  redactSessionText,
  runRedaction,
  scanSessionText,
  urlKeySegments,
  type LoadedSecrets,
  type RedactionClass,
} from './redact-sessions.js'

// ── Synthetic secrets (the four REQUIRED names) ────────────────────────────

const OAUTH = 'sk-ant-oat01-SYNTHETICoauthTOKEN0123456789abcdefghijklmnopqrstuvwxyz-TESTONLY'
const API_KEY = 'sk_agent_SYNTHETICapiKEY0123456789abcdefTESTONLY'
const DELEGATE_HEX = 'a7'.repeat(32)
const DELEGATE = `0x${DELEGATE_HEX}`
const RPC_KEY = 'SynthRpcKey0123456789abcdefXYZ'
const RPC = `https://base-sepolia.g.alchemy.com/v2/${RPC_KEY}`

const REQUIRED = ['CLAUDE_CODE_OAUTH_TOKEN', 'AGENT_EVALS_API_KEY', 'AGENT_EVALS_DELEGATE_KEY', 'QA_RPC_URL_BASE_SEPOLIA']
const OPTIONAL = ['QA_HOSTED_MCP_URL', 'AGENT_EVALS_HAVEN_API_URL']
const ENV: Record<string, string> = {
  CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
  AGENT_EVALS_API_KEY: API_KEY,
  AGENT_EVALS_DELEGATE_KEY: DELEGATE,
  QA_RPC_URL_BASE_SEPOLIA: RPC,
}

// ── What must survive ──────────────────────────────────────────────────────

const HOSTED_MCP_URL = 'https://haven-mcp-dev.example.test/v1'
const TX_HASH = `0x${'5c'.repeat(32)}`
const PAYMENT_ID = '09bf4190-7b15-4088-8f2f-0ec58b71b29a'
const SURVIVORS = {
  payment_id: PAYMENT_ID,
  tx_hash: TX_HASH,
  error_code: 'delegation_budget_exceeded',
  next_tool_name: 'haven_get_payment_status',
  hosted_mcp_url: HOSTED_MCP_URL,
  idempotency_key: 'x402q:6f328174-0000-4000-8000-000000000000',
  to: `0x${'12'.repeat(20)}`,
  amount: '1000',
}

// ── Canaries, one per class (foreign values unless the class is a loaded secret) ──

const API_KEY_BODY = API_KEY.slice('sk_agent_'.length)
const API_KEY_B64 = Buffer.from(API_KEY).toString('base64').replace(/=+$/, '')
const API_KEY_B64_OFFSET1 = Buffer.from(`x${API_KEY}yz`).toString('base64') // the key at byte offset 1 of a longer blob
const OAUTH_B64URL = Buffer.from(OAUTH).toString('base64url')
const B64_PAYMENT = Buffer.from('payment-canary-synthetic-0123456789').toString('base64') // not eyJ: isolates the class
const B64_SIWX = Buffer.from('siwx-canary-synthetic-0123456789').toString('base64')
const B64_JSON = Buffer.from(JSON.stringify({ transaction: TX_HASH, synthetic: 'b64-canary' })).toString('base64')
const JWT = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzeW50aGV0aWMtY2FuYXJ5In0.c3ludGhldGljLXNpZw'
const SIG_130 = `0x${'cd'.repeat(65)}`
const SIG_KEYED = `0x${'be'.repeat(40)}` // 80 hex: only the key rule can see it

interface Canary {
  /** Strings that must not survive. */
  needles: string[]
  /** The fields planted in each position. */
  obj: Record<string, unknown>
}

const CANARIES: Record<RedactionClass, Canary> = {
  'secret-exact': {
    needles: [DELEGATE_HEX, DELEGATE_HEX.toUpperCase(), API_KEY_BODY, API_KEY_B64],
    obj: {
      note: `key ${DELEGATE} and ${DELEGATE_HEX.toUpperCase()} again`,
      // The prefix-stripped body and base64 renderings of loaded secrets.
      stripped: `body ${API_KEY_BODY} only`,
      encoded: `${API_KEY_B64} / ${API_KEY_B64_OFFSET1} / ${OAUTH_B64URL}`,
    },
  },
  'rpc-key': { needles: [RPC_KEY], obj: { error: `HTTP request failed. URL: ${RPC} status 429` } },
  'agent-key': { needles: ['sk_agent_'], obj: { note: 'a foreign key sk_agent_FOREIGNsynthetic9876543210zyxw appeared' } },
  'anthropic-key': { needles: ['sk-ant-'], obj: { note: 'a foreign token sk-ant-api03-FOREIGNsynthetic_0123456789-abc' } },
  'auth-header': {
    needles: ['hv_tok_synthetic_0123456789', 'hv_tok_synthetic_bearer_9876543210'],
    obj: { headers: { Authorization: 'Token hv_tok_synthetic_0123456789' }, note: 'retry with Bearer hv_tok_synthetic_bearer_9876543210 now' },
  },
  'payment-header': {
    needles: [B64_PAYMENT],
    obj: { payment_header: B64_PAYMENT, retry_headers: { 'PAYMENT-SIGNATURE': B64_PAYMENT, 'X-PAYMENT': B64_PAYMENT } },
  },
  'siwx-header': { needles: [B64_SIWX], obj: { sign_in_with_x_header: B64_SIWX, headers: { 'SIGN-IN-WITH-X': B64_SIWX } } },
  signature: { needles: [SIG_KEYED, SIG_130.slice(2)], obj: { signature: SIG_KEYED, note: `signed ${SIG_130} ok` } },
  'b64-json': { needles: [B64_JSON.slice(0, 24), 'eyJhbGciOiJub25l'], obj: { payment_response: B64_JSON, note: `link ?t=${JWT}` } },
  'merchant-body': {
    needles: ['MERCHANT-PAID-CANARY'],
    obj: {
      payment_id: PAYMENT_ID,
      settled: true,
      result: {
        content: [{ type: 'text', text: 'MERCHANT-PAID-CANARY your vpn config' }],
        structuredContent: { summary: { product_name: 'MERCHANT-PAID-CANARY-product', seats: 3 }, wg_config: 'MERCHANT-PAID-CANARY-wg' },
        isError: false,
      },
      merchant_body: 'MERCHANT-PAID-CANARY-body',
    },
  },
}

const POSITIONS = ['top', 'nested-text', 'bare-string', 'unparseable'] as const
type Position = (typeof POSITIONS)[number]

function envelope(data: Record<string, unknown>) {
  return { contract_fingerprint: 'fp_synthetic', server_version: '0.0.0-test', success: true, data }
}

function lineAt(position: Position, obj: Record<string, unknown>): string {
  const nested = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: [{ type: 'text', text: JSON.stringify(envelope(obj), null, 2) }] }] },
  })
  switch (position) {
    case 'top':
      return JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__haven-eval__haven_submit', input: obj }] } })
    case 'nested-text':
      return nested
    case 'bare-string':
      return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: JSON.stringify(envelope(obj)) }] } })
    case 'unparseable':
      return nested.slice(0, -9)
  }
}

function secrets(env: Record<string, string> = ENV, optional = OPTIONAL): LoadedSecrets {
  const loaded = loadSecrets(env, REQUIRED, optional)
  if (!loaded.ok) throw new Error(`fixture secrets refused: ${loaded.missing.join(', ')}`)
  return loaded.secrets
}

/** The acceptance grep on #4137, as a regex. */
const ACCEPTANCE_GREP = /sk_agent_|sk-ant-|Bearer [A-Za-z0-9]|"payment_header":"[^[]|PAYMENT-SIGNATURE":"[^[]|eyJ[A-Za-z0-9_-]{20,}|0x[0-9a-fA-F]{130}/g

const ALL_SECRET_VALUES = [OAUTH, API_KEY, DELEGATE, DELEGATE_HEX, RPC, RPC_KEY]

describe('redactSessionText: every class, every position', () => {
  for (const cls of REDACTION_CLASSES) {
    for (const position of POSITIONS) {
      it(`${cls} at ${position}: no canary survives, and the class marker replaces it`, () => {
        const raw = lineAt(position, CANARIES[cls].obj)
        if (position === 'unparseable') expect(() => JSON.parse(raw)).toThrow()
        for (const needle of CANARIES[cls].needles) expect(raw.toLowerCase()).toContain(needle.toLowerCase())
        const { text, counts } = redactSessionText(raw, { secrets: secrets() })
        for (const needle of CANARIES[cls].needles) expect(text.toLowerCase()).not.toContain(needle.toLowerCase())
        expect(text).toContain(marker(cls))
        expect(counts[cls]).toBeGreaterThan(0)
      })
    }
  }
})

describe('redactSessionText: what is kept', () => {
  for (const position of POSITIONS) {
    it(`keeps the tx hash, payment_id, error_code, next_tool_name, idempotency key, address, amount and hosted MCP URL at ${position}`, () => {
      const raw = lineAt(position, { ...SURVIVORS, note: `called ${HOSTED_MCP_URL} for ${TX_HASH}` })
      const { text, counts } = redactSessionText(raw, { secrets: secrets() })
      for (const value of Object.values(SURVIVORS)) expect(text).toContain(value)
      expect(Object.values(counts).every((n) => n === 0)).toBe(true)
      if (position !== 'unparseable') expect(JSON.parse(text)).toEqual(JSON.parse(raw))
    })
  }

  it('re-serializes the nested envelope in place, and the tool flow stays readable', () => {
    const raw = lineAt('nested-text', { ...CANARIES['payment-header'].obj, ...SURVIVORS })
    const { text } = redactSessionText(raw, { secrets: secrets() })
    const line = JSON.parse(text)
    const block = line.message.content[0]
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', is_error: false })
    const inner = JSON.parse(block.content[0].text)
    expect(deepFind(inner, 'payment_id')).toBe(PAYMENT_ID)
    expect(deepFind(inner, 'next_tool_name')).toBe('haven_get_payment_status')
    expect(inner.data.retry_headers['PAYMENT-SIGNATURE']).toBe(marker('payment-header'))
    // Pretty-printed as toMcpResult writes it.
    expect(block.content[0].text).toContain('\n  "contract_fingerprint"')
  })

  it('strips only the merchant body content: keys, nesting, flags and MCP block types stay', () => {
    const raw = lineAt('nested-text', CANARIES['merchant-body'].obj)
    const { text } = redactSessionText(raw, { secrets: secrets() })
    const data = JSON.parse(JSON.parse(text).message.content[0].content[0].text).data
    const M = marker('merchant-body')
    expect(data.payment_id).toBe(PAYMENT_ID)
    expect(data.settled).toBe(true)
    expect(data.merchant_body).toBe(M)
    expect(data.result).toEqual({
      content: [{ type: 'text', text: M }],
      structuredContent: { summary: { product_name: M, seats: M }, wg_config: M },
      isError: false,
    })
  })

  it('keeps the stream result line (the agent text), flags and a tool_use input without a merchant result', () => {
    const raw = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify({ requires_signature: true, signature: null, settled: false }) }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Paid 0.001 USDC, payment ' + PAYMENT_ID, total_cost_usd: 0.05 }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_2', name: 'mcp__haven-eval__haven_complete_mcp_tool', input: { payment_id: PAYMENT_ID } }] } }),
    ].join('\n')
    expect(redactSessionText(raw, { secrets: secrets() }).text).toBe(raw)
  })

  it('a URL-shaped secret keeps its shape: only the key segment goes', () => {
    const { text } = redactSessionText(JSON.stringify({ e: `fetch ${RPC} failed` }), { secrets: secrets() })
    expect(text).toContain(`https://base-sepolia.g.alchemy.com/v2/${marker('rpc-key')}`)
    expect(urlKeySegments(RPC)).toEqual([RPC_KEY])
    expect(urlKeySegments('https://lb.drpc.example/ogrpc?network=base&dkey=Dk0123456789abcdef')).toEqual(['Dk0123456789abcdef'])
  })

  it('an optional fallback is redacted only when set as a secret', () => {
    const tenantKey = 'tenantSecretSegment0123456789'
    const unset = redactSessionText(JSON.stringify({ u: HOSTED_MCP_URL }), { secrets: secrets() })
    expect(unset.text).toContain(HOSTED_MCP_URL)
    const set = secrets({ ...ENV, QA_HOSTED_MCP_URL: `${HOSTED_MCP_URL}/${tenantKey}` })
    expect(set.loaded).toContain('QA_HOSTED_MCP_URL')
    const { text } = redactSessionText(JSON.stringify({ u: `${HOSTED_MCP_URL}/${tenantKey}` }), { secrets: set })
    expect(text).toContain(`${HOSTED_MCP_URL}/${marker('rpc-key')}`)
    expect(text).not.toContain(tenantKey)
  })

  it('the loaded API key and OAuth token go as exact values, prefix included', () => {
    const raw = JSON.stringify({ note: `${API_KEY} / ${OAUTH}` })
    const { text } = redactSessionText(raw, { secrets: secrets() })
    expect(text).toBe(JSON.stringify({ note: `${marker('secret-exact')} / ${marker('secret-exact')}` }))
  })

  it('header names match case-insensitively', () => {
    const raw = JSON.stringify({ h: { authorization: 'abc123token', 'payment-signature': B64_PAYMENT, 'x-payment': B64_PAYMENT, 'Sign-In-With-X': B64_SIWX } })
    const { text } = redactSessionText(raw, { secrets: secrets() })
    expect(JSON.parse(text).h).toEqual({
      authorization: marker('auth-header'),
      'payment-signature': marker('payment-header'),
      'x-payment': marker('payment-header'),
      'Sign-In-With-X': marker('siwx-header'),
    })
  })

  it('a nested text that fails to parse takes the string rules, JSON-escaped forms included', () => {
    const broken = `{"payment_header": "${B64_PAYMENT}", "data": ${JSON.stringify(`${API_KEY} ${SIG_130}`)}`
    const raw = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: broken }] }] } })
    const { text } = redactSessionText(raw, { secrets: secrets() })
    for (const needle of [B64_PAYMENT, API_KEY, SIG_130]) expect(text).not.toContain(needle)
  })
})

describe('scanSessionText: the independent detectors', () => {
  for (const cls of REDACTION_CLASSES) {
    it(`reports ${cls} in raw input at every position`, () => {
      for (const position of POSITIONS) {
        expect(scanSessionText(lineAt(position, CANARIES[cls].obj), secrets())[cls], position).toBeGreaterThan(0)
      }
    })
  }

  it('finds nothing in redacted output, nor in the survivors', () => {
    const raw = REDACTION_CLASSES.flatMap((cls) => POSITIONS.map((p) => lineAt(p, CANARIES[cls].obj)))
      .concat(POSITIONS.map((p) => lineAt(p, SURVIVORS)))
      .join('\n')
    const { text } = redactSessionText(raw, { secrets: secrets() })
    expect(scanSessionText(text, secrets())).toEqual(Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])))
    expect(text.match(ACCEPTANCE_GREP)).toBeNull()
  })
})

// ── The pipeline: refuse, stage, scan, move ────────────────────────────────

async function fixtureRun() {
  const root = await mkdtemp(join(tmpdir(), 'redact-4137-'))
  const inPrefix = join(root, 'claude-sessions')
  const lines = REDACTION_CLASSES.flatMap((cls) => POSITIONS.filter((p) => p !== 'unparseable').map((p) => lineAt(p, CANARIES[cls].obj)))
  await writeFile(`${inPrefix}.task-a.trial1.jsonl`, `${lines.join('\n')}\n${lineAt('top', SURVIVORS)}\n`)
  // The SIGKILL-truncated trial: every class on cut-off lines.
  await writeFile(`${inPrefix}.task-b.trial1.jsonl`, REDACTION_CLASSES.map((cls) => lineAt('unparseable', CANARIES[cls].obj)).join('\n'))
  await writeFile(join(root, 'unrelated.jsonl'), 'not a session file')
  const githubOutput = join(root, 'github-output')
  await writeFile(githubOutput, '')
  const logs: string[] = []
  return {
    root,
    stageDir: join(root, 'stage'),
    outDir: join(root, 'upload'),
    githubOutput,
    logs,
    opts: { inPrefix, stageDir: join(root, 'stage'), outDir: join(root, 'upload'), required: REQUIRED, optional: OPTIONAL, githubOutput, log: (l: string) => logs.push(l) },
  }
}

async function ls(dir: string): Promise<string[] | 'missing'> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return 'missing'
  }
}

describe('runRedaction', () => {
  it('a clean run stages, scans and moves every session file; the positive control counts every class', async () => {
    const f = await fixtureRun()
    const result = await runRedaction({ ...f.opts, env: ENV })
    expect(result.clean).toBe(true)
    expect(await ls(f.outDir)).toEqual(['claude-sessions.task-a.trial1.jsonl', 'claude-sessions.task-b.trial1.jsonl'])
    expect(await ls(f.stageDir)).toEqual([])
    expect(await readFile(f.githubOutput, 'utf8')).toBe('clean=true\n')
    for (const cls of REDACTION_CLASSES) expect(result.rawCounts[cls], cls).toBeGreaterThan(0)
    expect(Object.values(result.scanCounts).every((n) => n === 0)).toBe(true)
    for (const name of await readdir(f.outDir)) {
      const out = await readFile(join(f.outDir, name), 'utf8')
      expect(out.match(ACCEPTANCE_GREP)).toBeNull()
      for (const cls of REDACTION_CLASSES) for (const needle of CANARIES[cls].needles) expect(out.toLowerCase()).not.toContain(needle.toLowerCase())
      expect(out).toContain(PAYMENT_ID)
    }
    // Names and counts are printed; no value ever is.
    const logged = f.logs.join('\n')
    expect(logged).toContain('loaded 4 secret(s): CLAUDE_CODE_OAUTH_TOKEN, AGENT_EVALS_API_KEY, AGENT_EVALS_DELEGATE_KEY, QA_RPC_URL_BASE_SEPOLIA')
    expect(logged).toContain('optional, not set (nothing to redact): QA_HOSTED_MCP_URL, AGENT_EVALS_HAVEN_API_URL')
    expect(logged).toMatch(/payment-header: [1-9]/)
    for (const value of ALL_SECRET_VALUES) expect(logged).not.toContain(value)
  })

  for (const name of REQUIRED) {
    it(`refuses and writes nothing when ${name} is empty`, async () => {
      for (const empty of ['', '   ']) {
        const f = await fixtureRun()
        const result = await runRedaction({ ...f.opts, env: { ...ENV, [name]: empty } })
        expect(result.clean).toBe(false)
        expect(result.refused).toEqual([name])
        expect(await ls(f.stageDir)).toBe('missing')
        expect(await ls(f.outDir)).toBe('missing')
        expect(await readFile(f.githubOutput, 'utf8')).toBe('clean=false\n')
        expect(f.logs.join('\n')).toContain(`required secret(s) empty: ${name}`)
      }
    })
  }

  it('a fallback URL set as a secret with no key-bearing segment is kept whole, with a warning by name', async () => {
    const f = await fixtureRun()
    await writeFile(`${f.opts.inPrefix}.task-c.trial1.jsonl`, lineAt('nested-text', SURVIVORS))
    const result = await runRedaction({ ...f.opts, env: { ...ENV, QA_HOSTED_MCP_URL: HOSTED_MCP_URL } })
    expect(result.clean).toBe(true)
    expect(f.logs).toContain('::warning::redact-sessions: QA_HOSTED_MCP_URL is a URL with no key-bearing segment, so it is kept as it is')
    expect(await readFile(join(f.outDir, 'claude-sessions.task-c.trial1.jsonl'), 'utf8')).toContain(HOSTED_MCP_URL)
  })

  it('refuses when no required names are given at all', async () => {
    const f = await fixtureRun()
    const result = await runRedaction({ ...f.opts, required: [], env: ENV })
    expect(result.clean).toBe(false)
    expect(await ls(f.outDir)).toBe('missing')
  })

  it('refuses when the upload directory already holds files', async () => {
    const f = await fixtureRun()
    await mkdir(f.outDir)
    await writeFile(join(f.outDir, 'stale.jsonl'), 'x')
    const result = await runRedaction({ ...f.opts, env: ENV })
    expect(result.clean).toBe(false)
    expect(await ls(f.outDir)).toEqual(['stale.jsonl'])
  })

  it('an unparseable line never appears raw in the output', async () => {
    const f = await fixtureRun()
    await runRedaction({ ...f.opts, env: ENV })
    const out = await readFile(join(f.outDir, 'claude-sessions.task-b.trial1.jsonl'), 'utf8')
    const rawLines = REDACTION_CLASSES.map((cls) => lineAt('unparseable', CANARIES[cls].obj))
    const outLines = out.split('\n')
    expect(outLines).toHaveLength(rawLines.length)
    for (const [i, raw] of rawLines.entries()) expect(outLines[i]).not.toBe(raw)
  })

  it('no session files at all is a clean, empty run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'redact-4137-empty-'))
    const result = await runRedaction({ inPrefix: join(root, 'claude-sessions'), stageDir: join(root, 's'), outDir: join(root, 'u'), required: REQUIRED, optional: OPTIONAL, env: ENV, log: () => {} })
    expect(result).toMatchObject({ clean: true, files: [] })
  })

  // B2: a rule that stops redacting is caught by the scan, which runs every
  // class's own detector: nothing moves, the class is named, clean=false.
  for (const cls of REDACTION_CLASSES) {
    it(`with ${cls} redaction disabled, the scan reports ${cls}, moves nothing and sets clean=false`, async () => {
      const f = await fixtureRun()
      const result = await runRedaction({ ...f.opts, env: ENV, disabled: new Set([cls]) })
      expect(result.clean).toBe(false)
      expect(result.scanCounts[cls]).toBeGreaterThan(0)
      expect(await ls(f.outDir)).toBe('missing')
      expect(await ls(f.stageDir)).toBe('missing')
      expect(await readFile(f.githubOutput, 'utf8')).toBe('clean=false\n')
      const errors = f.logs.filter((l) => l.startsWith('::error::'))
      expect(errors.some((l) => l.includes(`scan hit after redaction: ${cls}: `))).toBe(true)
      for (const value of ALL_SECRET_VALUES) expect(f.logs.join('\n')).not.toContain(value)
    })
  }
})

// ── Review round 1 (#4137): complete-shape bodies, scan independence, hardening ──

const PAID_TOOL_USE = (id: string, tool: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__haven-eval__${tool}`, input: { payment_id: PAYMENT_ID } }] } })
const TOOL_RESULT = (id: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: [{ type: 'text', text: JSON.stringify(envelope(data), null, 2) }] }] },
    ...extra,
  })
const MERCHANT_RESULT = { content: [{ type: 'text', text: 'MERCHANT-PAID-CANARY delivered' }], structuredContent: { code: 'MERCHANT-PAID-CANARY-code' } }

/** `haven_complete_mcp_tool`'s two arms (`paid-mcp-completion.ts`): no top-level payment_id on either. */
const COMPLETE_HAPPY = { status: 200, ok: true, result: MERCHANT_RESULT, settlement_tx_hash: null }
const COMPLETE_EVIDENCE = {
  status: 200,
  ok: true,
  result: MERCHANT_RESULT,
  settlement_tx_hash: TX_HASH,
  next_action: 'none',
  next_tool_name: 'haven_report_settlement_evidence',
  next_arguments: { payment_id: PAYMENT_ID, settlement_tx_hash: TX_HASH },
  agent_summary: { summary: { payment_id: PAYMENT_ID, status: 'settled' } },
}
/** A shape with NO sibling the generic rule keys on: only the tool keying can see it. */
const COMPLETE_BARE = { status: 200, ok: true, result: MERCHANT_RESULT }

describe('merchant-body: haven_complete_mcp_tool and refusal echoes', () => {
  for (const [arm, data] of [['happy', COMPLETE_HAPPY], ['evidence', COMPLETE_EVIDENCE], ['bare', COMPLETE_BARE]] as const) {
    for (const tool of ['haven_complete_mcp_tool', 'haven_settle_mcp_tool']) {
      it(`${tool} ${arm} arm: data.result is stripped, keyed off the tool; the flow survives`, () => {
        const raw = [PAID_TOOL_USE('tu_c', tool), TOOL_RESULT('tu_c', data, { tool_use_result: [{ type: 'text', text: JSON.stringify(envelope(data)) }] })].join('\n')
        expect(scanSessionText(raw, secrets())['merchant-body']).toBeGreaterThan(0)
        const { text, counts } = redactSessionText(raw, { secrets: secrets() })
        expect(text).not.toContain('MERCHANT-PAID-CANARY')
        expect(counts['merchant-body']).toBeGreaterThan(0)
        const line = JSON.parse(text.split('\n')[1])
        const inner = JSON.parse(line.message.content[0].content[0].text).data
        expect(inner.result).toEqual({ content: [{ type: 'text', text: marker('merchant-body') }], structuredContent: { code: marker('merchant-body') } })
        expect(inner.status).toBe(200)
        if (arm === 'evidence') expect(deepFind(inner, 'next_tool_name')).toBe('haven_report_settlement_evidence')
        expect(scanSessionText(text, secrets())).toEqual(Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])))
      })
    }
  }

  it('without the tool_use line, a result beside settlement_tx_hash is still stripped', () => {
    const { text } = redactSessionText(TOOL_RESULT('tu_missing', COMPLETE_HAPPY), { secrets: secrets() })
    expect(text).not.toContain('MERCHANT-PAID-CANARY')
  })

  it('the scan predicate is broader than the redactor: an unkeyed bare result still fails the run', async () => {
    // No tool_use line and no sibling field: the redactor cannot know it is
    // paid, so it stays — and the scan's "any nested result" predicate catches it.
    const raw = TOOL_RESULT('tu_missing', COMPLETE_BARE)
    expect(redactSessionText(raw, { secrets: secrets() }).text).toContain('MERCHANT-PAID-CANARY')
    const root = await mkdtemp(join(tmpdir(), 'redact-4137-bare-'))
    await writeFile(join(root, 'claude-sessions.t.trial1.jsonl'), raw)
    const result = await runRedaction({ inPrefix: join(root, 'claude-sessions'), stageDir: join(root, 's'), outDir: join(root, 'u'), required: REQUIRED, optional: OPTIONAL, env: ENV, log: () => {} })
    expect(result.clean).toBe(false)
    expect(result.scanCounts['merchant-body']).toBeGreaterThan(0)
    expect(await ls(join(root, 'u'))).toBe('missing')
  })

  it('a non-paid tool result without result keeps every field', () => {
    const raw = [PAID_TOOL_USE('tu_g', 'haven_get_payment_status'), TOOL_RESULT('tu_g', { payment_id: PAYMENT_ID, status: 'settled', tx_hash: TX_HASH })].join('\n')
    expect(redactSessionText(raw, { secrets: secrets() }).text).toBe(raw)
  })

  const REFUSAL = {
    success: false,
    code: 'MERCHANT_REJECTED_AFTER_FUNDING',
    message: `Merchant rejected the payment after funding (HTTP 500). Merchant response: ${JSON.stringify({ content: [{ text: 'MERCHANT-PAID-CANARY refusal' }] })}`,
    next_tool_name: 'haven_get_payment_status',
  }
  for (const position of POSITIONS) {
    it(`strips the merchant body echoed in a refusal message at ${position}`, () => {
      const raw = lineAt(position, REFUSAL)
      const { text } = redactSessionText(raw, { secrets: secrets() })
      expect(text).not.toContain('MERCHANT-PAID-CANARY')
      expect(text).toContain(`Merchant response: ${marker('merchant-body')}`)
      if (position !== 'unparseable') expect(text).toContain('haven_get_payment_status')
      expect(scanSessionText(text, secrets())['merchant-body']).toBe(0)
      expect(scanSessionText(raw, secrets())['merchant-body']).toBeGreaterThan(0)
    })
  }
})

it('keeps the agent text: a plain-prose purchase summary survives unchanged (owner decision 2026-10-20)', () => {
  const summary = `I bought the basic VPN plan for 0.001 USDC (payment ${PAYMENT_ID}, settlement ${TX_HASH}). The merchant confirmed the purchase and sent the config.`
  const raw = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: summary }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: summary, total_cost_usd: 0.05 }),
  ].join('\n')
  const { text, counts } = redactSessionText(raw, { secrets: secrets() })
  expect(text).toBe(raw)
  expect(Object.values(counts).every((n) => n === 0)).toBe(true)
  expect(scanSessionText(text, secrets())).toEqual(Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])))
})

describe('the scan does not reuse the redactor needles', () => {
  const raw = lineAt('nested-text', { ...CANARIES['secret-exact'].obj, ...CANARIES['rpc-key'].obj })

  it('with the needles emptied, the scan still finds secret-exact and rpc-key', () => {
    const broken = { ...secrets(), needles: [] }
    const { text } = redactSessionText(raw, { secrets: broken })
    const counts = scanSessionText(text, broken)
    expect(counts['secret-exact']).toBeGreaterThan(0)
    expect(counts['rpc-key']).toBeGreaterThan(0)
  })

  it('with the case-insensitive flag lost (M1), the uppercase delegate key is still found', () => {
    const s = secrets()
    const broken = { ...s, needles: s.needles.map((n) => ({ ...n, re: new RegExp(n.re.source, n.re.flags.replace('i', '')) })) }
    const { text } = redactSessionText(raw, { secrets: broken })
    expect(text).toContain(DELEGATE_HEX.toUpperCase())
    expect(scanSessionText(text, broken)['secret-exact']).toBeGreaterThan(0)
  })

  it('a base64 rendering the needles missed is found by decoding', () => {
    const blob = Buffer.from(`zz${API_KEY}`).toString('base64')
    const broken = { ...secrets(), needles: [] }
    expect(scanSessionText(JSON.stringify({ blob }), broken)['secret-exact']).toBeGreaterThan(0)
  })
})

describe('hardening', () => {
  it('matches camelCase and squashed key names', () => {
    const raw = JSON.stringify({ paymentHeader: B64_PAYMENT, paymentSignature: B64_PAYMENT, delegationSignature: SIG_KEYED, signInWithX: B64_SIWX, merchantBody: 'MERCHANT-PAID-CANARY' })
    const { text } = redactSessionText(raw, { secrets: secrets() })
    expect(JSON.parse(text)).toEqual({
      paymentHeader: marker('payment-header'),
      paymentSignature: marker('payment-header'),
      delegationSignature: marker('signature'),
      signInWithX: marker('siwx-header'),
      merchantBody: marker('merchant-body'),
    })
    const cut = redactSessionText(`{"x": "paymentHeader": "${B64_PAYMENT}", "delegationSignature": "${SIG_KEYED}"`, { secrets: secrets() }).text
    expect(cut).not.toContain(B64_PAYMENT)
    expect(cut).not.toContain(SIG_KEYED)
  })

  it('decodes \\uXXXX on an unparseable line before the rules and the scan', () => {
    const raw = lineAt('unparseable', { note: 'x' }).replace('\\"x\\"', '\\"sk\\\\u005fagent\\\\u005fFOREIGNsynthetic9876543210\\"')
    expect(raw).toContain('u005f')
    expect(scanSessionText(raw, secrets())['agent-key']).toBeGreaterThan(0)
    const { text } = redactSessionText(raw, { secrets: secrets() })
    expect(text).not.toContain('FOREIGNsynthetic9876543210')
    expect(scanSessionText(text, secrets())['agent-key']).toBe(0)
  })

  it('rpc-key skips public network slugs', () => {
    const key = 'DrpcKey0123456789abcdef'
    const s = secrets({ ...ENV, QA_RPC_URL_BASE_SEPOLIA: `https://lb.drpc.example/base-sepolia/${key}` })
    expect(urlKeySegments(`https://lb.drpc.example/base-sepolia/${key}`)).toEqual([key])
    const { text } = redactSessionText(JSON.stringify({ e: `chain base-sepolia via https://lb.drpc.example/base-sepolia/${key}` }), { secrets: s })
    expect(JSON.parse(text).e).toBe(`chain base-sepolia via https://lb.drpc.example/base-sepolia/${marker('rpc-key')}`)
    expect(scanSessionText(text, s)).toEqual(Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])))
  })

  it('a REQUIRED URL secret with no key segment is redacted whole', () => {
    const s = secrets({ ...ENV, QA_RPC_URL_BASE_SEPOLIA: 'https://rpc.example.test' })
    expect(s.urlsWithoutKey).toEqual([])
    const { text } = redactSessionText(JSON.stringify({ e: 'fetch https://rpc.example.test failed' }), { secrets: s })
    expect(JSON.parse(text).e).toBe(`fetch ${marker('secret-exact')} failed`)
    expect(scanSessionText(text, s)['secret-exact']).toBe(0)
    expect(scanSessionText(JSON.stringify({ e: 'https://rpc.example.test' }), s)['secret-exact']).toBeGreaterThan(0)
  })

  it('stays linear: a hostile 200 KB line redacts and scans in under 2 s', () => {
    const chunk = `${'\\'.repeat(40)}"signature${'\\'.repeat(9)}: ${'a-'.repeat(200)} "result" ${' '.repeat(50)}authorization${'\\'.repeat(30)} sk_agent_ eyJ${'A'.repeat(30)} `
    const hostile = chunk.repeat(Math.ceil(200_000 / chunk.length)).slice(0, 200_000)
    const structural = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: hostile }] } })
    const started = Date.now()
    for (const line of [hostile, structural]) {
      const { text } = redactSessionText(line, { secrets: secrets() })
      scanSessionText(text, secrets())
    }
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

// ── Review round 2 (#4137) ─────────────────────────────────────────────────

describe('round 2: escapes in parseable lines, unbounded whitespace, first unmarked cut', () => {
  const escapeUnderscores = (s: string) => s.replace(/_/g, '\\u005f')

  it('a \\uXXXX-escaped secret inside non-JSON text on a parseable line is redacted, and the scan sees the raw one', () => {
    const text = `Error: {"k":"${escapeUnderscores(API_KEY)}","f":"${escapeUnderscores('sk_agent_FOREIGNsynthetic9876543210')}"} trailing`
    const raw = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_e', content: [{ type: 'text', text }] }] } })
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(raw).toContain('u005fagent')
    const before = scanSessionText(raw, secrets())
    expect(before['secret-exact']).toBeGreaterThan(0)
    expect(before['agent-key']).toBeGreaterThan(0)
    const { text: out } = redactSessionText(raw, { secrets: secrets() })
    expect(out).not.toContain('SYNTHETICapiKEY')
    expect(out).not.toContain('FOREIGNsynthetic9876543210')
    expect(scanSessionText(out, secrets())).toEqual(Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])))
  })

  it('nine or more spaces after a header key or Bearer do not hide a token', () => {
    const pad = ' '.repeat(12)
    const raw = JSON.stringify({
      note: `Authorization:${pad}Token hv_tok_synthetic_spaced_0123456789 and Bearer${pad}hv_tok_synthetic_bearer_spaced_0123 and payment_header${pad}=${pad}${B64_PAYMENT}`,
    })
    const before = scanSessionText(raw, secrets())
    expect(before['auth-header']).toBeGreaterThan(0)
    expect(before['payment-header']).toBeGreaterThan(0)
    const { text } = redactSessionText(raw, { secrets: secrets() })
    for (const needle of ['hv_tok_synthetic_spaced_0123456789', 'hv_tok_synthetic_bearer_spaced_0123', B64_PAYMENT]) expect(text).not.toContain(needle)
    expect(scanSessionText(text, secrets())).toEqual(Object.fromEntries(REDACTION_CLASSES.map((c) => [c, 0])))
  })

  it('a planted, already-marked result does not shield a real body after it', () => {
    const planted = `{"result":"${marker('merchant-body')}","next":{"result":{"text":"MERCHANT-PAID-CANARY late"}`
    const raw = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_p', content: [{ type: 'text', text: planted }] }] } })
    const { text } = redactSessionText(raw, { secrets: secrets() })
    expect(text).not.toContain('MERCHANT-PAID-CANARY')
    expect(scanSessionText(text, secrets())['merchant-body']).toBe(0)
    const cut = redactSessionText(`{"x": "Merchant response: ${marker('merchant-body')} then Merchant response: MERCHANT-PAID-CANARY`, { secrets: secrets() }).text
    expect(cut).not.toContain('MERCHANT-PAID-CANARY')
  })

  // The scanner's "any nested result is a merchant body" predicate and the
  // redactor's tool keying both rest on this: among the hosted tools, only
  // the paid-completion module emits a `result` field, and in it only the
  // delivery helper and the two paid tools do (above the first other handler).
  it('only haven_complete_mcp_tool / haven_settle_mcp_tool emit a result field among the hosted tools', async () => {
    const root = fileURLToPath(new URL('../../../mcp-server/src/', import.meta.url))
    const files = (await readdir(root, { recursive: true }))
      .map(String)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.includes('test-support'))
    const RESULT_FIELD = /^\s+result\s*[:,]/
    const emitting: string[] = []
    for (const f of files) if ((await readFile(join(root, f), 'utf8')).split('\n').some((l) => RESULT_FIELD.test(l))) emitting.push(f)
    expect(emitting).toEqual([join('tools', 'paid-mcp-completion.ts')])
    const lines = (await readFile(join(root, 'tools', 'paid-mcp-completion.ts'), 'utf8')).split('\n')
    const handlers = lines.map((l, i) => [l.match(/^\s+(haven_[a-z_]+): async/)?.[1], i] as const).filter(([n]) => n)
    const paid = handlers.filter(([n]) => n === 'haven_complete_mcp_tool' || n === 'haven_settle_mcp_tool')
    expect(paid.map(([n]) => n)).toEqual(['haven_complete_mcp_tool', 'haven_settle_mcp_tool'])
    const firstOther = Math.min(...handlers.filter(([n]) => !paid.some(([p]) => p === n)).map(([, i]) => i))
    for (const [i, l] of lines.entries()) if (RESULT_FIELD.test(l)) expect(i, `result field at paid-mcp-completion.ts:${i + 1}`).toBeLessThan(firstOther)
  })
})
