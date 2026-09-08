import { apiBaseUrl, type ForwardedHeaders } from '../domain/request-origin.js'

/** Public, machine-readable entry point for callers handed only the API URL. */
export function buildApiRootDocument(headers: ForwardedHeaders, frontendUrl: string) {
  const base = apiBaseUrl(headers)
  const dashboard = frontendUrl.replace(/\/+$/, '')
  return {
    name: 'haven-api',
    description:
      'Haven is the buy-side control layer for AI-agent payments: an agent spends within an ' +
      'owner-set, on-chain-enforced budget. Haven never holds funds and the agent never holds a key.',
    openapi: `${base}/openapi.json`,
    docs: `${dashboard}/llms.txt`,
    manifest: `${dashboard}/.well-known/haven.json`,
    auth: {
      agent: 'Bearer sk_agent_… (or X-API-Key). Provision with `npx @haven_ai/connect@alpha`.',
      owner: 'Dashboard session, or `haven login`.',
    },
    health: `${base}/health`,
  }
}
