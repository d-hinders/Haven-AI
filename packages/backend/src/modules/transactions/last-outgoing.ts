/**
 * The account card's "Last payment" source (#4021) — the most recent OUTGOING
 * transfer of any kind from one account, as an ISO-8601 instant or null.
 *
 * The owner ruling (2026-10-16) is explicit: ANY outgoing transfer, including
 * owner sends; incoming transfers never count. Two sources feed it, because
 * neither alone sees everything:
 *
 * 1. **The chain-history read** (`fetchAccountTransactions`, the SAME pipeline
 *    `GET /transactions` serves — same legs, same explorer window, same
 *    30 s `txCache`). This is the only place owner sends exist server-side:
 *    the submit route broadcasts the owner's UserOperation and records
 *    nothing, so no DB row can see them. Rows count when they left the
 *    account (`direction: 'out'`), carried value, and did not revert — a
 *    failed send transferred nothing, so it is not a payment.
 * 2. **The newest confirmed payment intent** (`findLastOutgoingIntentAt`) —
 *    the belt-and-braces leg for a confirmed agent payment whose transfer
 *    never surfaced in the explorer rows (the x402-synthesized row case) and
 *    for explorer indexing lag behind the confirm UPDATE.
 *
 * The result is the MAX of the two. The probe is cached — `lastOutgoingCache`
 * at a 5-minute TTL — because the overview card re-fetches its portfolio on
 * the visible-polling tick, and a footer word does not need sub-minute
 * freshness; without this layer every poll would re-walk chain history per
 * card. A read that FAILED (`hadFailures`) with nothing found is NOT cached:
 * a silent outage must not bake "No payments yet" into the footer for five
 * minutes — the next call retries immediately.
 */
import type { FastifyBaseLogger } from 'fastify'
import { fetchAccountTransactions } from './aggregate.js'
import { createCache } from '../../platform/cache.js'
import { findLastOutgoingIntentAt } from '../../infra/repositories/dashboard.js'

const LAST_OUTGOING_TTL_MS = 5 * 60 * 1000

const lastOutgoingCache = createCache<string | null>(LAST_OUTGOING_TTL_MS)
const lastOutgoingInflight = new Map<string, Promise<string | null>>()

function cacheKey(chainId: number, accountAddress: string): string {
  return `last-outgoing:${chainId}:${accountAddress.toLowerCase()}`
}

async function probeLastOutgoingAt(
  accountId: string,
  chainId: number,
  accountAddress: string,
  log: FastifyBaseLogger,
): Promise<{ at: string | null; certain: boolean }> {
  const [chainRead, intentAt] = await Promise.all([
    fetchAccountTransactions({ accountId, accountAddress, chainId, log }),
    // Never let a DB hiccup take the whole field down: a missed intent read
    // degrades to the chain leg alone, the same way the chain leg already
    // degrades per explorer failure.
    findLastOutgoingIntentAt(accountId).catch((err: unknown) => {
      log.warn({ err, accountId }, 'Last-outgoing intent read failed')
      return null
    }),
  ])

  let latest: Date | null = intentAt
  // #3295's marker rule does not apply here: a degraded READ is not a payment.
  // Only successful outgoing value transfers count, so `isError` rows and
  // zero-value calls (contract interactions that moved nothing) are skipped
  // even when the feed itself would show them.
  if (!chainRead.hadFailures) {
    for (const tx of chainRead.transactions) {
      if (tx.direction !== 'out' || tx.isError || tx.value === '0') continue
      const at = new Date(tx.timestamp * 1000)
      if (latest === null || at > latest) latest = at
    }
  }

  // "Certain" = both legs answered. An uncertain result (the chain read
  // failed AND no intent carried the answer) must not be cached — a silent
  // outage must not bake "No payments yet" into the footer for five minutes.
  return { at: latest ? latest.toISOString() : null, certain: !chainRead.hadFailures }
}

/**
 * `accountId` and the address must come from the caller's OWN ownership check
 * — the probe is tenant-scoped by the account id, and the cache is keyed on
 * the (chainId, address) pair only.
 */
export async function fetchLastOutgoingAt(
  accountId: string,
  chainId: number,
  accountAddress: string,
  log: FastifyBaseLogger,
): Promise<string | null> {
  const key = cacheKey(chainId, accountAddress)
  const cached = lastOutgoingCache.get(key)
  if (cached !== undefined) return cached

  const existing = lastOutgoingInflight.get(key)
  if (existing) return existing

  const promise = probeLastOutgoingAt(accountId, chainId, accountAddress, log)
    .then((probed) => {
      // A certain result — including a settled null (the account genuinely
      // never sent anything) — is cached; an uncertain one is returned but
      // not, so the next call retries the failed leg (see the module comment).
      if (probed.certain) lastOutgoingCache.set(key, probed.at)
      return probed.at
    })
    .finally(() => {
      lastOutgoingInflight.delete(key)
    })
  lastOutgoingInflight.set(key, promise)
  return promise
}
