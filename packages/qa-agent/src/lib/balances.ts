/**
 * QA wallet runway (#3631).
 *
 * Money-flow QA failed in preflight for ~3.5 days (2026-10-01T19:24Z →
 * 2026-10-05T06:08Z, about 40 runs) because the delegation treasury ran dry
 * and nothing warned beforehand: the treasury check has only a FAIL floor
 * (one run's cost), and preflight output only reaches a run log. This module
 * is read-only except for Base Sepolia faucet requests for the demo merchant's
 * settlement wallet and the dev relayer —
 * one row per wallet the QA flows depend on, with a runway in days — and
 * `scripts/ci/qa-balance-issue.mjs` turns the rows into one standing issue.
 *
 * Runway comes from OBSERVED burn, not an assumed run rate: the dev relayer is
 * shared with non-QA dev traffic, and retries and run counts vary, so a
 * per-run cost is the wrong denominator. Until {@link MIN_READINGS} daily
 * readings exist, each wallet falls back to a fixed floor and says so.
 *
 * Nothing here signs or moves Haven or customer funds. The caller may request
 * testnet ETH for the demo merchant's settlement wallet and the dev relayer
 * between the first reading and final report.
 */
import { ethers } from 'ethers'
import { ERC20_BALANCE_ABI, SEPOLIA_USDC, USDC_DECIMALS } from './chain.js'
import { TREASURY_RUN_COST_ATOMIC } from './preflight.js'
import type { HavenApi } from './haven-api.js'

export type Band = 'ok' | 'warn' | 'critical' | 'unknown'
export type WalletKey = 'treasury' | 'merchant' | 'relayer'
export type Unit = 'USDC' | 'ETH'

/** The order rows are emitted and rendered in. Every run emits all three. */
export const WALLET_KEYS: readonly WalletKey[] = ['treasury', 'merchant', 'relayer']

/** Runway below this many days is `warn` (owner decision, 2026-10-05). */
export const WARN_DAYS = 7
/** Runway below this many days is `critical`. */
export const CRITICAL_DAYS = 1
/** Fewer daily readings than this → the fixed fallback floor decides. */
export const MIN_READINGS = 7
/** How many daily readings the history keeps. */
export const HISTORY_DAYS = 14

/**
 * The dev relayer's low-balance floor, 0.01 ETH. RESTATED from the backend's
 * `RELAYER_LOW_BALANCE_WEI` (`packages/backend/src/infra/relayer.ts`) on
 * purpose: that file is money-path, and this harness must neither import nor
 * edit it (#3631). Keep the two equal.
 */
export const RELAYER_FALLBACK_FLOOR_WEI = 10_000_000_000_000_000n

/** The automatic faucet target: three times the relayer's 0.01 ETH floor. */
export const RELAYER_TOPUP_TARGET_WEI = 30_000_000_000_000_000n

/**
 * The demo merchant's automatic faucet target, 0.002 ETH (#3836): about 800
 * settlements at a 0.0000025 ETH `cost_per_settlement_wei`, about 5.9 days at
 * the ~0.00034 ETH/day burn #3654 recorded (2026-10-05 → 10-09). The merchant
 * is topped up whenever it is BELOW this, whatever its band: its `critical`
 * floor is its own payment-refusal point, so a band trigger fires too late.
 */
export const MERCHANT_TOPUP_TARGET_WEI = 2_000_000_000_000_000n

/** The treasury's warn floor until enough history exists: 1.0 USDC, ~30 runs. */
export const TREASURY_FALLBACK_FLOOR_ATOMIC = 1_000_000n

/** One wallet's reading, ready for the issue. Amounts are decimal strings in `unit`. */
export interface BalanceRow {
  key: WalletKey
  name: string
  unit: Unit
  /** Full address, when it could be resolved. */
  address?: string
  /** Token contract for an ERC-20 wallet; absent for native ETH. */
  token?: string
  /** Balance in `unit`, e.g. `"0.412"`. Absent when it could not be read. */
  balance?: string
  /** Observed burn per day in `unit`; absent on the fallback basis. */
  burnPerDay?: string
  /** Runway in days, one decimal; absent on the fallback basis or with no burn. */
  runwayDays?: number
  band: Band
  /** `observed` (≥ MIN_READINGS daily readings) or `fallback` (a fixed floor). */
  basis?: 'observed' | 'fallback'
  /** Why the band is what it is — always set for `unknown`. */
  reason?: string
  /** `unknown` because a config value is missing (the run must go red). */
  configMissing?: boolean
}

/** One day's raw balances, atomic units as decimal strings (JSON-safe bigint). */
export interface HistoryEntry {
  date: string // YYYY-MM-DD (UTC)
  balances: Partial<Record<WalletKey, string>>
}

/**
 * Burn per day: the median of the NEGATIVE day-over-day deltas, as a positive
 * amount. Top-ups (positive deltas) and flat days are ignored, so a refill
 * never reads as negative burn. Returns null with no negative delta at all.
 */
export function burnPerDay(readings: readonly bigint[]): bigint | null {
  const drops: bigint[] = []
  for (let i = 1; i < readings.length; i++) {
    const delta = readings[i]! - readings[i - 1]!
    if (delta < 0n) drops.push(-delta)
  }
  if (drops.length === 0) return null
  drops.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const mid = Math.floor(drops.length / 2)
  return drops.length % 2 === 1 ? drops[mid]! : (drops[mid - 1]! + drops[mid]!) / 2n
}

/** Runway in days (one decimal), or null when nothing burns. */
export function runwayDays(balance: bigint, burn: bigint | null): number | null {
  if (burn === null || burn <= 0n) return null
  // One-decimal precision without leaving bigint for the division.
  return Number((balance * 10n) / burn) / 10
}

export interface ClassifyInput {
  balance: bigint
  /** Daily readings, oldest first, INCLUDING today's. */
  readings: readonly bigint[]
  /** One run's cost (or the resource's own fail floor): below it is critical. */
  criticalFloor: bigint
  /** The warn floor used until MIN_READINGS readings exist. */
  fallbackFloor: bigint
}

export interface Classified {
  band: Exclude<Band, 'unknown'>
  basis: 'observed' | 'fallback'
  burn: bigint | null
  runway: number | null
}

/**
 * The band for one readable wallet.
 *
 * - below the critical floor → `critical`, whatever the history says;
 * - with ≥ MIN_READINGS readings: runway < CRITICAL_DAYS → `critical`,
 *   runway < WARN_DAYS → `warn`, otherwise (or no burn at all) `ok`;
 * - with fewer readings: below the fallback floor → `warn`, else `ok`.
 */
export function classify({ balance, readings, criticalFloor, fallbackFloor }: ClassifyInput): Classified {
  if (readings.length >= MIN_READINGS) {
    const burn = burnPerDay(readings)
    const runway = runwayDays(balance, burn)
    let band: Classified['band'] = 'ok'
    if (balance < criticalFloor) band = 'critical'
    else if (runway !== null && runway < CRITICAL_DAYS) band = 'critical'
    else if (runway !== null && runway < WARN_DAYS) band = 'warn'
    return { band, basis: 'observed', burn, runway }
  }
  const band = balance < criticalFloor ? 'critical' : balance < fallbackFloor ? 'warn' : 'ok'
  return { band, basis: 'fallback', burn: null, runway: null }
}

/** Today's history: previous entries (today's replaced), capped at HISTORY_DAYS. */
export function appendHistory(
  history: readonly HistoryEntry[],
  date: string,
  balances: Partial<Record<WalletKey, bigint>>,
): HistoryEntry[] {
  const today: HistoryEntry = {
    date,
    balances: Object.fromEntries(
      Object.entries(balances).map(([k, v]) => [k, (v as bigint).toString()]),
    ) as HistoryEntry['balances'],
  }
  const kept = history.filter((h) => h.date !== date).sort((a, b) => a.date.localeCompare(b.date))
  return [...kept, today].slice(-HISTORY_DAYS)
}

/** One wallet's readings from a history, oldest first (days it was unreadable skipped). */
export function readingsFor(history: readonly HistoryEntry[], key: WalletKey): bigint[] {
  return history
    .map((h) => h.balances[key])
    .filter((v): v is string => typeof v === 'string' && /^\d+$/.test(v))
    .map((v) => BigInt(v))
}

// ── Readers ───────────────────────────────────────────────────────────────

/**
 * A failure's text that is SAFE to publish. ethers v6 error messages embed the
 * full `requestUrl`, and `QA_RPC_URL_BASE_SEPOLIA` is a provider URL with the
 * API key in it; a row's `reason` ends up in a PUBLIC GitHub issue (#3631
 * review H1 — the 2026-09-25 dRPC key leak class). So: the ethers `code` plus
 * its `shortMessage` when there is one, every URL redacted, bounded.
 * `qa-balance-issue.mjs` scrubs again before posting (defence in depth).
 */
export function safeReason(prefix: string, error: unknown): string {
  const e = error as { code?: unknown; shortMessage?: unknown; message?: unknown; name?: unknown }
  const code = typeof e?.code === 'string' ? e.code : null
  const short = typeof e?.shortMessage === 'string' ? e.shortMessage : null
  const raw = short ?? (typeof e?.message === 'string' ? e.message : String(error))
  const text = raw
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)\]}]+/gi, '<url>')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\/[^\s"'`)\]}]*/gi, '<url>')
    .replace(/\(\s*(?:request|info)=.*$/s, '')
    // A key in a non-URL form: `dkey=…`, `apikey: …`, `api key <16+ chars>`.
    .replace(/\b([a-z_-]*key)\s*[=:]\s*[^\s"',;)\]}]+/gi, '$1=<redacted>')
    .replace(/\b(key)\s+[A-Za-z0-9_-]{16,}/gi, '$1 <redacted>')
    .trim()
  const body = code && !text.includes(code) ? `${code}: ${text}` : text
  const bounded = body.length > 160 ? `${body.slice(0, 159)}…` : body
  return `${prefix}: ${bounded}`
}

/** Per-wallet read deadline: a hanging RPC or `/healthz` becomes `unknown`, never a job timeout. */
export const READ_TIMEOUT_MS = 30_000

export async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** What a reader returns: the raw balance, or why there is none. */
export type Reading =
  | {
      ok: true
      address: string
      atomic: bigint
      criticalFloor: bigint
      fallbackFloor: bigint
      /** The chain the wallet is on, when its source reports it (the merchant's `/healthz` `chain_id`). */
      chainId?: number
    }
  | { ok: false; address?: string; reason: string; configMissing?: boolean }

export interface BalanceSources {
  /** `QA_DELEGATION_AGENT_API_KEY` resolved into an API, or null when unset. */
  api: Pick<HavenApi, 'getAgent'> | null
  /** `QA_DEMO_MERCHANT_URL`, or undefined when unset. */
  demoMerchantUrl?: string
  /**
   * `QA_DEV_RELAYER_ADDRESS` — a non-secret repo variable. A DELIBERATE
   * exception to preflight's rule 1 ("derive, never restate"), owner decision
   * on #3631: no CI-readable source exists for the backend's relayer address,
   * and putting an ops token into CI to read it was the rejected alternative.
   */
  relayerAddress?: string
  provider: ethers.Provider
  fetchImpl?: typeof fetch
}

/** The delegation treasury, via `GET /machine-payments/agent` (never restated). */
export async function readTreasury(src: BalanceSources): Promise<Reading> {
  if (!src.api) return { ok: false, reason: 'config missing: QA_DELEGATION_AGENT_API_KEY', configMissing: true }
  try {
    const { ok, status, data } = await src.api.getAgent()
    if (!ok) return { ok: false, reason: `GET /machine-payments/agent returned HTTP ${status}` }
    if (!data.account_address) return { ok: false, reason: 'agent identity carries no account_address' }
    const usdc = new ethers.Contract(SEPOLIA_USDC, [...ERC20_BALANCE_ABI], src.provider)
    const atomic: bigint = await usdc.balanceOf(data.account_address)
    return {
      ok: true,
      address: data.account_address,
      atomic,
      criticalFloor: TREASURY_RUN_COST_ATOMIC,
      fallbackFloor: TREASURY_FALLBACK_FLOOR_ATOMIC,
    }
  } catch (error) {
    return { ok: false, reason: safeReason('read failed', error) }
  }
}

/**
 * The demo merchant's settlement wallet, via its own `/healthz` (the address
 * derives from a key only the merchant holds). The merchant's floors are in
 * SETTLEMENTS; they are converted to wei with the merchant's own
 * `cost_per_settlement_wei`, so every floor here is one unit. A `/healthz`
 * missing any of those fields is `unknown`, not a guess.
 */
export async function readMerchant(src: BalanceSources): Promise<Reading> {
  if (!src.demoMerchantUrl) return { ok: false, reason: 'config missing: QA_DEMO_MERCHANT_URL', configMissing: true }
  const fetchImpl = src.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(`${src.demoMerchantUrl}/healthz`, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) })
    if (!res.ok) return { ok: false, reason: `/healthz returned HTTP ${res.status}` }
    const body = (await res.json()) as {
      chain_id?: unknown
      settlement?: {
        address?: string
        native_balance_wei?: string
        cost_per_settlement_wei?: string
        warn_floor?: number
        fail_floor?: number
        error?: string
      }
    }
    const s = body.settlement
    if (!s) return { ok: false, reason: 'merchant /healthz reports no settlement block' }
    if (s.error) return { ok: false, address: s.address, reason: safeReason('merchant could not read its balance', s.error) }
    const missing = (['address', 'native_balance_wei', 'cost_per_settlement_wei', 'warn_floor', 'fail_floor'] as const).filter(
      (k) => s[k] === undefined || s[k] === null || s[k] === '',
    )
    if (missing.length > 0) {
      return { ok: false, address: s.address, reason: `merchant /healthz lacks ${missing.join(', ')}` }
    }
    const cost = BigInt(s.cost_per_settlement_wei!)
    // `chain_id` only gates the faucet top-up (#3836); a /healthz without it
    // still has a valid balance, so its absence never makes the row unknown.
    const chainId = typeof body.chain_id === 'number' && Number.isInteger(body.chain_id) ? body.chain_id : undefined
    return {
      ok: true,
      address: s.address!,
      atomic: BigInt(s.native_balance_wei!),
      criticalFloor: cost * BigInt(s.fail_floor!),
      fallbackFloor: cost * BigInt(s.warn_floor!),
      ...(chainId !== undefined ? { chainId } : {}),
    }
  } catch (error) {
    return { ok: false, reason: safeReason(`could not reach ${src.demoMerchantUrl}/healthz`, error) }
  }
}

/** The dev backend's relayer on 84532, from the `QA_DEV_RELAYER_ADDRESS` variable. */
export async function readRelayer(src: BalanceSources): Promise<Reading> {
  if (!src.relayerAddress) return { ok: false, reason: 'config missing: QA_DEV_RELAYER_ADDRESS', configMissing: true }
  if (!ethers.isAddress(src.relayerAddress)) {
    return { ok: false, reason: `QA_DEV_RELAYER_ADDRESS is not an address: ${src.relayerAddress}`, configMissing: true }
  }
  try {
    const atomic = await src.provider.getBalance(src.relayerAddress)
    return {
      ok: true,
      address: src.relayerAddress,
      atomic,
      criticalFloor: RELAYER_FALLBACK_FLOOR_WEI,
      fallbackFloor: RELAYER_FALLBACK_FLOOR_WEI,
    }
  } catch (error) {
    return {
      ok: false,
      address: src.relayerAddress,
      reason: safeReason('read failed', error),
    }
  }
}

const META: Record<WalletKey, { name: string; unit: Unit; decimals: number; token?: string }> = {
  treasury: { name: 'Delegation treasury', unit: 'USDC', decimals: USDC_DECIMALS, token: SEPOLIA_USDC },
  merchant: { name: 'Demo-merchant settlement wallet', unit: 'ETH', decimals: 18 },
  relayer: { name: 'Dev backend relayer (84532)', unit: 'ETH', decimals: 18 },
}

/** Format an atomic amount, trimming trailing zeros (`0.412` rather than `0.412000`). */
function fmt(atomic: bigint, decimals: number): string {
  const s = ethers.formatUnits(atomic, decimals)
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s
}

/** Turn one reading plus its history into a row. */
export function toRow(key: WalletKey, reading: Reading, readings: readonly bigint[]): BalanceRow {
  const m = META[key]
  const base = { key, name: m.name, unit: m.unit, ...(m.token ? { token: m.token } : {}) }
  if (!reading.ok) {
    return {
      ...base,
      ...(reading.address ? { address: reading.address } : {}),
      band: 'unknown',
      reason: reading.reason,
      ...(reading.configMissing ? { configMissing: true } : {}),
    }
  }
  const c = classify({
    balance: reading.atomic,
    readings,
    criticalFloor: reading.criticalFloor,
    fallbackFloor: reading.fallbackFloor,
  })
  return {
    ...base,
    address: reading.address,
    balance: fmt(reading.atomic, m.decimals),
    band: c.band,
    basis: c.basis,
    ...(c.burn !== null ? { burnPerDay: fmt(c.burn, m.decimals) } : {}),
    ...(c.runway !== null ? { runwayDays: c.runway } : {}),
    ...(c.basis === 'fallback'
      ? {
          reason: `fewer than ${MIN_READINGS} daily readings — fallback floor ${fmt(reading.fallbackFloor, m.decimals)} ${m.unit}`,
        }
      : c.burn === null
        ? { reason: 'no observed burn in the last readings' }
        : {}),
  }
}

export interface BalancesReport {
  checkedAt: string
  rows: BalanceRow[]
  history: HistoryEntry[]
  /** True when any row is `unknown` for a missing config — the run goes red. */
  configMissing: boolean
  /** The Base Sepolia faucet outcome per wallet, when the CLI evaluated it (#3836). */
  topUps?: Partial<Record<TopUpWallet, TopUpOutcome>>
}

/** The wallets the CLI may request testnet ETH for, in the order it requests it. */
export type TopUpWallet = 'merchant' | 'relayer'
export const TOP_UP_WALLETS: readonly TopUpWallet[] = ['merchant', 'relayer']

/** One wallet's faucet outcome. */
export interface TopUpOutcome {
  status: 'skipped' | 'attempted'
  claimsMade: number
  amountReceivedAtomic: string
  stopReason:
    | 'not-needed'
    | 'missing-credentials'
    | 'unreadable'
    | 'wrong-chain'
    | 'invalid-address'
    | 'target-requests-complete'
    | 'claim-cap-reached'
    | 'rate-limited'
    | 'faucet-error'
    | 'run-budget-exhausted'
  reason?: string
}

export type BalanceReadings = Record<WalletKey, Reading>

/** Read every wallet without writing history, so top-up can precede the final report. */
export async function collectBalanceReadings(
  src: BalanceSources,
  deadlineMs: number = READ_TIMEOUT_MS,
): Promise<BalanceReadings> {
  const readers: Record<WalletKey, (s: BalanceSources) => Promise<Reading>> = {
    treasury: readTreasury,
    merchant: readMerchant,
    relayer: readRelayer,
  }
  const readingsByKey = {} as Record<WalletKey, Reading>
  for (const key of WALLET_KEYS) {
    readingsByKey[key] = await withDeadline(readers[key](src), deadlineMs, () => ({
      ok: false,
      reason: `read timed out after ${Math.round(deadlineMs / 1000)} s`,
    }))
  }

  return readingsByKey
}

/** Fold one final set of readings into today's history and classify it. */
export function buildBalancesReport(
  readingsByKey: BalanceReadings,
  history: readonly HistoryEntry[],
  now: Date = new Date(),
): BalancesReport {
  const today = now.toISOString().slice(0, 10)
  const todays: Partial<Record<WalletKey, bigint>> = {}
  for (const key of WALLET_KEYS) {
    const r = readingsByKey[key]
    if (r.ok) todays[key] = r.atomic
  }
  const nextHistory = appendHistory(history, today, todays)
  const rows = WALLET_KEYS.map((key) => toRow(key, readingsByKey[key], readingsFor(nextHistory, key)))
  return {
    checkedAt: now.toISOString(),
    rows,
    history: nextHistory,
    configMissing: rows.some((r) => r.configMissing === true),
  }
}

/** Read every wallet, fold today into the history, and classify. */
export async function collectBalances(
  src: BalanceSources,
  history: readonly HistoryEntry[],
  now: Date = new Date(),
  deadlineMs: number = READ_TIMEOUT_MS,
): Promise<BalancesReport> {
  return buildBalancesReport(await collectBalanceReadings(src, deadlineMs), history, now)
}
