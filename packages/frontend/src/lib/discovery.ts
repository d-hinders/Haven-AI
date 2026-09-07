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

/**
 * Hand-off links (#2522, B2 of the agent-first epic).
 *
 * An agent driving onboarding pastes a link and the human lands on the exact
 * step. Two params carry that: `next` (where to land after auth) and `via`
 * (that an agent, not a person, produced the link).
 */

/**
 * The origin `next` is resolved against. Never used as a real destination —
 * only to ask the URL parser "does this value leave the origin?". `.invalid`
 * is reserved by RFC 2606 and can never resolve, so a bug that let it escape
 * as a real URL fails loudly instead of reaching someone's host.
 */
const NEXT_PROBE_ORIGIN = 'https://haven.invalid'

/** Longest `next` accepted. Long enough for a setup deep link, short enough
 * that nothing interesting hides in the tail. */
const MAX_NEXT_LENGTH = 512

/**
 * Same-origin path or null. This is an open-redirect boundary: `next` comes
 * from a URL a stranger may have written, and the value is handed to
 * `router.replace`.
 *
 * An origin check ALONE is not enough, and the two cases that prove it were
 * measured rather than reasoned about (they are in the unit test verbatim):
 *
 *   `/..//evil.com`  → resolves to the SAME origin, but its pathname is
 *                      `//evil.com`. Returning that and pushing it makes the
 *                      browser read a protocol-relative URL and leave the
 *                      site — the origin check passed and the redirect is
 *                      still open. Hence the second leading-slash test on the
 *                      RESULT, not just the input.
 *   `/foo\tbar`      → the tab is silently stripped during parsing, so a raw
 *                      string that looks safe is not the string that gets
 *                      resolved. Control characters are refused up front
 *                      rather than stripped-and-hoped.
 */
export function sanitizeNextPath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  // Refuse, do not strip: a stripper has to be right about every character a
  // parser removes, and being wrong once reopens the redirect.
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  const raw = value.trim()
  if (raw.length === 0 || raw.length > MAX_NEXT_LENGTH) return null
  if (!raw.startsWith('/')) return null
  let url: URL
  try {
    url = new URL(raw, NEXT_PROBE_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== NEXT_PROBE_ORIGIN) return null
  const path = `${url.pathname}${url.search}${url.hash}`
  // The `/..//evil.com` case: same origin, protocol-relative result.
  if (path.startsWith('//') || path.startsWith('/\\')) return null
  return path
}

/** Read and sanitise `next` from a location search string. */
export function nextPathFromSearch(search: string): string | null {
  try {
    return sanitizeNextPath(new URLSearchParams(search).get('next'))
  } catch {
    return null
  }
}

/**
 * The attribution marker. An ENUM, not the free slug `src` uses: `via` answers
 * one question — did an agent produce this link — and D1 (#2529) segments the
 * funnel on it. A free-text field would make that segment a string-matching
 * exercise and let a link author write anything into our metrics.
 *
 * Mirrors `normalizeViaMarker` in the backend's agent-connection-setups route;
 * keep the two rules identical.
 */
export const VIA_AGENT = 'agent'

export function parseViaMarker(value: string | null | undefined): typeof VIA_AGENT | null {
  if (typeof value !== 'string') return null
  return value.trim().toLowerCase() === VIA_AGENT ? VIA_AGENT : null
}

/**
 * The `setup` deep-link parameter (#2522) — `/agents?setup=<setupId>`.
 *
 * Sanitised to the shape a setup id actually has (a UUID) rather than passed
 * through: the value is interpolated into a request path, and "the server will
 * 404 it" is not a reason to send it arbitrary input. An unusable value reads
 * as absent, so the page renders normally instead of erroring.
 */
const SETUP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSetupId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return SETUP_ID_RE.test(trimmed) ? trimmed : null
}

/** Read the `setup` deep-link id from a location search string. */
export function setupIdFromSearch(search: string): string | null {
  try {
    return parseSetupId(new URLSearchParams(search).get('setup'))
  } catch {
    return null
  }
}

/**
 * Where to send someone the moment they authenticate.
 *
 * The hand-off contract is that `next` SURVIVES onboarding: an agent pastes
 * `/signup?next=/agents%3Fsetup%3D…`, the human signs up, creates an account,
 * and lands on the approval — not on the dashboard with the link forgotten.
 *
 * The target rides in the URL rather than in localStorage, unlike `?src=`.
 * The two are not the same problem: `src` is first-touch attribution that must
 * survive an arbitrary later session, while `next` is a destination scoped to
 * one flow that is happening right now. Storing it would make it outlive the
 * flow and land some unrelated later login on a stale page.
 */
export function postAuthDestination(hasAccount: boolean, next: string | null): string {
  if (hasAccount) return next ?? '/dashboard'
  return next ? `/onboarding?next=${encodeURIComponent(next)}` : '/onboarding'
}

/** Read the `via` marker from a location search string. */
export function viaMarkerFromSearch(search: string): typeof VIA_AGENT | null {
  try {
    return parseViaMarker(new URLSearchParams(search).get('via'))
  } catch {
    return null
  }
}

/** Create-time resolution: explicit URL param wins, else stored first touch. */
export function resolveDiscoverySource(search: string): string | null {
  return discoverySourceFromSearch(search) ?? readStoredDiscoverySource()
}
