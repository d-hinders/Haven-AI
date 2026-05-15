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
  /** Disable the confirm button without changing the button label. */
  confirmDisabled?: boolean
  /** Wrap the confirm button when the caller needs an extra guard, such as network switching. */
  confirmButtonWrapper?: (button: ReactNode) => ReactNode
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
  confirmDisabled = false,
  confirmButtonWrapper,
}: ConfirmDialogProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null)
  const confirmBtnRef = useRef<HTMLButtonElement>(null)
  const initialFocusRef = confirmDisabled ? cancelBtnRef : confirmBtnRef
  const confirmButton = (
    <Button
      ref={confirmBtnRef}
      type="button"
      variant={tone === 'danger' ? 'danger' : 'primary'}
      onClick={() => void onConfirm()}
      disabled={loading || confirmDisabled}
      className="min-w-24"
    >
      {loading ? 'Working...' : confirmLabel}
    </Button>
  )

  return (
    <Modal
      open={open}
      onClose={loading ? () => undefined : onCancel}
      title={title}
      initialFocusRef={initialFocusRef}
      closeOnBackdrop={!loading}
      footer={(
        <>
          <Button
            ref={cancelBtnRef}
            type="button"
            variant="tertiary"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          {confirmButtonWrapper ? confirmButtonWrapper(confirmButton) : confirmButton}
        </>
      )}
    >
      {typeof body === 'string' ? <p>{body}</p> : body}
    </Modal>
  )
}
