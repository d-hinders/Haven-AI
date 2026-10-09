- **Base history via Alchemy (no issue; follows PR #3753)**: `config.ts` gains
  `alchemyHistoryApiKey` (`ALCHEMY_HISTORY_API_KEY`, optional). When set, the Base and Base
  Sepolia transaction-history reads call Alchemy's `alchemy_getAssetTransfers` instead of
  Blockscout, whose public API refuses Railway with a Cloudflare challenge (HTTP 403, confirmed in
  production logs on 2026-10-09) and whose keyed API puts Base behind a paid plan. Unset, the reads
  stay on Blockscout.

  The new client is a read of public on-chain transfer history, mapped into the same row shapes the
  explorer legs already produce; it has no signer, relayer, delegation or settlement reach, and the
  key authenticates Haven to a data provider only, redacted from every error. Mutation-tested:
  reading the rounded float amount instead of the exact hex value, or dropping the key redaction,
  turns `explorer-alchemy.test.ts` red.

  Perimeter unchanged. No new authority, signer or settlement path. Custody unchanged.
