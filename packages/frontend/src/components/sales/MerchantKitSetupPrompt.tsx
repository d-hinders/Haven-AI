'use client'

import { useState } from 'react'
import { CopyButton } from '@/components/ui/CopyButton'
import {
  MERCHANT_KIT_PILOT_LINE,
  MERCHANT_KIT_README_URL,
  merchantKitSetupPrompt,
} from '@/lib/i18n/messages/en'
import { havenApiOrigin } from '@/lib/sales'

/** Base Sepolia — the one network the merchant kit runs on during the pilot (#4985). */
const BASE_SEPOLIA_CHAIN_ID = 84532

/**
 * "Set up the merchant kit with your coding agent" (#4985).
 *
 * One function, shared by the first-run helper and the Setup tab, so the two
 * surfaces offer the same prompt. The prompt is built by
 * `merchantKitSetupPrompt` in `en.ts` (copy-linted) and copied through
 * `CopyButton`'s labelled `text` shape — it is NOT printed. `onCopyFailed`
 * reveals it when the clipboard refuses it, because a value that is not on
 * screen would otherwise be lost.
 *
 * **Base Sepolia only.** The merchant kit's README says this release runs on Base
 * Sepolia only, and #4891 holds the mainnet step until #4888. A Sales account
 * can be on Base (`modules/merchant-services.ts` accepts every delegation-rail
 * chain, which includes 8453), so on any other chain this renders the pilot
 * line and the README link and offers no prompt.
 *
 * The prompt never carries a Sales key secret or a key prefix: it tells the
 * agent to ask the merchant for a key they create on Sales → Setup → Sales
 * keys.
 */
export function MerchantKitSetupPrompt({
  accountAddress,
  chainId,
  className = '',
}: {
  accountAddress: string
  chainId: number
  className?: string
}) {
  const [revealed, setRevealed] = useState(false)

  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return (
      <div className={className} data-testid="merchant-kit-setup-pilot-only">
        <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
          {MERCHANT_KIT_PILOT_LINE}{' '}
          <a
            href={MERCHANT_KIT_README_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)]"
          >
            Read the kit setup guide
          </a>
        </p>
      </div>
    )
  }

  const prompt = merchantKitSetupPrompt({ accountAddress, salesUrl: havenApiOrigin() })

  return (
    <div className={className} data-testid="merchant-kit-setup-prompt">
      <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
        Set up the merchant kit with your coding agent. {MERCHANT_KIT_PILOT_LINE}
      </p>
      <div className="mt-2">
        <CopyButton
          value={prompt}
          label="setup prompt"
          text="Copy setup prompt"
          onCopyFailed={() => setRevealed(true)}
        />
      </div>
      {revealed ? (
        <pre
          data-testid="merchant-kit-setup-prompt-text"
          className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-[var(--v2-border)] bg-[var(--v2-surface-2)] p-3 text-xs leading-relaxed text-[var(--v2-ink-2)]"
        >
          {prompt}
        </pre>
      ) : null}
    </div>
  )
}

export default MerchantKitSetupPrompt
