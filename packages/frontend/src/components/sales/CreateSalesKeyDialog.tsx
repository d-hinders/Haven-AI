'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { DialogActions } from '@/components/ui/DialogActions'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { Modal } from '@/components/ui/Modal'
import { ShowOnceCredentialBlock } from '@/components/ui/ShowOnceCredentialBlock'
import { CloseGuardPanel } from '@/components/connect-agent/CloseGuardPanel'
import { ApiRequestError } from '@/lib/api'
import { salesKeyLabel, type CreatedSalesKey } from '@/hooks/useMerchantKeys'
import { SALES_KEY_CANT_SENTENCE } from '@/lib/sales'

function refusal(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 409) {
    return 'There is no Sales account to put a key on yet. Turn on Sales in Settings, then create the key.'
  }
  return 'Haven could not create the key. Nothing was created. Try again.'
}

/**
 * Create a Sales key (#4905, approved on #4894): two screens in one `Modal`.
 *
 * 1. Ask: what a key is, and a primary **Create Sales key** that POSTs.
 * 2. The key, shown once in the show-once credential block with Copy. Closing
 *    before the copy lands asks first through the connect flow's
 *    `CloseGuardPanel`, an inline panel and not a nested dialog.
 *
 * The secret lives in this component's state and nowhere else: not storage,
 * not the URL, not a log line, not the key list. The parent mounts the dialog
 * only while it is open, so closing unmounts it and the secret is gone; the
 * list the parent re-reads carries the prefix.
 */
export function CreateSalesKeyDialog({
  create,
  onClose,
}: {
  create: () => Promise<CreatedSalesKey>
  onClose: () => void
}) {
  const [created, setCreated] = useState<CreatedSalesKey | null>(null)
  const [copied, setCopied] = useState(false)
  const [guarding, setGuarding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      setCreated(await create())
    } catch (caught) {
      setError(refusal(caught))
    } finally {
      setBusy(false)
    }
  }

  const requestClose = () => {
    if (busy) return
    if (created !== null && !copied) {
      setGuarding(true)
      return
    }
    onClose()
  }

  if (created === null) {
    return (
      <Modal
        open
        onClose={requestClose}
        title="Create Sales key"
        closeButtonDisabled={busy}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
        footer={
          <DialogActions>
            <Button variant="tertiary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy}>
              {busy ? 'Creating…' : 'Create Sales key'}
            </Button>
          </DialogActions>
        }
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Your kit uses a Sales key to report what each payment was for. Haven shows the key once, right after you
            create it.
          </p>
          <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">{SALES_KEY_CANT_SENTENCE}</p>
          {error ? <InlineAlert>{error}</InlineAlert> : null}
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title="Your new Sales key"
      footer={
        guarding ? undefined : (
          <Button className="w-full" onClick={requestClose}>
            Done
          </Button>
        )
      }
    >
      {guarding ? (
        <CloseGuardPanel
          testId="sales-key-close-guard"
          title="Close without copying the key?"
          body="This Sales key is shown once. If you close now, you’ll need to create a new one."
          onCancel={() => setGuarding(false)}
          onConfirm={onClose}
        />
      ) : (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Put it in your kit’s settings. Haven shows it once: after you close this, you’ll see only{' '}
            <span className="font-mono text-xs">{salesKeyLabel(created.key_prefix)}</span>
          </p>
          <div>
            <h3 className="text-sm font-medium text-[var(--v2-ink)]">Sales key</h3>
            <div className="mt-2">
              <ShowOnceCredentialBlock
                value={created.secret}
                maskedValue={`${created.key_prefix}••••••••••••`}
                label="Sales key"
                copyText="Copy key"
                onCopied={() => setCopied(true)}
              />
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

export default CreateSalesKeyDialog
