/**
 * The sale record's `merchant_reference` (docs/architecture/12-merchant-kit.md
 * §5), generated once per payment when the settle-once coordinator or the
 * paywall proxy reserves it. One implementation, here (#4950): the proxy, the
 * coordinator and the demo merchant's skip-settle hook import it, and no other
 * package defines one.
 */
import { randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * `sale_<ulid>`. A ULID: 48 bits of millisecond time and 80 random bits, in
 * Crockford base32 (26 characters), so references sort by creation time.
 */
export function newMerchantReference(nowMs: number = Date.now()): string {
  let time = ''
  let t = nowMs
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = randomBytes(16)
  let random = ''
  for (let i = 0; i < 16; i++) random += CROCKFORD[bytes[i] % 32]
  return `sale_${time}${random}`
}
