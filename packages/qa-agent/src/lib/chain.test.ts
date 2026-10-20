import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ethers } from 'ethers'
import { describeObserverRpc, GET_LOGS_MAX_RANGE, GET_LOGS_TIP_RESCAN, proveUsdcTransfer, redactUrls, proveUsdcTransferSince, SEPOLIA_USDC, usdcTransfers, waitForDisabled, waitForReceipt } from './chain.js'

/**
 * The observer-RPC announcement must never print the endpoint (#2511).
 *
 * A provider URL embeds an API key, and this line goes to a CI log that is
 * public on a public repo and gets quoted into `qa-failure` issue bodies. The
 * repo's secret-safety rule is the same for a run report as for a credential
 * file, so it is asserted rather than trusted to a ternary.
 *
 * The other half is why the function exists at all: between PR #2553 and this
 * change, `QA_RPC_URL_BASE_SEPOLIA` was read by `chain.ts` and passed in by
 * nothing, so an operator could file the secret and the observer would stay on
 * the public endpoint. A set variable and an unset one produced identical
 * logs, which is precisely what let it sit unreachable.
 */
describe('describeObserverRpc (#2511)', () => {
  const SECRET = 'https://base-sepolia.g.alchemy.com/v2/NOT-A-REAL-KEY'

  it('never puts the endpoint in the line it produces', () => {
    const line = describeObserverRpc(SECRET)
    expect(line).not.toContain('NOT-A-REAL-KEY')
    expect(line).not.toContain('alchemy')
    // Positive control: the matcher finds the key when it IS present, so the
    // two negatives above are facts about the line and not about `toContain`.
    expect(`observer RPC → ${SECRET}`).toContain('NOT-A-REAL-KEY')
  })

  it('says WHICH class, so a triager can tell the two runs apart', () => {
    expect(describeObserverRpc(SECRET)).toMatch(/^dedicated/)
    expect(describeObserverRpc(undefined)).toMatch(/^PUBLIC/)
    // The distinction is the whole point: identical output for set and unset
    // is the state that hid the missing wiring.
    expect(describeObserverRpc(SECRET)).not.toBe(describeObserverRpc(undefined))
  })

  it('treats blank and whitespace as unset, matching BASE_SEPOLIA_RPC', () => {
    // `chain.ts` resolves the endpoint with `?.trim() ||`, so a variable set to
    // spaces falls back to the public node. The announcement has to agree, or
    // it would report `dedicated` for a run observing the public endpoint —
    // worse than no line at all.
    for (const blank of ['', '   ', '\t\n']) {
      expect(describeObserverRpc(blank), JSON.stringify(blank)).toMatch(/^PUBLIC/)
    }
  })

  it('names the consequence, not just the endpoint class', () => {
    // The line exists to stop an availability failure being triaged as a
    // defect, so it has to say that is what it means.
    expect(describeObserverRpc(undefined)).toContain('read as scenario failures')
  })

  /**
   * No scenario puts the resolved endpoint into a string (#2511).
   *
   * `describeObserverRpc`'s guarantee covers the one line it was written for.
   * Three scenarios interpolated `BASE_SEPOLIA_RPC` straight into a `fail()`
   * detail — harmless while that constant was a hardcoded public URL, and a
   * live credential the moment `QA_RPC_URL_BASE_SEPOLIA` could hold a provider
   * key. Wiring the variable is what made those lines dangerous, so the guard
   * ships with the wiring (haven-reviewer, blocking).
   *
   * A `fail()` detail is not a scoped channel. It reaches the job's stdout,
   * and `printRunReport()` puts it in a markdown table the harness's own
   * header tells an operator to paste into `docs/bug-reports/` — i.e. commit
   * to a public repo. GitHub masks registered secrets in Actions logs, which
   * covers the CI path and neither of the other two: a local run prints the
   * raw value, and a pasted report carries it into git.
   *
   * The rule is about the SHAPE — the constant reaching a template literal —
   * not about any one message, because the next one will be written by someone
   * who never read this comment.
   */
  it('no scenario interpolates the resolved endpoint into a message', () => {
    const dir = join(__dirname, '..', 'scenarios')
    const offenders: string[] = []
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      for (const [n, line] of readFileSync(join(dir, file), 'utf8').split('\n').entries()) {
        // The two legitimate uses are handing it to a provider, never printing
        // it: `new JsonRpcProvider(BASE_SEPOLIA_RPC)` and `{ 84532: BASE_SEPOLIA_RPC }`.
        if (!/\$\{[^}]*BASE_SEPOLIA_RPC[^}]*\}/.test(line)) continue
        offenders.push(`${file}:${n + 1}`)
      }
    }
    expect(offenders, `resolved endpoint interpolated into a string: ${offenders.join(', ')}`).toEqual([])
  })

  it('POSITIVE CONTROL: the matcher finds an interpolation when there is one', () => {
    const matches = (line: string) => /\$\{[^}]*BASE_SEPOLIA_RPC[^}]*\}/.test(line)
    expect(matches('return fail(`polling ${BASE_SEPOLIA_RPC} timed out`)')).toBe(true)
    // And does not fire on the two legitimate, non-printing uses.
    expect(matches('const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC)')).toBe(false)
    expect(matches('chainRpcs: { 84532: BASE_SEPOLIA_RPC },')).toBe(false)
  })
})

// ── #3344: the observer reads, against fake receipts ─────────────────────────
const FROM = ethers.getAddress('0x' + 'aa'.repeat(20))
const TO = ethers.getAddress('0x' + 'bb'.repeat(20))
const TRANSFER = ethers.id('Transfer(address,address,uint256)')
const transferLog = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
  data: ethers.toBeHex(value, 32),
})
const receipt = (status: number, logs: unknown[]) => ({ status, logs }) as unknown as ethers.TransactionReceipt
const reader = (r: ethers.TransactionReceipt | null) => ({ getTransactionReceipt: async () => r })
const expected = { from: FROM, to: TO, amount: 10_000n }
const fast = { timeoutMs: 0, intervalMs: 1 }

describe('proveUsdcTransfer (#3344)', () => {
  it('passes only on status 1 AND the exact USDC Transfer (from, to, amount)', async () => {
    const r = await proveUsdcTransfer('0xt', expected, { ...fast, provider: reader(receipt(1, [transferLog(SEPOLIA_USDC, FROM, TO, 10_000n)])) })
    expect(r).toEqual({ ok: true })
  })

  it('FAILS on a missing receipt, naming the observer (an outage is not a Haven defect)', async () => {
    const r = await proveUsdcTransfer('0xt', expected, { ...fast, provider: reader(null) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/no receipt for 0xt on the observer node.*observer: /)
  })

  it('FAILS on status 0', async () => {
    const r = await proveUsdcTransfer('0xt', expected, { ...fast, provider: reader(receipt(0, [transferLog(SEPOLIA_USDC, FROM, TO, 10_000n)])) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/status 0/)
  })

  it('FAILS on status 1 without the Transfer — the 4337 inner-revert shape', async () => {
    const r = await proveUsdcTransfer('0xt', expected, { ...fast, provider: reader(receipt(1, [])) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/carries no USDC Transfer.*4337/)
  })

  it('FAILS when the Transfer is the wrong amount, the wrong payee, the wrong payer or the wrong token', async () => {
    const other = ethers.getAddress('0x' + 'cc'.repeat(20))
    for (const log of [
      transferLog(SEPOLIA_USDC, FROM, TO, 9_999n),
      transferLog(SEPOLIA_USDC, FROM, other, 10_000n),
      transferLog(SEPOLIA_USDC, other, TO, 10_000n),
      transferLog(other, FROM, TO, 10_000n),
    ]) {
      const r = await proveUsdcTransfer('0xt', expected, { ...fast, provider: reader(receipt(1, [log])) })
      expect(r.ok).toBe(false)
    }
  })

  it('usdcTransfers decodes addresses case-insensitively against USDC', () => {
    const [t] = usdcTransfers(receipt(1, [transferLog(SEPOLIA_USDC.toLowerCase(), FROM, TO, 5n)]))
    expect(t).toEqual({ from: FROM, to: TO, value: 5n })
  })

  it('waitForReceipt waits for a lagging observer instead of failing on the first miss', async () => {
    let calls = 0
    const lagging = { getTransactionReceipt: async () => (++calls < 3 ? null : receipt(1, [])) }
    expect(await waitForReceipt(lagging, '0xt', { timeoutMs: 1_000, intervalMs: 1 })).not.toBeNull()
    expect(calls).toBe(3)
  })
})

describe('waitForDisabled (#3344)', () => {
  it('passes once the flag reads true, polling past a lagging false', async () => {
    let calls = 0
    const r = await waitForDisabled('0xd', { timeoutMs: 1_000, intervalMs: 1, read: async () => ++calls >= 2 })
    expect(r).toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('FAILS when the flag stays false past the deadline, naming the observer', async () => {
    const r = await waitForDisabled('0xd', { ...fast, read: async () => false })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/0xd is not disabled on-chain.*returned false.*observer: /)
  })

  it('FAILS on a read that keeps throwing, with the reason', async () => {
    const r = await waitForDisabled('0xd', { ...fast, read: async () => { throw new Error('rpc down') } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/read failed: rpc down/)
  })
})

describe('proveUsdcTransferSince (#3505)', () => {
  const from = '0x' + '11'.repeat(20)
  const to = '0x' + '22'.repeat(20)
  const fast = { fromBlock: 5, timeoutMs: 20, intervalMs: 5 }
  const provider = (logs: Array<{ data: string; transactionHash: string }>) => ({
    getBlockNumber: async () => 5,
    getLogs: async () => logs,
  })

  it('accepts only the exact amount, and filters on payer and payee topics', async () => {
    let filter: { topics: Array<string | null> } | undefined
    const reader = { getBlockNumber: async () => 5, getLogs: async (f: never) => { filter = f; return [{ data: ethers.toBeHex(1000n, 32), transactionHash: '0xt' }] } }
    const ok = await proveUsdcTransferSince({ from, to, amount: 1000n }, { ...fast, provider: reader })
    expect(ok).toEqual({ ok: true, txHash: '0xt' })
    expect(filter?.topics?.[1]).toBe(ethers.zeroPadValue(from, 32))
    expect(filter?.topics?.[2]).toBe(ethers.zeroPadValue(to, 32))
  })

  // Alchemy's free tier refuses eth_getLogs over 10 blocks (eval pilot,
  // 2026-10-19): a session spanning ~70 blocks graded every real transfer as
  // missing. The probe must scan in windows and still find a transfer far
  // from fromBlock.
  it('scans in windows of at most GET_LOGS_MAX_RANGE blocks and finds a transfer 60 blocks later', async () => {
    const ranges: Array<[number, number]> = []
    const reader = {
      getBlockNumber: async () => 75,
      getLogs: async (f: { fromBlock: number; toBlock: number }) => {
        if (f.toBlock - f.fromBlock + 1 > 10) throw new Error('Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range')
        ranges.push([f.fromBlock, f.toBlock])
        return f.fromBlock <= 65 && 65 <= f.toBlock ? [{ data: ethers.toBeHex(1000n, 32), transactionHash: '0xfar' }] : []
      },
    }
    const ok = await proveUsdcTransferSince({ from, to, amount: 1000n }, { ...fast, provider: reader })
    expect(ok).toEqual({ ok: true, txHash: '0xfar' })
    expect(GET_LOGS_MAX_RANGE).toBe(10)
    expect(ranges.every(([a, b]) => b - a + 1 <= GET_LOGS_MAX_RANGE)).toBe(true)
    expect(ranges[0]).toEqual([5, 14])
  })

  it('covers every block with no gap when a window fails, and finds the transfer on the next poll', async () => {
    const scanned = new Set<number>()
    let failedOnce = false
    const reader = {
      getBlockNumber: async () => 40,
      getLogs: async (f: { fromBlock: number; toBlock: number }) => {
        // The second window (15..24) fails once — the transfer sits inside it.
        if (f.fromBlock === 15 && !failedOnce) {
          failedOnce = true
          throw new Error('rate limited')
        }
        for (let b = f.fromBlock; b <= f.toBlock; b++) scanned.add(b)
        return f.fromBlock <= 20 && 20 <= f.toBlock ? [{ data: ethers.toBeHex(1000n, 32), transactionHash: '0xmid' }] : []
      },
    }
    const ok = await proveUsdcTransferSince({ from, to, amount: 1000n }, { fromBlock: 5, timeoutMs: 200, intervalMs: 5, provider: reader })
    expect(ok).toEqual({ ok: true, txHash: '0xmid' })
    expect(failedOnce).toBe(true)
    for (let b = 5; b <= 14; b++) expect(scanned.has(b)).toBe(true)
  })

  it('re-reads the last GET_LOGS_TIP_RESCAN blocks on the next poll, so a log indexed late at the tip is still found', async () => {
    let head = 10
    let polls = 0
    const reader = {
      getBlockNumber: async () => head,
      getLogs: async (f: { fromBlock: number; toBlock: number }) => {
        polls++
        // Block 10 was the tip on poll 1 and its log was not indexed yet;
        // by poll 2 the tip has moved and the log is visible.
        if (f.fromBlock <= 10 && 10 <= f.toBlock && polls > 1) return [{ data: ethers.toBeHex(1000n, 32), transactionHash: '0xlate' }]
        head = 12
        return []
      },
    }
    const ok = await proveUsdcTransferSince({ from, to, amount: 1000n }, { fromBlock: 5, timeoutMs: 200, intervalMs: 5, provider: reader })
    expect(GET_LOGS_TIP_RESCAN).toBeGreaterThan(0)
    expect(ok).toEqual({ ok: true, txHash: '0xlate' })
  })

  it('reports a getBlockNumber failure as such, not as getLogs', async () => {
    const reader = { getBlockNumber: async () => { throw new Error('observer down') }, getLogs: async () => [] }
    const r = await proveUsdcTransferSince({ from, to, amount: 1000n }, { ...fast, provider: reader })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/getBlockNumber failed: observer down/)
  })

  it('fails on a wrong amount or no log', async () => {
    const wrong = await proveUsdcTransferSince({ from, to, amount: 1000n }, {
      ...fast, provider: provider([{ data: ethers.toBeHex(999n, 32), transactionHash: '0xt' }]),
    })
    expect(wrong.ok).toBe(false)
    const none = await proveUsdcTransferSince({ from, to, amount: 1000n }, { ...fast, provider: provider([]) })
    expect(none.ok).toBe(false)
  })
})

// ethers v6 errors can carry the request URL; the observer URL embeds the
// provider API key, and grader details land in the PUBLIC eval report.
describe('redactUrls — RPC errors never carry the observer URL into a report', () => {
  it('strips http(s) and ws(s) URLs, keeping the rest of the message', () => {
    const msg = 'could not coalesce error (info={ "requestUrl": "https://base-sepolia.g.alchemy.com/v2/SECRETKEY123" }, ws=wss://x.example/v2/K)'
    const out = redactUrls(msg)
    expect(out).not.toMatch(/SECRETKEY123|\/v2\/K/)
    expect(out).toContain('could not coalesce error')
    expect(out).toContain('<url redacted>')
  })

  it('applies to a failing getLogs read in proveUsdcTransferSince', async () => {
    const reader = {
      getBlockNumber: async () => 5,
      getLogs: async () => { throw new Error('bad request (requestUrl="https://base-sepolia.g.alchemy.com/v2/SECRETKEY123")') },
    }
    const r = await proveUsdcTransferSince({ from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), amount: 1n }, { fromBlock: 5, timeoutMs: 20, intervalMs: 5, provider: reader })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).not.toContain('SECRETKEY123')
  })
})
