'use client'

/**
 * The API-key paste modal for an `api_key` provider (#3017, epic #3016).
 *
 * Accounted connects without a redirect: the user creates a key in the
 * provider's dashboard, pastes it here, and Haven validates it by reading
 * the company it belongs to (`POST /accounting/connections/:provider/api-key`,
 * the route added with the api-key flow). The modal carries the three
 * dashboard steps — where the keys page is, which scopes to tick
 * (`companies:read` + `documents:write` + `webhooks:manage`, interpolated from
 * `accounted-copy.ts` so the identifiers are spelled exactly once), and that
 * a key is shown only after creation — plus the dashboard-revoke note: a key
 * is revoked in Accounted's dashboard, so disconnect here clears the stored
 * secret only.
 *
 * ── Lifecycle rules (the `PaymentCredentialsModal` class) ────────────────
 * The input is `type="password"`: masked while typing and NEVER rendered
 * back. It is cleared when the modal closes, and the in-flight flag is reset
 * on reopen, so a submit interrupted by a close can never leave a stale busy
 * state or a lingering secret behind for the next open. The error line is
 * cleared with them.
 *
 * ── Error states ─────────────────────────────────────────────────────────
 * An empty submit is refused locally with the `API_KEY_REQUIRED` sentence —
 * no round-trip for a field the user has not filled. A failed connect is
 * narrowed through `accountingRefusal` and answered from the i18n table keyed
 * by the route's `error_code` (`API_KEY_REQUIRED`, `INVALID_API_KEY`,
 * `MULTI_COMPANY_KEY`, `UNSUPPORTED_BASE_CURRENCY`); anything else (an
 * outage, a gate refusal) shows the generic sentence. A refusal leaves the
 * modal open with the field intact.
 */
import { useEffect, useState } from 'react'
import { useT } from '@/context/LocaleContext'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { accountingRefusal } from '@/hooks/useAccounting'
import {
  ACCOUNTED_API_KEY_ERROR_CODES,
  ACCOUNTED_DASHBOARD_KEYS_URL,
  ACCOUNTED_DASHBOARD_PATH,
  ACCOUNTED_LIVE_KEY_PREFIX,
  ACCOUNTED_REQUIRED_SCOPES,
  ACCOUNTED_SCOPE_SEPARATOR,
  ACCOUNTED_TEST_KEY_PREFIX,
  type AccountedApiKeyErrorCode,
} from './accounted-copy'

/** The panel's test id — a clip of the modal scopes to this, never to `role="dialog"`. */
export const API_KEY_MODAL_TEST_ID = 'api-key-connect-modal'

export interface ApiKeyConnectModalProps {
  open: boolean
  /** The provider's display name, for the title and the intro sentence. */
  providerName: string
  onClose: () => void
  /**
   * `POST …/connections/:provider/api-key` via the caller's hook — rejects
   * with the `ApiRequestError` on a refusal. Resolves only after the
   * connection row has been refetched, so closing on resolve is safe.
   */
  onConnect: (apiKey: string) => Promise<void>
}

export function ApiKeyConnectModal({ open, providerName, onClose, onConnect }: ApiKeyConnectModalProps) {
  const t = useT()
  const copy = t.settings.accounting.apiKey
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Clear on close, not only on unmount: the secret never survives a close,
  // and a busy flag interrupted by a close cannot leak into the next open.
  useEffect(() => {
    if (!open) {
      setApiKey('')
      setError(null)
      setBusy(false)
    }
  }, [open])

  const scopes = ACCOUNTED_REQUIRED_SCOPES.join(ACCOUNTED_SCOPE_SEPARATOR)

  const submit = async () => {
    const trimmed = apiKey.trim()
    if (!trimmed) {
      setError(copy.API_KEY_REQUIRED)
      return
    }
    setError(null)
    setBusy(true)
    try {
      await onConnect(trimmed)
      onClose()
    } catch (err) {
      const refusal = accountingRefusal(err)
      setError(
        refusal.code && (ACCOUNTED_API_KEY_ERROR_CODES as readonly string[]).includes(refusal.code)
          ? copy[refusal.code as AccountedApiKeyErrorCode]
          : copy.genericError,
      )
    } finally {
      setBusy(false)
    }
  }

  const errorId = 'api-key-error'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={copy.title(providerName)}
      subtitle={copy.intro(providerName)}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      panelTestId={API_KEY_MODAL_TEST_ID}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {copy.cancel}
          </Button>
          <Button onClick={() => void submit()} disabled={busy} aria-busy={busy}>
            {busy ? copy.submitting : copy.submit}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/*
          The key field comes FIRST so the modal's initial focus (its
          first-focusable fallback — `ui/Input` takes no ref, and the shared
          primitive is not extended for this) lands in the field the user is
          here to fill. The dashboard steps render beneath as helper copy.
        */}
        <div>
          <label htmlFor="accounted-api-key" className="block text-sm font-medium text-[var(--v2-ink)]">
            {copy.keyLabel}
          </label>
          <div className="mt-1">
            <Input
              id="accounted-api-key"
              name="apiKey"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={copy.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className="w-full"
            />
          </div>
          {error ? (
            <p id={errorId} role="alert" className="mt-2 text-sm text-[var(--v2-danger)]" data-testid="api-key-error">
              {error}
            </p>
          ) : null}
        </div>

        <div>
          <p className="text-sm font-medium text-[var(--v2-ink)]">{copy.stepsTitle}</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-[var(--v2-ink-2)]">
            <li>
              <a
                href={ACCOUNTED_DASHBOARD_KEYS_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                {copy.stepOpen(ACCOUNTED_DASHBOARD_PATH)}
              </a>
            </li>
            <li>{copy.stepScopes(scopes)}</li>
            <li>{copy.stepPaste(ACCOUNTED_TEST_KEY_PREFIX, ACCOUNTED_LIVE_KEY_PREFIX)}</li>
          </ol>
          <p className="mt-2 text-sm text-[var(--v2-ink-3)]">{copy.revokeNote}</p>
        </div>
      </div>
    </Modal>
  )
}

export default ApiKeyConnectModal
