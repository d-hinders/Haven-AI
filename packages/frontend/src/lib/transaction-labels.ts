export function parseX402Hostname(resourceUrl?: string | null): string | null {
  if (!resourceUrl) return null

  try {
    return new URL(resourceUrl).hostname
  } catch {
    return null
  }
}

export function isMachinePaymentSource(source?: string | null): boolean {
  return source === 'x402' || source === 'mpp_demo'
}

export function paymentSourceTitle(source?: string | null): string | null {
  if (source === 'x402') return 'x402 payment'
  if (source === 'mpp_demo') return 'Machine payment demo'
  return null
}
