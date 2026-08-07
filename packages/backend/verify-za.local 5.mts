import { Wallet } from 'ethers'
const BASE = 'https://havenbackend-dev-8b95.up.railway.app'
const owner = Wallet.createRandom()
const email = `verify-za-${Math.random().toString(36).slice(2, 8)}@haven.test`
async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, never> }
}
const signup = await api('POST', '/auth/signup', { name: 'VerifyZA', email, password: 'Vfy-za-1!x' })
const token = signup.json.token as string
await api('POST', '/accounts/hybrid', { chain_id: 84532, owner_address: owner.address }, token)
const me = await api('GET', '/auth/me', undefined, token)
const safe = ((me.json.safes ?? []) as Array<Record<string, unknown>>).find((s) => s.account_type === 'delegator_hybrid')!
const prep = await api('POST', `/accounts/hybrid/${safe.safe_address}/signers/prepare?chain_id=84532`, {
  action: 'add_passkey',
  passkey: { key_id: '0x' + 'ab'.repeat(32), x: '0x1', y: '0x2' },
}, token)
console.log('prepare:', prep.status, prep.json.signature_scheme ?? prep.json.error ?? '')
if (prep.status === 200) { console.log('ZERO-AGENT ENROL FIXAD'); process.exit(0) }
process.exit(1)
