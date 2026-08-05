'use client'

/**
 * Owner send for a delegation-rail account (#1083).
 *
 * One signature moves funds account → recipient (sponsored — no gas for the
 * user, and it works even before the account's first on-chain action).
 * Outcome language throughout; a dismissed Face ID sheet is a neutral
 * cancel, never an error (#1076/#1085 discipline).
 */

import { useMemo, useState } from 'react'
import { isAddress, parseUnits } from 'viem'
import type { Address } from 'viem'
import { useDelegationSend } from '@/hooks/useDelegationSend'
import { getChainTokens } from '@/lib/safe-tx'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { useToast } from './ui/Toast'

interface Props {
  open: boolean
  onClose: () => void
  accountAddress: string
  chainId: number
  onSent?: () => void
}

export default function DelegationSendModal({ open, onClose, accountAddress, chainId, onSent }: Props) {
  const { busy, ready, passkeyElsewhere, send } = useDelegationSend(accountAddress, chainId)
  const { toast } = useToast()

  const tokens = useMemo(
    () =>
      Object.entries(getChainTokens(chainId))
        .filter(([, cfg]) => cfg.address !== null)
        .map(([symbol, cfg]) => ({ symbol, address: cfg.address as Address, decimals: cfg.decimals })),
    [chainId],
  )
  const [tokenSymbol, setTokenSymbol] = useState(tokens[0]?.symbol ?? '')
  const token = tokens.find((t) => t.symbol === tokenSymbol) ?? tokens[0]
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')

  const recipientValid = isAddress(recipient.trim())
  const amountAtomic = useMemo(() => {
    if (!token || !amount.trim() || Number(amount) <= 0) return null
    try {
      return parseUnits(amount.trim(), token.decimals).toString()
    } catch {
      return null
    }
  }, [amount, token])
  const canSend = ready && !busy && recipientValid && amountAtomic !== null

  async function handleSend() {
    if (!token || !amountAtomic) return
    const result = await send({
      tokenAddress: token.address,
      to: recipient.trim() as Address,
      amountAtomic,
    })
    if (result.ok) {
      toast.success('Sent.')
      setAmount('')
      setRecipient('')
      onSent?.()
      onClose()
    } else if (result.reason === 'cancelled') {
      toast.info('Signature was cancelled.')
    } else {
      toast.error(result.message ?? 'Haven could not send this payment. Try again.')
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Send">
      <div className="space-y-3">
        <p className="text-sm text-[var(--v2-ink-muted)]">
          Send from this account with one approval. No network fee for you.
        </p>
        <div className="flex gap-2">
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount"
            aria-label="Amount"
            inputMode="decimal"
          />
          <select
            value={tokenSymbol}
            onChange={(e) => setTokenSymbol(e.target.value)}
            aria-label="Token"
            className="rounded-md border border-[var(--v2-border-strong)] bg-white px-3 text-sm text-[var(--v2-ink)]"
          >
            {tokens.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
        <Input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Recipient address (0x…)"
          aria-label="Recipient address"
          className="font-mono"
        />
        {!ready ? (
          // #1097: only reachable for owner-only accounts (the optimistic
          // passkey fallback keeps `ready` true otherwise).
          <p className="text-xs text-[var(--v2-ink-muted)]">
            Connect the account&apos;s owner wallet to send.
          </p>
        ) : null}
        {ready && passkeyElsewhere ? (
          <p className="text-xs text-[var(--v2-ink-muted)]">
            This account&apos;s Face ID / Touch ID may be on another device — your browser will
            guide you there when you approve.
          </p>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSend} onClick={() => void handleSend()}>
            {busy ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
