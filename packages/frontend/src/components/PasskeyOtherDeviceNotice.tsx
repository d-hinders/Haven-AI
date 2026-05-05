'use client'

interface PasskeyOtherDeviceNoticeProps {
  className?: string
}

export default function PasskeyOtherDeviceNotice({
  className = '',
}: PasskeyOtherDeviceNoticeProps) {
  return (
    <div className={`rounded-xl border border-amber-500/20 bg-amber-500/[0.05] px-5 py-4 ${className}`.trim()}>
      <p className="text-sm font-semibold text-amber-100">
        This Safe uses a passkey on another device.
      </p>
      <p className="mt-2 text-sm text-amber-200/80 leading-relaxed">
        Sign in from the device where you set up Face ID / Touch ID to operate this Safe.
        Cross-device passkey support is coming soon.
      </p>
    </div>
  )
}
