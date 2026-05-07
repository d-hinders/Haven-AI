'use client'

interface PasskeyOtherDeviceNoticeProps {
  className?: string
}

export default function PasskeyOtherDeviceNotice({
  className = '',
}: PasskeyOtherDeviceNoticeProps) {
  return (
    <div className={`rounded-xl border border-[var(--v2-brand)]/20 bg-white px-5 py-4 shadow-[var(--v2-shadow-card)] ${className}`.trim()}>
      <div className="flex gap-3">
        <div className="mt-1 h-2 w-2 rounded-full bg-[var(--v2-brand)] flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-[var(--v2-ink)]">
            This account uses a passkey on another device.
          </p>
          <p className="mt-2 text-sm text-[var(--v2-ink-2)] leading-relaxed">
            Sign in from the device where you set up Face ID / Touch ID to approve payments from this account.
            Cross-device passkey support is coming soon.
          </p>
        </div>
      </div>
    </div>
  )
}
