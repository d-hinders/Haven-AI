const API_KEY_RE = /sk_agent_[A-Za-z0-9]+/g
const PRIVATE_KEY_RE = /0x[0-9a-fA-F]{64}/g

export function redactSecrets(value: string): string {
  return value
    .replace(API_KEY_RE, 'sk_agent_[redacted]')
    .replace(PRIVATE_KEY_RE, '0x[redacted-private-key]')
}

export function shortAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}
