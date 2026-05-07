'use client'

interface PasskeyOtherDeviceNoticeProps {
  className?: string
}

export default function PasskeyOtherDeviceNotice({
  className = '',
}: PasskeyOtherDeviceNoticeProps) {
  return (
    <div className={`rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-5 py-4 ${className}`.trim()}>
      <p className="text-sm font-semibold text-[var(--v2-ink)]">
        This account uses a passkey on another device.
      </p>
      <p className="mt-2 text-sm text-[var(--v2-ink-2)] leading-relaxed">
        Sign in from the device where you set up Face ID / Touch ID to approve payments from this account.
        Cross-device passkey support is coming soon.
      </p>
    </div>
  )
}
