/**
 * Agent Discovery (AEO) instrumentation helpers (#2302).
 *
 * Two small, pure functions so both are unit-testable without Next machinery:
 *
 * - `parseDiscoverySource` — the connect-funnel attribution slug. MIRRORS
 *   `normalizeDiscoverySource` in the backend's agent-connection-setups route;
 *   keep the two rules identical. Sanitizing (never throwing) is deliberate:
 *   attribution is telemetry and must never block a connect.
 *
 * - `classifyAgentUserAgent` — maps a User-Agent header to a coarse agent
 *   family for the discovery-surface fetch log. Families, not raw UAs, so the
 *   log stays aggregatable and free of high-cardinality junk. The list is the
 *   crawlers/assistants we actually expect to fetch /llms.txt and /402; it is
 *   a trend instrument, not a bot-detection system — unknown agents simply
 *   don't log, which under-counts and never over-counts.
 */

const SOURCE_SLUG = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function parseDiscoverySource(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const slug = value.trim().toLowerCase()
  return SOURCE_SLUG.test(slug) ? slug : null
}

/** Read the `src` attribution param from a location search string. */
export function discoverySourceFromSearch(search: string): string | null {
  try {
    return parseDiscoverySource(new URLSearchParams(search).get('src'))
  } catch {
    return null
  }
}

/**
 * Ordered (family, needle) pairs — first match wins. Needles are matched
 * case-insensitively against the raw UA string. More specific needles come
 * before generic vendor names (e.g. `oai-searchbot` before `chatgpt`).
 */
const AGENT_UA_FAMILIES: ReadonlyArray<readonly [family: string, needle: string]> = [
  ['openai', 'oai-searchbot'],
  ['openai', 'chatgpt-user'],
  ['openai', 'chatgpt'],
  ['openai', 'gptbot'],
  ['anthropic', 'claudebot'],
  ['anthropic', 'claude-web'],
  ['anthropic', 'claude-user'],
  ['anthropic', 'anthropic-ai'],
  ['perplexity', 'perplexitybot'],
  ['perplexity', 'perplexity-user'],
  ['google-ai', 'google-extended'],
  ['google-ai', 'googleother'],
  ['google-ai', 'gemini'],
  ['meta-ai', 'meta-externalagent'],
  ['meta-ai', 'facebookbot'],
  ['amazon', 'amazonbot'],
  ['bytedance', 'bytespider'],
  ['commoncrawl', 'ccbot'],
  ['cohere', 'cohere-ai'],
  ['duckduckgo', 'duckassistbot'],
  ['mistral', 'mistralai'],
  ['grok', 'grokbot'],
  ['grok', 'xai-crawler'],
] as const

export function classifyAgentUserAgent(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null
  const ua = userAgent.toLowerCase()
  for (const [family, needle] of AGENT_UA_FAMILIES) {
    if (ua.includes(needle)) return family
  }
  return null
}

/**
 * First-touch persistence (#2302, reviewer finding). Attribution links land on
 * UNAUTHENTICATED pages (the /402 page, a registry listing, the login screen),
 * but the setup is created later, inside the authenticated dashboard — the
 * `?src=` query string does not survive that hop. So the slug is captured to
 * localStorage at first touch and read back at create time; the URL param, when
 * present at create, still wins (most recent intent beats first touch).
 *
 * localStorage can throw (private mode, blocked site data) — every access is
 * guarded, and failure means "no attribution", never a broken page.
 */
const STORAGE_KEY = 'haven.discovery_source'
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export function captureDiscoverySource(search: string, now: number = Date.now()): void {
  const slug = discoverySourceFromSearch(search)
  if (!slug) return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ source: slug, at: now }))
  } catch {
    // Storage unavailable — first-touch attribution silently degrades.
  }
}

export function readStoredDiscoverySource(now: number = Date.now()): string | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { source?: unknown; at?: unknown }
    if (typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS) return null
    return parseDiscoverySource(typeof parsed.source === 'string' ? parsed.source : null)
  } catch {
    return null
  }
}

/** Create-time resolution: explicit URL param wins, else stored first touch. */
export function resolveDiscoverySource(search: string): string | null {
  return discoverySourceFromSearch(search) ?? readStoredDiscoverySource()
}
