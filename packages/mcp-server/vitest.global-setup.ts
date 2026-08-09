import { assertFreshDist } from '../../scripts/vitest/assert-fresh-dist.mjs'

export default async function setup(): Promise<void> {
  await assertFreshDist(['signer', 'sdk'])
}
