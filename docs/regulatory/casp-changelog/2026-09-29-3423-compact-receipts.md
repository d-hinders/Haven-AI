- **#3423 slice C** — `haven_list_receipts` accepts an opt-in `compact: true`
  (the owner decision on #3423). Each row then omits `challengePayload`,
  `selectedPayment` and `protocolReceiptPayload`: the merchant's 402 challenge,
  the selected option and the merchant's PAYMENT-RESPONSE, echoed verbatim.
  The keys are absent, not null. The stripping happens once, client-side, in
  the SDK's `listReceiptsPage({ compact })`
  (`packages/sdk/src/account-reads.ts`). The hosted
  (`packages/mcp-server/src/tools/{contracts,state-direct-recovery}.ts`) and
  local (`packages/mcp/src/tools.ts`) tools accept the key and pass it
  through, so the two surfaces cannot drift. Without the flag every row is
  byte-identical to before. **No custody or authority change:** a read-only
  history listing gets shorter on request. No payment, signature, key,
  delegation, budget or backend route changes, and Haven's own record fields
  (`parties`, amounts, hashes, status) are untouched. List rows were never
  signed bundles, so `haven_verify_receipt` is unaffected. Mutation-tested:
  ignoring the flag in the SDK fails the SDK, hosted and local tests; keeping
  `protocolReceiptPayload` fails the same three; dropping the flag at the
  hosted or at the local tool fails only that surface's test. Perimeter
  unchanged.
