/**
 * Catalogue verification probe tests (epic #1717, #1713).
 *
 * Pure-unit: the one I/O seam (`post`) is injected. The network is exactly the
 * collaborator a test must not reach for real, and the *database* claims in
 * this slice — the leader lock — live in the real-Postgres test beside
 * `platform/__tests__/catalog-ingest-lock.test.ts`, per epic #1219.
 *
 * The bar: every guard here has a test that shows it saying NO, and the
 * read-only discipline is pinned by an assertion that would fail if a signer
 * ever appeared in this module's import graph.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, vi } from 'vitest'
import {
  HostCooldown,
  candidateHostname,
  probeSubmission,
  redactProbeOutcome,
  runProbeBatch,
  type GuardedPost,
  type ProbeOutcome,
} from '../probe.js'
import type { SafeFetchResult } from '../../../infra/http/ssrf-guard.js'

const URL_UNDER_TEST = 'https://merchant.example/mcp'

function ok(status: number, body: unknown, headers: Record<string, string> = {}): SafeFetchResult {
  return {
    ok: true,
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    finalUrl: URL_UNDER_TEST,
  }
}

const INITIALIZE_OK = ok(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })
const TOOLS_LIST_OK = ok(200, {
  jsonrpc: '2.0',
  id: 2,
  result: { tools: [{ name: 'summarize', description: 'Summarize a document' }] },
})
const PAID_402 = ok(402, {
  jsonrpc: '2.0',
  id: 3,
  error: {
    code: -32000,
    message: 'Payment Required',
    data: {
      payment_required: {
        accepts: [{ scheme: 'exact', network: 'eip155:8453', maxAmountRequired: '10000' }],
        extensions: {
          bazaar: {
            schema: {
              name: 'Summarizer',
              description: 'Summarizes documents for 0.01 USDC',
              entrypoint: 'summarize',
            },
          },
        },
      },
    },
  },
})

/** A scripted transport: one response per leg, in order. */
function scripted(...responses: SafeFetchResult[]): GuardedPost & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const post = (async (url: string, payload: unknown, options?: unknown) => {
    calls.push([url, payload, options])
    const next = responses[calls.length - 1]
    if (next === undefined) throw new Error(`no scripted response for call ${calls.length}`)
    return next
  }) as GuardedPost & { calls: unknown[][] }
  post.calls = calls
  return post
}

describe('probeSubmission — the happy path', () => {
  it('walks initialize → tools/list → unpaid tool call and parses the bazaar schema', async () => {
    const post = scripted(INITIALIZE_OK, TOOLS_LIST_OK, PAID_402)
    const result = await probeSubmission(URL_UNDER_TEST, { post, now: () => new Date('2026-08-24T10:00:00Z') })

    expect(result.ok).toBe(true)
    expect(result).toMatchObject({
      metadata: {
        name: 'Summarizer',
        description: 'Summarizes documents for 0.01 USDC',
        entrypoint: 'summarize',
      },
    })
    expect(post.calls.map((c) => (c[1] as { method: string }).method)).toEqual([
      'initialize',
      'tools/list',
      'tools/call',
    ])
  })

  it('carries the mcp-session-id from initialize into the later legs', async () => {
    const post = scripted(
      ok(200, { result: {} }, { 'mcp-session-id': 'sess-42' }),
      TOOLS_LIST_OK,
      PAID_402,
    )
    await probeSubmission(URL_UNDER_TEST, { post })
    const secondLegOptions = post.calls[1]![2] as { extraHeaders?: Record<string, string> }
    expect(secondLegOptions.extraHeaders).toEqual({ 'mcp-session-id': 'sess-42' })
  })

  it('unwraps an SSE-framed JSON-RPC response, which is a legal MCP transport', async () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n'
    const post = scripted(ok(200, sse), TOOLS_LIST_OK, PAID_402)
    const result = await probeSubmission(URL_UNDER_TEST, { post })
    expect(result.ok).toBe(true)
  })
})

describe('probeSubmission — the refusals (a probe that never says no verifies nothing)', () => {
  it('NEVER pays: it stops at the 402 and makes exactly three calls', async () => {
    const post = scripted(INITIALIZE_OK, TOOLS_LIST_OK, PAID_402)
    await probeSubmission(URL_UNDER_TEST, { post })
    expect(post.calls).toHaveLength(3)
    // No retry with a payment header, no fourth leg, nothing resembling settle.
    const bodies = JSON.stringify(post.calls.map((c) => c[1]))
    expect(bodies).not.toMatch(/payment|signature|x-payment|settle/i)
  })

  it('collapses an SSRF refusal into the coarse `unreachable`, keeping the granular reason in detail', async () => {
    const post = scripted({
      ok: false,
      reason: 'address_not_public',
      detail: 'host resolves only into blocked ranges (ipv4-private)',
    })
    const result = await probeSubmission(URL_UNDER_TEST, { post })
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', leg: 'initialize' })
    expect((result as { detail: string }).detail).toContain('ipv4-private')
  })

  it('fails `not_mcp` when initialize answers no JSON-RPC result', async () => {
    const post = scripted(ok(200, { hello: 'world' }))
    const result = await probeSubmission(URL_UNDER_TEST, { post })
    expect(result).toMatchObject({ ok: false, reason: 'not_mcp', leg: 'initialize' })
  })

  it('fails `no_payable_tool` when the server advertises no tools', async () => {
    const post = scripted(INITIALIZE_OK, ok(200, { result: { tools: [] } }))
    const result = await probeSubmission(URL_UNDER_TEST, { post })
    expect(result).toMatchObject({ ok: false, reason: 'no_payable_tool', leg: 'tools/list' })
  })

  it('fails `no_payable_tool` when the tool call simply succeeds — a FREE endpoint is not payable', async () => {
    // The dangerous false positive: a working MCP server that costs nothing
    // would be listed as `verified_payable` by any check that only asks
    // "did it answer".
    const post = scripted(INITIALIZE_OK, TOOLS_LIST_OK, ok(200, { result: { content: [] } }))
    const result = await probeSubmission(URL_UNDER_TEST, { post })
    expect(result).toMatchObject({ ok: false, reason: 'no_payable_tool', leg: 'tools/call' })
  })

  it('fails `malformed_challenge` when a 402 carries no extensions.bazaar.schema', async () => {
    const post = scripted(INITIALIZE_OK, TOOLS_LIST_OK, ok(402, { error: { data: { payment_required: {} } } }))
    const result = await probeSubmission(URL_UNDER_TEST, { post })
    expect(result).toMatchObject({ ok: false, reason: 'malformed_challenge', leg: 'tools/call' })
  })

  it('asks the guard for zero redirects on every leg', async () => {
    const post = scripted(INITIALIZE_OK, TOOLS_LIST_OK, PAID_402)
    await probeSubmission(URL_UNDER_TEST, { post })
    for (const call of post.calls) {
      expect((call[2] as { maxRedirects: number }).maxRedirects).toBe(0)
    }
  })

  it('passes a bounded timeout and byte cap down to every leg', async () => {
    const post = scripted(INITIALIZE_OK, TOOLS_LIST_OK, PAID_402)
    await probeSubmission(URL_UNDER_TEST, { post, legTimeoutMs: 1234, maxBytes: 5678 })
    for (const call of post.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 1234, maxBytes: 5678 })
    }
  })
})

describe('read-only discipline, pinned structurally (#1713 AC1)', () => {
  const source = readFileSync(fileURLToPath(new URL('../probe.ts', import.meta.url)), 'utf8')
  /**
   * Executable source only. The docstrings deliberately DISCUSS signing,
   * settling and x402 — that prose is the instruction to the next reader, and
   * an assertion that forbade the words would push the explanation out of the
   * file to keep itself green.
   */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('imports nothing that can sign or settle', () => {
    // "The probe never signs" is easy to say and easy to stop being true. This
    // reads the module's own import lines, so a future edit that pulls in a
    // signer fails HERE rather than in a review nobody ran.
    const imports = code.match(/from '([^']+)'/g) ?? []
    const specifiers = imports.map((line) => line.match(/from '([^']+)'/)![1]!)
    expect(specifiers).toEqual(['../../infra/http/ssrf-guard.js'])
  })

  it('names no signing, settling or key-bearing symbol in executable code', () => {
    expect(code).not.toMatch(/signer|privateKey|walletClient|settle|redeemDelegation|X-PAYMENT/i)
  })

  it('uses the SSRF guard, never a bare fetch', () => {
    // Match a call, not the word in prose — the docstring names `fetch`
    // deliberately to tell the next reader not to reintroduce one.
    expect(code).not.toMatch(/(?<![\w.])fetch\s*\(/)
  })
})

describe('redactProbeOutcome — the internal-DNS oracle', () => {
  const failed: ProbeOutcome = {
    id: 'sub_1',
    status: 'failed',
    reason: 'unreachable',
    detail: 'address_not_public: host resolves only into blocked ranges (ipv4-private)',
    leg: 'initialize',
  }

  it('drops every granular token an untrusted caller could read as an oracle', () => {
    const serialised = JSON.stringify(redactProbeOutcome(failed))
    for (const token of ['ipv4-private', 'ipv6-unique-local', 'dns_failure', 'address_not_public', 'initialize']) {
      expect(serialised).not.toContain(token)
    }
    // …while still telling a genuine merchant that it did not answer.
    expect(JSON.parse(serialised)).toEqual({ id: 'sub_1', status: 'failed', reason: 'unreachable' })
  })

  it('keeps the parsed metadata on success, which is public by design', () => {
    expect(
      redactProbeOutcome({
        id: 'sub_2',
        status: 'verified_payable',
        metadata: { name: 'Summarizer', description: null, entrypoint: 'summarize' },
        lastVerifiedAt: new Date(),
      }),
    ).toEqual({
      id: 'sub_2',
      status: 'verified_payable',
      metadata: { name: 'Summarizer', description: null, entrypoint: 'summarize' },
    })
  })
})

describe('runProbeBatch — the two budgets', () => {
  /** A post that records peak concurrency across a batch. */
  function concurrencyTracking(delayMs: number) {
    let inFlight = 0
    let peak = 0
    const post: GuardedPost = async (_url, payload) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, delayMs))
      inFlight -= 1
      const method = (payload as { method: string }).method
      if (method === 'initialize') return INITIALIZE_OK
      if (method === 'tools/list') return TOOLS_LIST_OK
      return PAID_402
    }
    return { post, peak: () => peak }
  }

  it('never exceeds the global concurrency cap under a burst of eligible rows', async () => {
    const { post, peak } = concurrencyTracking(20)
    const candidates = Array.from({ length: 12 }, (_, i) => ({
      id: `sub_${i}`,
      resourceUrl: `https://host${i}.example/mcp`,
    }))
    const outcomes = await runProbeBatch(candidates, { post, maxConcurrency: 3 })

    expect(outcomes).toHaveLength(12)
    expect(outcomes.every((o) => o.status === 'verified_payable')).toBe(true)
    expect(peak()).toBeLessThanOrEqual(3)
    // And it really did run in parallel — a cap of 3 that behaved like 1 would
    // pass the line above while being a different bug.
    expect(peak()).toBeGreaterThan(1)
  })

  it('probes one hostname ONCE in a burst pointed at a single victim', async () => {
    const { post } = concurrencyTracking(0)
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      id: `sub_${i}`,
      resourceUrl: `https://victim.example/mcp/${i}`,
    }))
    const outcomes = await runProbeBatch(candidates, { post, maxConcurrency: 8 })

    expect(outcomes.filter((o) => o.status === 'verified_payable')).toHaveLength(1)
    expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(7)
  })

  it('holds the cooldown ACROSS batches, which is where a per-batch dedupe would leak', async () => {
    const { post } = concurrencyTracking(0)
    const cooldown = new HostCooldown(60_000)
    const one = [{ id: 'a', resourceUrl: 'https://victim.example/mcp' }]

    const first = await runProbeBatch(one, { post, cooldown })
    const second = await runProbeBatch(one, { post, cooldown })

    expect(first[0]!.status).toBe('verified_payable')
    expect(second[0]!.status).toBe('skipped')
  })

  it('lets a host through again once its cooldown has elapsed', async () => {
    const { post } = concurrencyTracking(0)
    const cooldown = new HostCooldown(1_000)
    const one = [{ id: 'a', resourceUrl: 'https://victim.example/mcp' }]
    let clock = new Date('2026-08-24T10:00:00Z')

    const first = await runProbeBatch(one, { post, cooldown, now: () => clock })
    clock = new Date('2026-08-24T10:00:02Z')
    const second = await runProbeBatch(one, { post, cooldown, now: () => clock })

    expect(first[0]!.status).toBe('verified_payable')
    expect(second[0]!.status).toBe('verified_payable')
  })

  it('records the cooldown BEFORE dispatch, so a concurrent burst cannot slip past a check-then-act', async () => {
    // #1711's queue cap was a non-atomic count-then-insert and was proven not
    // to be a cap at all. The same shape here — record on completion — would
    // let every row for one host pass the check while the first probe is still
    // in flight. `post` here never resolves, so nothing has completed when the
    // later candidates are admitted.
    const post = vi.fn<GuardedPost>(() => new Promise(() => {}))
    const cooldown = new HostCooldown(60_000)
    const candidates = Array.from({ length: 5 }, (_, i) => ({
      id: `sub_${i}`,
      resourceUrl: 'https://victim.example/mcp',
    }))
    const batch = runProbeBatch(candidates, { post, cooldown, maxConcurrency: 5 })
    await new Promise((r) => setTimeout(r, 20))
    // One probe dispatched, four already admitted-and-skipped.
    expect(post).toHaveBeenCalledTimes(1)
    void batch
  })

  it('fails an unparseable resource_url without dispatching anything', async () => {
    const post = vi.fn<GuardedPost>(async () => INITIALIZE_OK)
    const outcomes = await runProbeBatch([{ id: 'bad', resourceUrl: 'not a url' }], { post })
    expect(outcomes[0]).toMatchObject({ status: 'failed', reason: 'unreachable' })
    expect(post).not.toHaveBeenCalled()
  })
})

describe('candidateHostname', () => {
  it('lowercases, so HOST.example and host.example share one cooldown', () => {
    expect(candidateHostname('https://HOST.Example/mcp')).toBe('host.example')
  })

  it('returns null rather than throwing on an unparseable url', () => {
    expect(candidateHostname('::::')).toBeNull()
  })
})
