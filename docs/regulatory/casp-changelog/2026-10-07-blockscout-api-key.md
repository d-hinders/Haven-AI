- **Blockscout history reads (no issue; production 403s on 2026-10-07)**: `config.ts` gains
  `blockscoutApiKey` (`BLOCKSCOUT_API_KEY`, optional), sent as `apikey` on the Base and Base
  Sepolia Blockscout v2 transaction-history reads. Every explorer request now carries a
  `User-Agent`, a refused request's error carries a 200-character excerpt of the response body,
  and a history read with a failed leg is no longer cached.

  All of it is on the read-only history path: the explorer client fetches public on-chain data and
  has no signer, relayer, delegation or settlement reach. The key authenticates Haven to a public
  explorer and grants no authority over any account. Mutation-tested: restoring the unconditional
  cache write turns `aggregate-failed-read-cache.test.ts` red, dropping the key or header turns
  `explorer-request.test.ts` red.

  Perimeter unchanged. No new authority, signer or settlement path. Custody unchanged.
