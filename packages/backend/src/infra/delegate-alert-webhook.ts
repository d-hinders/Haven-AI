/**
 * Shared ops-alert webhook sender for `DELEGATE_ALERT_WEBHOOK_URL`.
 *
 * One sender for all three ops alerts (relayer low balance, delegate
 * lingering/dust, catalog ingestion stuck/mass-failure). It POSTs the plain
 * `{ text }` Slack-compatible payload and — the reason this module exists
 * (#3345) — it CHECKS THE RESPONSE: `fetch` resolves on 4xx/5xx, so a
 * rejected webhook used to look like a delivered alert. The sender treats a
 * non-ok status and a network error alike: it logs the failure (with the
 * status, never the URL — a Slack hook URL carries a secret token) and
 * returns `false`, so the caller can keep the alert's edge un-committed and
 * retry on the next scan while the condition persists.
 *
 * Money-path note: named `delegate-alert-webhook.ts` so it sits inside the
 * `infra/delegate-*.ts` money-path and CASP globs like the monitors it
 * serves. Alerting only — never moves funds, never blocks a scan.
 */

export interface AlertWebhookLogger {
  warn(obj: Record<string, unknown>, msg: string): void
}

/** Failure bodies can be chatty; a truncated head is enough to debug. */
const MAX_LOGGED_BODY_CHARS = 200

/** Never log the webhook URL — it is a credential (Slack hook secret). */
function scrubUrl(text: string, url: string): string {
  return url ? text.split(url).join('[redacted]') : text
}

/**
 * POST `{ text }` and report whether the webhook ACCEPTED it. Resolves
 * `false` on a 4xx/5xx or a network error — it never throws, so a failed
 * alert can never break the caller's scan or tick.
 */
export async function sendDelegateAlertWebhook(
  url: string,
  text: string,
  log: AlertWebhookLogger,
  scope: string,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (res.ok) return true

    // fetch resolves on 4xx/5xx — a rejected webhook is a failed delivery.
    let body = ''
    try {
      body = scrubUrl(await res.text(), url)
    } catch {
      // A body that cannot be read does not change the verdict.
    }
    if (body.length > MAX_LOGGED_BODY_CHARS) body = body.slice(0, MAX_LOGGED_BODY_CHARS)
    log.warn(
      { scope, status: res.status },
      `ops alert webhook failed (status ${res.status})${body ? ` — body: ${body}` : ''}`,
    )
    return false
  } catch (err) {
    const message = scrubUrl(err instanceof Error ? err.message : String(err), url)
    log.warn({ scope, err: message }, 'ops alert webhook failed (network error)')
    return false
  }
}

export type EnvAlertDelivery = 'delivered' | 'failed' | 'no-webhook'

/**
 * Env-driven variant for callers that only have the alert text (the catalog
 * ingest loop): reads `DELEGATE_ALERT_WEBHOOK_URL` itself. Unset means
 * nothing to deliver — the caller's log warning is the whole alert — so the
 * outcome is `'no-webhook'` rather than a failure.
 */
export async function sendDelegateAlertFromEnv(
  text: string,
  log: AlertWebhookLogger,
  scope: string,
): Promise<EnvAlertDelivery> {
  const url = process.env.DELEGATE_ALERT_WEBHOOK_URL
  if (!url) return 'no-webhook'
  return (await sendDelegateAlertWebhook(url, text, log, scope)) ? 'delivered' : 'failed'
}
