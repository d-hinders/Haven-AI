/**
 * Scrub vendor credentials from error text before it reaches API responses or
 * the database. Viem/bundler errors echo the full request URL — which for
 * hosted bundlers EMBEDS THE API KEY (`?apikey=…`). Found live during the
 * #738 exhaustion test: the sponsorship decline leaked the key into the 502
 * `details`. Every provider-error surface (API responses and stored failure
 * text) must pass through this.
 *
 * Lives in `domain/` (pure, no imports) since #3510 so the repository layer
 * can apply it at the write boundary (`markOutboundTxFailed`); it is
 * re-exported from `rails/execution-rail.ts`, where it was defined before.
 */
export function redactVendorSecrets(message: string): string {
  return (
    message
      // Query-param credentials in any spelling: apikey=, api_key=, api-key=,
      // key=, token= (#1053 review, finding 6 — the old regex caught only
      // `apikey=`).
      .replace(/\b(api[_-]?key|key|token|secret)=[^&\s"'\\)]+/gi, '$1=REDACTED')
      // Basic-auth credentials embedded in a URL: https://user:pass@host
      .replace(/(https?:\/\/)[^\s/@]+:[^\s@]+@/gi, '$1REDACTED@')
      // Pimlico-style key-in-path segments: /rpc/<hex-ish token>
      .replace(/(\/(?:rpc|v2)\/)[A-Za-z0-9_-]{16,}/g, '$1REDACTED')
  )
}
