/**
 * Fortnox sandbox validation (#496) — answers the #494 open questions LIVE.
 *
 * Runs the PRODUCTION connector code (FortnoxConnector.pushWithToken) against
 * a real Fortnox test environment, then inspects what was created:
 *
 *   Q1  Does an API-created supplier invoice stay unattested/unbooked?
 *   Q2  Already-paid semantics: what state does the invoice land in?
 *   Q3  Is ExternalInvoiceNumber a usable idempotency ref (readable back)?
 *   Q4  Are the widened scopes (supplierinvoice, supplier, archive) granted?
 *
 * Usage (tokens live in ~/.haven/fortnox-sandbox.json — never in the repo):
 *   npm run pilot:fortnox -- --authorize          # print the consent URL
 *   npm run pilot:fortnox -- --code <code>        # exchange + save tokens
 *   npm run pilot:fortnox                          # run the validation matrix
 *
 * Credentials come from the shell env (source ~/.haven/pilot.env):
 * FORTNOX_CLIENT_ID / FORTNOX_CLIENT_SECRET / FORTNOX_REDIRECT_URI.
 * Test environment only — never point this at a real Fortnox company.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:http'
import path from 'node:path'
import {
  buildFortnoxAuthorizeUrl,
  exchangeCodeForTokens,
  refreshTokens,
  FORTNOX_API_BASE,
} from '../src/lib/fortnox.js'
import { FortnoxConnector, externalInvoiceNumber } from '../src/lib/reporting/fortnox-connector.js'
import type { ReportingTransaction } from '../src/lib/reporting/reporting-transaction.js'

const TOKEN_PATH = path.join(homedir(), '.haven', 'fortnox-sandbox.json')

function creds() {
  const clientId = process.env.FORTNOX_CLIENT_ID
  const clientSecret = process.env.FORTNOX_CLIENT_SECRET
  const redirectUri = process.env.FORTNOX_REDIRECT_URI
  if (!clientId || !clientSecret || !redirectUri) {
    console.error('Missing FORTNOX_* env — source ~/.haven/pilot.env first.')
    process.exit(1)
  }
  return { clientId, clientSecret, redirectUri }
}

async function getToken(): Promise<string> {
  if (!existsSync(TOKEN_PATH)) {
    console.error(`No tokens at ${TOKEN_PATH} — run --authorize then --code first.`)
    process.exit(1)
  }
  const saved = JSON.parse(readFileSync(TOKEN_PATH, 'utf8'))
  if (Date.parse(saved.expiresAt) > Date.now() + 60_000) return saved.accessToken
  const refreshed = await refreshTokens(creds(), saved.refreshToken)
  writeFileSync(TOKEN_PATH, JSON.stringify(refreshed, null, 2))
  return refreshed.accessToken
}

async function main() {
  const [flag, value] = process.argv.slice(2)

  if (flag === '--serve') {
    // Zero-copy-paste flow: a throwaway local callback catches the code and
    // exchanges it automatically. Requires the localhost redirect URI to be
    // registered on the integration (comma-separated with the Railway one):
    //   http://localhost:3111/fortnox-pilot-callback
    const localCreds = { ...creds(), redirectUri: 'http://localhost:3111/fortnox-pilot-callback' }
    const url = buildFortnoxAuthorizeUrl(localCreds, `pilot-${Math.random().toString(36).slice(2, 10)}`)
    const server = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost:3111')
      if (u.pathname !== '/fortnox-pilot-callback') { res.writeHead(404).end(); return }
      const code = u.searchParams.get('code')
      if (!code) { res.writeHead(400).end('missing code'); return }
      try {
        const tokens = await exchangeCodeForTokens(localCreds, code)
        mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
        writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('Fortnox sandbox connected — you can close this tab and return to the terminal.')
        console.log(`\nTokens saved to ${TOKEN_PATH} (scope granted: ${tokens.scope ?? 'unknown'})`)
        console.log('Now run:  npm run pilot:fortnox')
      } catch (err) {
        res.writeHead(500).end('token exchange failed — see terminal')
        console.error('exchange failed:', err instanceof Error ? err.message : err)
      } finally {
        setTimeout(() => server.close(), 200)
      }
    })
    server.listen(3111, () => {
      console.log('Listening on http://localhost:3111 — open this URL and approve for the TEST company:\n')
      console.log(url)
    })
    return
  }

  if (flag === '--authorize') {
    console.log('Open this URL, approve for the TEST environment company, then paste')
    console.log('the ?code= value from the redirected URL into:  npm run pilot:fortnox -- --code <code>\n')
    console.log(buildFortnoxAuthorizeUrl(creds(), `pilot-${Math.random().toString(36).slice(2, 10)}`))
    return
  }

  if (flag === '--code') {
    if (!value) { console.error('usage: --code <authorization code>'); process.exit(1) }
    const tokens = await exchangeCodeForTokens(creds(), value)
    mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
    writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
    console.log(`Tokens saved to ${TOKEN_PATH} (scope granted: ${tokens.scope ?? 'unknown'})`)
    return
  }

  // ── The validation matrix ──────────────────────────────────────────────────
  const accessToken = await getToken()
  const connector = new FortnoxConnector()
  const paymentId = `sandbox-${Date.now()}`
  const tx: ReportingTransaction = {
    paymentId,
    settledAt: new Date().toISOString(),
    direction: 'out',
    counterparty: { address: '0x' + 'ab'.repeat(20), name: 'Haven Sandbox Merchant' },
    resourceUrl: 'https://api.example.dev/reports',
    token: 'USDC',
    amountAtomic: '1042000',
    amountSek: '10.42',
    fxRate: '10.00',
    fxSource: 'riksbank',
    fxAt: new Date().toISOString(),
    receiptRef: 'sandbox-receipt',
    suggestedAccount: '6540',
  }

  console.log('── Push via the PRODUCTION connector path ──')
  const result = await connector.pushWithToken(accessToken, tx)
  console.log('push result:', result)
  if (result.status !== 'pushed' || !result.externalRef) process.exit(1)
  const givenNumber = result.externalRef.split(':').pop()

  console.log('\n── Q1/Q2: read the invoice back — attested? booked? paid state? ──')
  const res = await fetch(`${FORTNOX_API_BASE}/supplierinvoices/${givenNumber}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  const body = (await res.json()) as { SupplierInvoice?: Record<string, unknown> }
  const inv = body.SupplierInvoice ?? {}
  const picked = Object.fromEntries(
    ['GivenNumber', 'Booked', 'AuthorizedPayAmount', 'Balance', 'Total', 'Currency',
     'ExternalInvoiceNumber', 'Comments', 'YourReference', 'Cancelled', 'Credit',
     'PaymentPending', 'VoucherNumber', 'VoucherSeries', 'AccountingMethod',
    ].map((k) => [k, inv[k]]),
  )
  console.log(JSON.stringify(picked, null, 2))
  console.log(`\nQ1 verdict: Booked=${inv.Booked} (must be false → unattested, non-asserting holds)`)
  console.log(`Q2 verdict: Balance=${inv.Balance} — an open AP balance means the accountant reconciles the payment leg (expected)`)

  console.log('\n── Q3: idempotency ref readable back? ──')
  console.log(`ExternalInvoiceNumber=${inv.ExternalInvoiceNumber} (expected ${externalInvoiceNumber(paymentId)})`)

  console.log('\n── Q4: rerun the SAME payment — supplier must be found, not duplicated ──')
  const rerun = await connector.pushWithToken(accessToken, tx)
  console.log('rerun result:', rerun, '(a second invoice is EXPECTED here — the dedup ledger,')
  console.log(' not the connector, is the idempotency guarantee; this proves supplier find-or-create)')

  console.log('\nDone. Record the verdicts on #496 and in docs/research/fortnox-non-asserting-feed.md.')
}

main().catch((err) => {
  console.error('fortnox-sandbox-validation failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
