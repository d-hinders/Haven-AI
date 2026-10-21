- **agent auth decides the recovery exemption from the matched route.** This
  narrows an agent-key authorization decision in
  `packages/backend/src/middleware/agentAuth.ts`. It also removes a
  request-target fallback from the unauthenticated catalogue predicate in
  `packages/backend/src/routes/catalog.ts` (defence in depth, no behaviour
  change; see below). No payment, signing, custody or relay code moved. The
  perimeter narrows.
  What the exemption is. A paused, pending, archived or revoked agent key
  stays usable for one operation, sweep recovery:
  `POST /machine-payments/sweep/prepare` and
  `POST /machine-payments/sweep/submit`. These move a stranded delegate
  balance back to the agent's own bound account. They are why a retired key
  can still promise recovery.
  The prior exposure, recorded as it stood. The previous predicate tested
  the request-target up to the first `?` for a suffix: did it end in
  `/sweep/prepare` or `/sweep/submit`? It did not ask which route the
  router had matched. Every agent-key route plugin runs the middleware:
  x402, payments, machine-payments, task-budgets, sub-budgets,
  reconciliation events, catalogue, merchants and tax declaration. On any of them, a
  paused, pending, archived or revoked key passed agent auth when its
  request-target ended in either suffix. That held even when the suffix
  sat in a fragment, which the router ignores when it matches a route. So
  such a request was dispatched to a non-recovery handler as an
  authenticated agent. The x402, payments and machine-payments modules
  were checked, and none re-checks the calling agent's status. A revoked key's
  on-chain delegation may already be gone. A paused agent keeps its
  on-chain allowance, though, so a paused key could reach spend routes it
  is meant to be refused on. What is NOT verified: whether production
  ingress passes a fragment in the request-target through to the backend,
  and whether this was ever used. Both remain open (owner follow-up: check
  the production request logs).
  What changed. The middleware now looks the matched route up in
  `SWEEP_RECOVERY_ROUTES`, a set of exactly those two `METHOD pattern`
  entries. It builds the key from `request.routeOptions.url` (the
  registered pattern, mount prefix included) and the request method. The
  middleware is an `onRequest` hook of the route modules, so it already
  runs after routing. A request that matched no route has no pattern and
  is never recovery. Every other route gives these keys their normal
  refusal: `agent_paused` 403, `agent_pending_approval` 403, or the
  invalid-key 401 (archived, revoked). The sweep handlers are unchanged.
  They still re-derive the transfer from the bound account
  (`insertPreparedSweepForBoundAgent` / `claimPreparedSweepForBoundAgent`),
  recover the delegate signature, and move funds only delegate → the
  agent's own account. Haven holds no key and signs no spend.
  `isPublicCatalogRead` likewise drops its fallback to the request-target
  string. For real traffic that fallback could not be reached: the predicate
  runs in a plugin `onRequest` hook, and a request that matches no route gets
  the root 404 before any plugin hook runs. A probe of the real catalogue and
  merchants plugins gave identical answers before and after for every target.
  The change is defence in depth: the predicate no longer reads the
  request-target at all.
  Tested against real Postgres on a listening server with raw HTTP/1.1
  request-targets
  (`src/middleware/__tests__/agent-auth-recovery-route.test.ts`). Paused,
  pending, archived and revoked keys are each refused on the x402 spend
  route, both plain and with a sweep suffix in the fragment. The same four
  keys still reach the real `sweep/prepare` handler (`nothing_stranded`)
  and the real `sweep/submit` handler (its unknown-nonce 404). Unit cases
  in `agentAuth.test.ts` pin the method half of the key, and pin that each
  entry is a registered operation of `routes/machine-payments.ts` in
  `ROUTE_MODULE_BY_OPERATION`. A case in `catalog.test.ts` pins the
  catalogue predicate without its fallback (called with a request object, not
  through the router). Each of these mutations reddens a test:
  restoring the suffix test; exempting every POST; dropping the method from
  the key; never exempting (recovery broken); renaming one entry's prefix;
  re-adding request-target leniency only on the archived branch, or only
  on the pending branch; and restoring the catalogue fallback. Each was
  restored byte-identical (`cmp`) after. Perimeter narrowed.
