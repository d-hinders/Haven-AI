'use client'

import { useRef } from 'react'
import type { ReactNode } from 'react'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'

export interface ConfirmDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void | Promise<void>
  title: string
  /** Body copy. String is rendered as a paragraph; pass JSX for richer content. */
  body: ReactNode
  /** Primary button label. Use the action verb, e.g. "Revoke agent". */
  confirmLabel: string
  cancelLabel?: string
  /** Visual emphasis for the primary button. Defaults to "danger". */
  tone?: 'danger' | 'primary'
  /** Disable the confirm button (e.g. while the confirm action is running). */
  loading?: boolean
}

/**
 * Styled confirmation dialog. Replaces browser-native `window.confirm`
 * for any destructive action (revoke, remove, delete, reject).
 */
export default function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null)

  return (
    <Modal
      open={open}
      onClose={loading ? () => undefined : onCancel}
      title={title}
      initialFocusRef={confirmBtnRef}
      closeOnBackdrop={!loading}
      footer={(
        <>
          <Button
            type="button"
            variant="tertiary"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={confirmBtnRef}
            type="button"
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => void onConfirm()}
            disabled={loading}
            className="min-w-24"
          >
            {loading ? 'Working...' : confirmLabel}
          </Button>
        </>
      )}
    >
      {typeof body === 'string' ? <p>{body}</p> : body}
    </Modal>
  )
}
