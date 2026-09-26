import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sendDelegateAlertWebhook, sendDelegateAlertFromEnv } = await import(
  '../delegate-alert-webhook.js'
)

// A fake hook URL shape — never a real one. The suite asserts this string
// never leaks into any log record.
const WEBHOOK_URL = 'https://hooks.slack.test/services/T000/B000/secrettoken'

function httpRes(ok: boolean, status: number, body = ''): Response {
  return { ok, status, text: async () => body } as unknown as Response
}

describe('sendDelegateAlertWebhook — the shared ops sender (#3345)', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let warn: ReturnType<typeof vi.fn>
  const log = () => ({ warn })

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    warn = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs the plain { text } payload with a JSON content type', async () => {
    fetchMock.mockResolvedValue(httpRes(true, 200))
    await sendDelegateAlertWebhook(WEBHOOK_URL, 'hello ops', log(), 'test-scope')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(WEBHOOK_URL)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello ops' })
  })

  it('a 2xx resolves true and logs nothing', async () => {
    fetchMock.mockResolvedValue(httpRes(true, 200))
    await expect(sendDelegateAlertWebhook(WEBHOOK_URL, 't', log(), 's')).resolves.toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a 404 resolves false — fetch resolves on 4xx/5xx, so res.ok is the verdict', async () => {
    fetchMock.mockResolvedValue(httpRes(false, 404, 'not found'))
    await expect(sendDelegateAlertWebhook(WEBHOOK_URL, 't', log(), 's')).resolves.toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    const [obj, msg] = warn.mock.calls[0]
    expect(obj).toMatchObject({ scope: 's', status: 404 })
    expect(msg).toContain('ops alert webhook failed')
    expect(msg).toContain('404')
    expect(msg).toContain('not found')
  })

  it('a 500 with a chatty body logs the status and a truncated body', async () => {
    fetchMock.mockResolvedValue(httpRes(false, 500, 'x'.repeat(500)))
    await expect(sendDelegateAlertWebhook(WEBHOOK_URL, 't', log(), 's')).resolves.toBe(false)

    const [, msg] = warn.mock.calls[0]
    expect(msg).toContain('500')
    expect(msg.length).toBeLessThan(400) // 200-char body cap + the status prefix
  })

  it('a network error resolves false and logs the error message — never throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(sendDelegateAlertWebhook(WEBHOOK_URL, 't', log(), 's')).resolves.toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    const [obj, msg] = warn.mock.calls[0]
    expect(obj).toMatchObject({ scope: 's', err: 'ECONNREFUSED' })
    expect(msg).toContain('network error')
  })

  it('never logs the webhook URL — it is a credential', async () => {
    // A 4xx body that echoes the URL (some gateways do)…
    fetchMock.mockResolvedValue(httpRes(false, 403, `invalid token for ${WEBHOOK_URL}`))
    await sendDelegateAlertWebhook(WEBHOOK_URL, 't', log(), 's')
    // …and a rejection whose message carries it.
    fetchMock.mockReset()
    fetchMock.mockRejectedValue(new Error(`fetch failed for ${WEBHOOK_URL}`))
    await sendDelegateAlertWebhook(WEBHOOK_URL, 't', log(), 's')

    const logged = warn.mock.calls.map((c) => JSON.stringify(c)).join('\n')
    expect(logged).not.toContain(WEBHOOK_URL)
    expect(logged).toContain('[redacted]')
  })

  it('a body read failure still logs the status (no throw)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => {
        throw new Error('body stream gone')
      },
    } as unknown as Response)
    await expect(sendDelegateAlertWebhook(WEBHOOK_URL, 't', log(), 's')).resolves.toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 's', status: 502 }),
      expect.stringContaining('502'),
    )
  })
})

describe('sendDelegateAlertFromEnv — the env-driven variant (catalog ingest loop)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DELEGATE_ALERT_WEBHOOK_URL
  })

  it("'no-webhook' with the URL unset — nothing is sent, nothing failed", async () => {
    delete process.env.DELEGATE_ALERT_WEBHOOK_URL
    await expect(sendDelegateAlertFromEnv('t', { warn: vi.fn() }, 's')).resolves.toBe('no-webhook')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("'delivered' on a 2xx", async () => {
    process.env.DELEGATE_ALERT_WEBHOOK_URL = WEBHOOK_URL
    fetchMock.mockResolvedValue(httpRes(true, 200))
    await expect(sendDelegateAlertFromEnv('t', { warn: vi.fn() }, 's')).resolves.toBe('delivered')
  })

  it("'failed' on a 4xx — the caller re-arms on this verdict", async () => {
    process.env.DELEGATE_ALERT_WEBHOOK_URL = WEBHOOK_URL
    fetchMock.mockResolvedValue(httpRes(false, 404, 'nope'))
    await expect(sendDelegateAlertFromEnv('t', { warn: vi.fn() }, 's')).resolves.toBe('failed')
  })
})
