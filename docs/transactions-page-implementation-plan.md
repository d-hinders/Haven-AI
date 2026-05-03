# Transactions Page Implementation Plan

This is an implementation snapshot captured for PR #34 and may drift from the live codebase over time.

This document refines `/Users/danielhinders/.claude/plans/new-feature-in-the-calm-frog.md` into a codebase-ready implementation plan for Haven.

## Goal

Add a top-level authenticated **Transactions** page that shows a user's on-chain activity across all of their Haven-linked Safes, newest first, with backend-driven filtering and append-style pagination.

This is additive only. Existing transaction UIs on Dashboard and Account detail pages stay in place and keep their current per-Safe behavior.

## Existing Constraints In Haven

- Backend transactions are currently served only by `GET /transactions/:safeAddress` in [packages/backend/src/routes/transactions.ts](/Users/danielhinders/Projects/Haven%20AI/packages/backend/src/routes/transactions.ts).
- The frontend transaction type currently lives in [packages/frontend/src/types/transactions.ts](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/types/transactions.ts) and should remain frontend-owned unless we intentionally move shared types into `packages/sdk`.
- Haven already supports multiple chains, currently Gnosis (`100`) and Base (`8453`), so aggregated transactions must carry per-row `chainId`.
- The frontend already uses a local API wrapper in [packages/frontend/src/lib/api.ts](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/lib/api.ts), so new hooks should use `api.get(...)` rather than building raw `fetch` requests.
- The backend transaction cache in [packages/backend/src/lib/cache.ts](/Users/danielhinders/Projects/Haven%20AI/packages/backend/src/lib/cache.ts) honors TTL unless the key is explicitly deleted. A frontend-only remount is not a true refresh.

## Product Decisions

- Aggregation is server-side.
- Pagination is offset-based with a `Load more` button that appends rows in place.
- Filters are single-select dropdowns for Safe, Initiator, and Token; all active filters are ANDed together.
- Selected filters render as removable chips above the results.
- The Agent filter includes a synthetic `User (manual)` option.
- Dashboard and Account detail transaction lists are unchanged.

## Backend

### 1. Refactor shared transaction fetch logic

Modify [packages/backend/src/routes/transactions.ts](/Users/danielhinders/Projects/Haven%20AI/packages/backend/src/routes/transactions.ts):

- Extract the current `txCache.getOrFetch(...)` block used by `GET /:safeAddress` into a private helper:
  - `fetchSafeTransactions({ safeId, safeAddress, chainId, log, fresh })`
- Keep existing caching behavior by default.
- When `fresh === true`, delete the cache key before fetching so the request bypasses the 30-second cache.
- Reuse this helper from both the existing per-Safe route and the new aggregated routes.

### 2. Extend transaction shapes for aggregation

Keep the current backend `Transaction` shape for raw per-Safe fetches, then define an enriched aggregated shape in the same route module:

```ts
interface EnrichedTransaction extends Transaction {
  chainId: number
  safeId: string
  safeAddress: string
  safeName: string
  agentId?: string
  agentName?: string
}
```

Notes:

- `chainId` is required for explorer links and native-token display on the frontend.
- Do not make the frontend import this type directly from the backend route file. Mirror the response shape in [packages/frontend/src/types/transactions.ts](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/types/transactions.ts).

### 3. Add `GET /transactions`

Register this route before `GET /:safeAddress`.

#### Query params

- `safeId?: string`
- `agentId?: string`
  - UUID for a specific agent
  - literal `'user'` for manual outbound transactions
- `tokenKey?: string`
  - canonical value format:
    - native token: `${chainId}:native`
    - ERC-20 token: `${chainId}:${tokenAddress.toLowerCase()}`
- `offset?: string` default `0`
- `limit?: string` default `25`, max `100`
- `fresh?: '1' | 'true'`

#### Behavior

1. Read all user-owned Safes from `user_safes`.
2. If `safeId` is present, verify ownership and narrow to that Safe.
3. For each Safe, call `fetchSafeTransactions(...)`.
4. If an individual Safe fetch fails, log it and continue with the rest.
5. Tag every returned row with:
   - `chainId`
   - `safeId`
   - `safeAddress`
   - `safeName`
6. Merge all rows and sort by `timestamp DESC`.
7. Dedupe with key:
   - `${hash}:${type}:${from}:${to}:${safeAddress.toLowerCase()}`
   - This preserves two rows for transfers between two user-owned Safes.
8. Enrich by matching `payment_intents` and `agents`:
   - select `LOWER(pi.tx_hash) AS tx_hash`
   - `pi.agent_id`
   - `a.name AS agent_name`
   - only `pi.status = 'confirmed'`
9. Apply filters after enrichment:
   - `safeId`: already narrowed during Safe lookup
   - `agentId === 'user'`: keep only `direction === 'out'` and no linked `agentId`
   - `agentId === <uuid>`: keep only rows where `agentId` matches
   - `tokenKey === '${chainId}:native'`: keep only non-ERC20 rows on that chain
   - `tokenKey === '${chainId}:${address}'`: keep only ERC20 rows with matching chain and token address
10. Compute:
   - `total`
   - `transactions = filtered.slice(offset, offset + limit)`
   - `hasMore = total > offset + transactions.length`
11. Return:

```ts
{
  transactions: EnrichedTransaction[],
  total: number,
  offset: number,
  limit: number,
  hasMore: boolean,
  partialFailure: boolean,
  failedSafeIds: string[],
}
```

#### Error handling

- If all Safes fail, still return a valid empty payload with `partialFailure: true`.
- Invalid `safeId`, invalid `agentId`, malformed `tokenKey`, or invalid pagination values should return `400`.

### 4. Add `GET /transactions/filters`

Register this route before `GET /:safeAddress`.

#### Query params

- `fresh?: '1' | 'true'`

#### Response shape

```ts
{
  safes: Array<{
    id: string
    name: string
    address: string
    chainId: number
  }>
  agents: Array<{
    id: string
    name: string
    status: string
  }>
  tokens: Array<{
    key: string
    symbol: string
    address: string | null
    chainId: number
    isNative: boolean
  }>
}
```

#### Behavior

1. Load `user_safes`.
2. Load `agents` for the user using the same status values already exposed by `GET /agents`.
3. Build token options by iterating transactions for each user Safe.
4. To avoid a cold-cache empty token list, this endpoint must use the same fetch helper as the feed route, not cache-only reads.
5. Respect `fresh` the same way as the feed route.
6. Always include each Safe's native token, even if there is no history.
7. Deduplicate token options by `key`, not by `symbol`.
8. Sort token options:
   - native token first within each chain
   - then ERC-20 tokens alphabetically by `symbol`

### 5. Keep `GET /transactions/:safeAddress` working

The existing route must remain backward-compatible for Dashboard and Account detail pages.

Required changes:

- Allow it to call the shared helper instead of duplicating fetch logic.
- Optionally accept `fresh=1` for parity with the aggregated page refresh control.
- Keep its existing `page/pages` response contract so current consumers do not break.

## Frontend

### 1. Add authenticated page shell

Create [packages/frontend/src/app/(authenticated)/transactions/page.tsx](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/app/%28authenticated%29/transactions/page.tsx) using the same dynamic-import pattern as the dashboard and account pages.

### 2. Add frontend transaction and filter types

Update [packages/frontend/src/types/transactions.ts](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/types/transactions.ts) with additive types:

- `AggregatedTransaction`
- `TransactionsFeedResponse`
- `TransactionFilterOptionsResponse`
- `TransactionFilterState`

Suggested filter state:

```ts
interface TransactionFilterState {
  safeId?: string
  agentId?: string
  tokenKey?: string
}
```

### 3. Add `useTransactionsFeed`

Create [packages/frontend/src/hooks/useTransactionsFeed.ts](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/hooks/useTransactionsFeed.ts).

Responsibilities:

- Use `api.get<TransactionsFeedResponse>(...)`.
- Own:
  - accumulated `transactions`
  - `loadingInitial`
  - `loadingMore`
  - `refreshing`
  - `hasMore`
  - `error`
  - `partialFailure`
  - `failedSafeIds`
- On filter change:
  - reset list state
  - fetch first page with `offset=0`
- On `loadMore()`:
  - fetch next page using `offset=transactions.length`
  - append rows
- On `refresh()`:
  - refetch from `offset=0&fresh=1`
  - replace rows
- Guard against race conditions so stale responses from previous filter states do not overwrite current state.

### 4. Add `useTransactionFilters`

Create [packages/frontend/src/hooks/useTransactionFilters.ts](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/hooks/useTransactionFilters.ts).

Responsibilities:

- Fetch `/transactions/filters` via `api.get<TransactionFilterOptionsResponse>(...)`
- Expose:
  - `safes`
  - `agents`
  - `tokens`
  - `loading`
  - `error`
  - `refresh`
- Support `fresh=1` on manual refresh.

### 5. Add page client

Create [packages/frontend/src/app/(authenticated)/transactions/TransactionsClient.tsx](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/app/%28authenticated%29/transactions/TransactionsClient.tsx).

Layout:

- page header with title, subtitle, and `Refresh` button
- partial-failure warning banner when `partialFailure === true`
- filter bar
- results table/card list
- `Load more` button or end-of-list label

Behavior:

- Fetch filter options and the first page on mount.
- If the user has zero Safes, show a dedicated empty state with CTA to `/onboarding` rather than the generic transaction-empty state.
- Keep the filter bar visible when filters yield zero results.
- Hide the per-row "From-Safe" tag when a single Safe is selected.

### 6. Add `FilterBar`

Create [packages/frontend/src/components/transactions/FilterBar.tsx](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/components/transactions/FilterBar.tsx).

Requirements:

- Reuse the dropdown interaction pattern from [packages/frontend/src/components/sidebar/SafeSwitcher.tsx](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/components/sidebar/SafeSwitcher.tsx).
- Three single-select dropdowns:
  - Safe
  - Initiator
  - Token
- Show active chips below the controls.
- Safe dropdown:
  - disabled when the user has exactly one Safe
- Agent dropdown:
  - `All`
  - `User (manual)`
  - active agents first
  - paused/revoked after active, visually muted
- Token dropdown:
  - labels may repeat across chains, so include chain context when needed, e.g. `USDC (Base)` or `Native xDAI (Gnosis)`
- Clearing a chip should update only that filter.

### 7. Add `TransactionsTable`

Create [packages/frontend/src/components/transactions/TransactionsTable.tsx](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/components/transactions/TransactionsTable.tsx).

Desktop columns:

1. Direction
2. From
3. To
4. Initiator
5. Amount + Token
6. Timestamp
7. Explorer link

Display rules:

- Use `useContacts().resolveAddress` for address labels.
- If an address matches a user-owned Safe, prefer the Safe name and show a subtle `Safe` tag.
- Initiator column:
  - outbound with `agentName` => `Agent: <name>`
  - outbound without `agentName` => `User`
  - inbound => `—`
- Use each row's `chainId` when building explorer links.
- If no Safe filter is active, show a compact per-row source-Safe tag.
- Reuse the visual idioms from [packages/frontend/src/components/TransactionList.tsx](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/components/TransactionList.tsx) for loading, error, and empty-state styling.

Mobile behavior:

- Collapse each row into a stacked card.
- Do not attempt a horizontal table on small screens.

### 8. Update sidebar navigation

Modify [packages/frontend/src/components/sidebar/Sidebar.tsx](/Users/danielhinders/Projects/Haven%20AI/packages/frontend/src/components/sidebar/Sidebar.tsx):

- add `transactions` icon
- add nav item between `Accounts` and `Agents`

## API Contracts Summary

### `GET /transactions`

```ts
type TransactionsFeedResponse = {
  transactions: AggregatedTransaction[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  partialFailure: boolean
  failedSafeIds: string[]
}
```

### `GET /transactions/filters`

```ts
type TransactionFilterOptionsResponse = {
  safes: Array<{ id: string; name: string; address: string; chainId: number }>
  agents: Array<{ id: string; name: string; status: string }>
  tokens: Array<{
    key: string
    symbol: string
    address: string | null
    chainId: number
    isNative: boolean
  }>
}
```

## Edge Cases

- User has zero Safes:
  - show onboarding-style empty state
- One or more Safe fetches fail:
  - render successful data
  - set `partialFailure: true`
- Transfer between two user-owned Safes:
  - show both rows
- Filters yield zero results:
  - keep controls visible
- Cold start:
  - filter endpoint still returns token options because it can warm per-Safe cache
- Manual refresh:
  - must bypass cache via `fresh=1`
- Token symbol collisions across chains:
  - resolved through `tokenKey`

## Verification

### Backend

Run:

```bash
npm run build -w packages/backend
npm run test -w packages/backend
```

Manual API smoke tests after starting the backend:

```bash
npm run dev -w packages/backend
```

Verify:

- `GET /transactions?limit=5`
- `GET /transactions?safeId=<uuid>`
- `GET /transactions?agentId=user`
- `GET /transactions?agentId=<uuid>`
- `GET /transactions?tokenKey=100:native`
- `GET /transactions?tokenKey=8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`
- combined filters
- `fresh=1`
- `GET /transactions/filters`
- existing `GET /transactions/:safeAddress`

### Frontend

Run:

```bash
npm run build -w packages/frontend
npm run test -w packages/frontend
```

Manual checks:

- new sidebar entry navigates to `/transactions`
- rows render newest-first across Safes
- dropdowns apply and clear correctly
- load-more appends in place
- refresh reloads data without waiting for cache TTL
- partial-failure warning appears only when needed
- explorer links use the correct chain per row
- Dashboard and Account detail transaction lists still work

## Out Of Scope

- CSV export
- search by hash or address
- date-range filtering
- alternate sort orders
- real-time subscriptions
- changes to existing Dashboard or Account detail transaction UIs
