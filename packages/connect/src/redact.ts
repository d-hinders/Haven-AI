const API_KEY_RE = /sk_agent_[A-Za-z0-9]+/g
const PRIVATE_KEY_RE = /0x[0-9a-fA-F]{64}/g

export function redactSecrets(value: string): string {
  return value
    .replace(API_KEY_RE, 'sk_agent_[redacted]')
    .replace(PRIVATE_KEY_RE, '0x[redacted-private-key]')
}

/**
 * Sanitizer for messages that enter the machine-readable `--json` contract
 * (#2091). The failure record used to omit the message entirely because it
 * "can contain server or filesystem detail"; keeping that stance made every
 * refusal opaque to automation. Redact instead of omit: secrets always, plus
 * the credential-file paths the human log already masks in redact-paths mode.
 */
export function redactForAutomation(value: string): string {
  return redactSecrets(value)
    .replace(/(?:~|\/)[^\s`"']*\/(?:identity|signer|agent)\.json\b/g, '[credential-file-redacted]')
    .replace(/(?:~|\/)[^\s`"']*\/\.env\b/g, '[credential-env-redacted]')
}

/**
 * A URL with any `user:pass@` userinfo removed and trailing slashes dropped —
 * for log lines, `--json` records, the binding record's `api_url` and every
 * place a stored record is echoed or compared (#3154 reviews N6 / doc r2 /
 * doc r4: a record written before the write-side strip may still carry
 * userinfo, so the doctor strips on read as well). Unparseable input is
 * returned unchanged.
 */
export function withoutUserinfo(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return url
  }
}

export function shortAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}
