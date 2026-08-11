/**
 * #1271 / #1301: bounded same-origin merchant MCP endpoint discovery.
 *
 * An agent handed a BASE merchant URL previously had to hand-probe /, /mcp,
 * /sse, … until something answered 402. The demo merchant (and the #1266
 * contract) serves a machine-readable discovery document at
 * `/.well-known/haven-demo-merchant` (also at `/`) naming `mcp_url`. This
 * helper fetches ONLY those two fixed same-origin paths — no redirects
 * (`redirect: 'error'`), a 5 s timeout, a 64 KB read cap — and accepts the
 * document's `mcp_url` ONLY when it stays on the same origin as the input.
 * Anything else returns null and the caller reports the original probe
 * failure. Discovery finds endpoints; it carries no payment authority and an
 * off-origin `mcp_url` is never even fetched — this must not grow into a
 * general network scanner (SSRF bound, per the issue).
 *
 * Originally hosted-only (mcp-server, #1271). Moved here in #1301 so the
 * local/self-signed MCP package (`@haven_ai/mcp`) can share the EXACT same
 * bounded implementation instead of re-deriving discovery semantics —
 * behavior is byte-identical to the pre-move mcp-server copy; the #1271
 * contract tests in packages/mcp-server/src/tools.test.ts pass unmodified
 * against this moved implementation.
 */
export const MERCHANT_DISCOVERY_PATHS = ['/.well-known/haven-demo-merchant', '/'] as const
export const DISCOVERY_MAX_BYTES = 64 * 1024

export async function discoverMerchantMcpUrl(inputUrl: string): Promise<string | null> {
  let input: URL
  try {
    input = new URL(inputUrl)
  } catch {
    return null
  }
  for (const path of MERCHANT_DISCOVERY_PATHS) {
    try {
      const res = await globalThis.fetch(`${input.origin}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) continue
      const contentLength = Number(res.headers.get('content-length') ?? 0)
      if (contentLength > DISCOVERY_MAX_BYTES) continue
      const text = await res.text()
      if (text.length > DISCOVERY_MAX_BYTES) continue
      const doc = JSON.parse(text) as { mcp_url?: unknown }
      if (typeof doc.mcp_url !== 'string') continue
      const resolved = new URL(doc.mcp_url)
      if (resolved.origin !== input.origin) continue
      return resolved.toString()
    } catch {
      continue
    }
  }
  return null
}

/** Trailing-slash/percent-case echoes compare equal; unparseable never does. */
export function sameUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    return ua.origin === ub.origin && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
}
