'use client'

import { useState } from 'react'
import { CopyButton } from '@/components/ui/CopyButton'
import {
  MERCHANT_KIT_PILOT_LINE,
  MERCHANT_KIT_README_URL,
  OWN_SERVER_SETUP_PROMPT_COPY,
  OWN_SERVER_SETUP_PROMPT_LABEL,
  merchantKitSetupPrompt,
  ownServerSetupPrompt,
} from '@/lib/i18n/messages/en'
import { havenApiOrigin } from '@/lib/sales'

/** Base Sepolia — the one network the merchant kit runs on during the pilot (#4985). */
const BASE_SEPOLIA_CHAIN_ID = 84532

/**
 * The two setup prompts a seller can paste to their coding agent (#4985, #5010).
 *
 * One function, shared by the first-run helper and the Setup tab, so the two
 * surfaces offer the same prompts. Both texts are built by `en.ts`
 * (`merchantKitSetupPrompt` and `ownServerSetupPrompt`, copy-linted) and copied
 * through `CopyButton`'s labelled `text` shape — neither is printed.
 * `onCopyFailed` reveals the one that was refused, because a value that is not
 * on screen would otherwise be lost.
 *
 * The first prompt sets up Haven's merchant kit; the second sets up the
 * merchant's own MCP server or HTTP API, which is a seller in the design's
 * sense (`docs/architecture/12-merchant-kit.md` § *Selling without the kit*).
 * Each copy control has its own accessible name ("Copy setup prompt" and
 * "Copy own-server prompt"), so a query for one never matches the other.
 *
 * **Base Sepolia only.** The merchant kit's README says this release runs on
 * Base Sepolia only, and #4891 holds the mainnet step until #4888. A Sales
 * account can be on Base (`modules/merchant-services.ts` accepts every
 * delegation-rail chain, which includes 8453), so on any other chain this
 * renders the pilot line and the README link and offers neither prompt.
 *
 * Neither prompt carries a Sales key secret or a key prefix: both tell the
 * agent to ask the merchant for a key they create on Sales → Setup → Sales
 * keys.
 */
export function SellerSetupPrompt({
  accountAddress,
  chainId,
  className = '',
}: {
  accountAddress: string
  chainId: number
  className?: string
}) {
  const [revealed, setRevealed] = useState<'kit' | 'own-server' | null>(null)

  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return (
      <div className={className} data-testid="seller-setup-pilot-only">
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

  const salesUrl = havenApiOrigin()
  const kitPrompt = merchantKitSetupPrompt({ accountAddress, salesUrl })
  const ownServerPrompt = ownServerSetupPrompt({ accountAddress, salesUrl })

  return (
    <div className={className} data-testid="seller-setup-prompts">
      <div data-testid="seller-setup-kit-prompt">
        <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
          Set up the merchant kit with your coding agent. {MERCHANT_KIT_PILOT_LINE}
        </p>
        <div className="mt-2">
          <CopyButton
            value={kitPrompt}
            label="setup prompt"
            text="Copy setup prompt"
            onCopyFailed={() => setRevealed('kit')}
          />
        </div>
        {revealed === 'kit' ? (
          <pre
            data-testid="seller-setup-kit-prompt-text"
            className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-[var(--v2-border)] bg-[var(--v2-surface-2)] p-3 text-xs leading-relaxed text-[var(--v2-ink-2)]"
          >
            {kitPrompt}
          </pre>
        ) : null}
      </div>
      <div className="mt-4" data-testid="seller-setup-own-server-prompt">
        <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
          {OWN_SERVER_SETUP_PROMPT_LABEL}.
        </p>
        <div className="mt-2">
          <CopyButton
            value={ownServerPrompt}
            label="own-server prompt"
            text={OWN_SERVER_SETUP_PROMPT_COPY}
            onCopyFailed={() => setRevealed('own-server')}
          />
        </div>
        {revealed === 'own-server' ? (
          <pre
            data-testid="seller-setup-own-server-prompt-text"
            className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded border border-[var(--v2-border)] bg-[var(--v2-surface-2)] p-3 text-xs leading-relaxed text-[var(--v2-ink-2)]"
          >
            {ownServerPrompt}
          </pre>
        ) : null}
      </div>
    </div>
  )
}

export default SellerSetupPrompt
