import { isDemoPageVisible } from '@/lib/demo-gate'
import { DEMO_MD_CONTENT } from '@/lib/demo-md-content'

/**
 * `/demo.md` — the agent-readable companion to `/demo` (#3477).
 *
 * A ROUTE HANDLER, deliberately not a static file under `public/`. Every
 * other agent-readable artifact (`llms.txt`, `402.md`, `for-agents.md`) is a
 * `public/` file served byte-identical on every deployment (#2596) — the
 * investor demo cannot be, because it must 404 on production
 * (`isDemoPageVisible`, same gate the page uses) while serving normally on
 * dev. A static file has no gate to apply.
 *
 * It is also deliberately NOT in `discovery-artifacts.test.ts`'s `ARTIFACTS`
 * list: that guard's no-bare-chain-assertion rule would fail a document that
 * must name Base Sepolia by name, and its host allowlist only covers
 * `public/`. This route gets its own tests instead (route handler test, link
 * test, not-listed test).
 *
 * `X-Robots-Tag: noindex` stands in for the `<meta name="robots">` a served
 * Markdown file cannot carry — the same reasoning `next.config.ts` would use
 * for a static file, applied here because this is a handler instead.
 */
export const dynamic = 'force-dynamic'

export function GET(): Response {
  if (!isDemoPageVisible()) {
    // A plain 404 `Response`, not `next/navigation`'s `notFound()`: that
    // helper renders the app's not-found UI through the React tree, which a
    // Route Handler (no page/layout of its own) has no tree to render into.
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  return new Response(DEMO_MD_CONTENT, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'x-robots-tag': 'noindex',
      'cache-control': 'public, max-age=0, must-revalidate',
    },
  })
}
