export function parseX402Hostname(resourceUrl?: string | null): string | null {
  if (!resourceUrl) return null

  try {
    return new URL(resourceUrl).hostname
  } catch {
    return null
  }
}
