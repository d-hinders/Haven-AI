'use client'

/**
 * The #1097 cross-device heads-up, in one place: signing WORKS, but the
 * account's passkey is not marked on this device, so the ceremony may hand
 * off to the device that holds it — say so BEFORE the browser's QR dialog
 * surprises the user. A hint next to a working action, never a blocker.
 *
 * #3825: the global wallet menu used to carry this disclosure for every
 * flow (#1952's rendering); it left with the top-bar pill, so each owner-
 * signing flow now shows this line itself (owner decision 2026-10-09) —
 * #1969 declined offering the fallback passkey silently.
 */
export default function PasskeyElsewhereHint({ className = '' }: { className?: string }) {
  return (
    <p data-passkey-elsewhere-hint className={`text-xs text-[var(--v2-ink-muted)] ${className}`.trim()}>
      This account&apos;s passkey may be on another device — your browser will guide you there
      when you approve.
    </p>
  )
}
