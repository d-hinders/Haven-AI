- **agent auth decides the recovery exemption from the matched route** — a
  narrowing of an agent-key authorization decision in
  `packages/backend/src/middleware/agentAuth.ts`. No payment, signing,
  custody or relay code moved. Perimeter unchanged or narrower.
  What changed. A paused, pending, archived or revoked agent key stays usable
  for one operation, sweep recovery: `POST /machine-payments/sweep/prepare`
  and `POST /machine-payments/sweep/submit`. These move a stranded delegate
  balance back to the agent's own bound account, and are the reason a
  retired key can still promise recovery. Until now the middleware decided
  that exemption with a suffix test on `request.url`. It now looks the
  matched route up in `SWEEP_RECOVERY_ROUTES`, a set of exactly those two
  `METHOD pattern` entries, and builds the key from
  `request.routeOptions.url` (the registered pattern, mount prefix
  included) and the request method. The middleware is an `onRequest` hook
  of the route modules, so it already runs after routing. A request that
  matched no route has no pattern and is never recovery. Every other
  route gives these keys their normal refusal: `agent_paused` 403,
  `agent_pending_approval` 403, or the invalid-key 401. Authority argument:
  the exemption can only get smaller. It was granted to any request whose
  request-target string ended in either suffix. It is now granted only when
  the router actually dispatches to one of the two sweep handlers. Those
  handlers are unchanged. They still re-derive the transfer from the bound
  account (`insertPreparedSweepForBoundAgent` /
  `claimPreparedSweepForBoundAgent`), recover the delegate signature, and
  move funds only delegate → the agent's own account. Haven holds no key
  and signs no spend. Tested against real Postgres on a listening server
  with raw HTTP/1.1 request-targets
  (`src/middleware/__tests__/agent-auth-recovery-route.test.ts`). Paused
  and revoked keys are refused on the x402 spend route. The same keys still
  reach the real `sweep/prepare` handler (`nothing_stranded`) and the real
  `sweep/submit` handler (its unknown-nonce 404). Unit cases in
  `agentAuth.test.ts` pin the method half of the key, and pin that each
  entry is a registered operation of `routes/machine-payments.ts` in
  `ROUTE_MODULE_BY_OPERATION`. Each of these mutations reddens a test:
  restoring the suffix test, exempting every POST, dropping the method from
  the key, never exempting (recovery broken), and renaming one entry's
  prefix. Each was restored byte-identical (`cmp`) after. Perimeter
  unchanged.
