const URL_RE = /https?:\/\/[^\s)]+/i
const REMAINING_BUDGET_RE =
  /exceeds remaining (?:on-chain )?allowance|above the remaining budget|exceeds the remaining/i

export function approvalRecipientLabel({
  reason,
  source,
  x402ResourceUrl,
  toAddress,
}: {
  reason?: string | null
  source?: string | null
  x402ResourceUrl?: string | null
  toAddress: string
}): string {
  const sourceHostname = source === 'x402' || source === 'mpp_demo'
    ? hostnameFromUrl(x402ResourceUrl)
    : null
  if (sourceHostname) return sourceHostname

  const hostname = hostnameFromReason(reason)
  if (hostname) return hostname
  return truncateAddress(toAddress)
}

export function approvalReasonLabel({
  reason,
  source,
}: {
  reason?: string | null
  source?: string | null
}): string {
  if (reason && REMAINING_BUDGET_RE.test(reason)) {
    return 'This payment is above the remaining agent budget.'
  }

  if (source === 'x402' || reason?.toLowerCase().includes('x402 payment')) {
    return 'This x402 payment needs your manual approval before any money moves.'
  }

  if (source === 'mpp_demo' || reason?.toLowerCase().includes('machine payment demo')) {
    return 'This machine payment demo needs your manual approval before any money moves.'
  }

  return reason?.trim() || 'This payment needs your manual approval before any money moves.'
}

export function approvalSourceLabel({
  reason,
  source,
}: {
  reason?: string | null
  source?: string | null
}): string | null {
  if (source === 'x402' || reason?.toLowerCase().includes('x402 payment')) return 'x402 payment'
  if (source === 'mpp_demo' || reason?.toLowerCase().includes('machine payment demo')) return 'Machine payment demo'
  return null
}

function hostnameFromReason(reason?: string | null): string | null {
  const match = reason?.match(URL_RE)
  if (!match) return null
  return hostnameFromUrl(match[0])
}

function hostnameFromUrl(url?: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}
