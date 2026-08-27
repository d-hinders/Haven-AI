/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Generated from `packages/backend/src/openapi/spec.ts` by
 * `scripts/generate-api-types.mjs` (#984). Regenerate with:
 *
 *   npm run generate:api-types
 *
 * CI fails on drift (`npm run check:api-types`): edit the spec, then
 * regenerate — never this file. Frontend-only derived types belong in the
 * frontend, extending these; wire shapes live here and only here.
 */
export type paths = {
    "/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch this OpenAPI document. */
        get: operations["getOpenApiSpec"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check backend and database health. */
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Haven agents for the signed-in user. */
        get: operations["listAgents"];
        put?: never;
        /**
         * Create a Haven agent identity and API key.
         * @description Creates the API identity for an agent — identity and credential only. Payment authority arrives separately as an owner-signed budget delegation, enforced on-chain (#1440/#2020: the per-token allowance mirror is retired; the response’s `allowances` is always empty at creation).
         */
        post: operations["createAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch one Haven agent. */
        get: operations["getAgent"];
        /**
         * Rename an agent or change its description.
         * @description Display metadata only — it changes no authority, no allowance and no key. The response carries the agent with its current allowances so a client can re-render without a second call.
         */
        put: operations["updateAgent"];
        post?: never;
        /**
         * RETIRED — always answers 410. Archive instead.
         * @description Deleting an agent is retired (#1401) and this route is a tombstone: **it always answers 410 and writes nothing.** Hard deletion failed outright on any agent with payment history (a foreign-key violation surfacing as a 500) and, where it did succeed, cascaded away seven tables of money-path audit trail. Removal is now an ARCHIVE that keeps the history: revoke the agent, kill its budgets, then POST /agents/{id}/archive. The typed route survives for reversibility, in the same spirit as the session-rail retirement.
         */
        delete: operations["deleteAgent"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegate-balance": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get on-chain USDC and ETH balance of the agent delegate EOA.
         * @description Reads on-chain balances for the delegate EOA linked to this agent. Used by the dashboard to surface stranded funds and by the sweep flow to show exact amounts. Haven never holds the delegate key; this endpoint only reads balances from the chain.
         */
        get: operations["getDelegateBalance"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Archive a revoked agent (soft removal — history is kept).
         * @description Replaces agent deletion (#1401). Requires status=revoked — archiving is a filing action and never the thing that stops spending. The agent row and every dependent audit row (payments, approvals, evidence, delegations, passports) remain; the agent leaves the primary list. Idempotent: re-archiving keeps the original archived_at.
         */
        post: operations["archiveAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/unarchive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Return an archived agent to the primary list.
         * @description Clears archived_at and nothing else — the agent remains revoked; un-archiving restores no authority of any kind. Idempotent on a non-archived agent.
         */
        post: operations["unarchiveAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark an agent as revoked in Haven.
         * @description Blocks Haven API access for the agent. Users can also revoke or change Safe module permissions outside Haven; on-chain revocation remains the authority boundary.
         */
        post: operations["revokeAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List an agent's budget delegations with lifecycle status.
         * @description Every grant the agent has, newest first, including pending (built but not owner-signed), replaced and revoked rows — the dashboard renders exactly what is and isn't live (#802). The signed delegation object itself is deliberately NOT in the list: it is api_key_hash-class data returned only by the explicit flows that need it.
         */
        get: operations["listAgentDelegations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegations/build": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Grant step 1: build an unsigned budget delegation for the owner to sign.
         * @description Builds the EIP-712 typed data for a period-budget delegation (token, atomic budget, refill period, optional recipient pin, expiry — defaulting to 90 days) and stores it as a pending row. Nothing is signed and nothing moves: the OWNER signs signing_payload client-side (one signature, zero transactions) and then calls activate. A rebuilt (token, recipient) slot gets a fresh version so replacements never collide (#827).
         */
        post: operations["buildAgentDelegation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegations/{hash}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Grant step 2: attach the owner signature and make the budget live.
         * @description Stores the owner's signature on the pending delegation and flips it active, marking any previously active grant in the same (token, recipient) slot replaced — atomically, so the slot never ends up with zero live grants mid-replacement. Deploys the counterfactual delegator account via the relayer first when needed (#860; permissionless factory call, no owner signature). Activating an agent's FIRST budget also activates a pending_approval agent — on this rail the grant signature IS the approval (#1069). Signature validation is a shape check only (65-byte ECDSA or longer WebAuthn assertion); the real validator is EIP-1271 at redemption.
         */
        post: operations["activateAgentDelegation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegations/{hash}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Revoke step 1: prepare the disableDelegation UserOp for the owner to sign.
         * @description Prepares a sponsored treasury UserOp executing disableDelegation. The response branches on the signature scheme: an EOA owner signs EIP-712 typed data (signing_payload); a pure-passkey account signs the userOpHash via WebAuthn (user_op_hash). Multi-signer accounts pick per request with signature_scheme. A row already disabled on-chain is healed to revoked and answered 409 instead of preparing a doomed op (#1423).
         */
        post: operations["prepareDelegationRevocation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegations/{hash}/revoke/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke step 2: submit the signed UserOp; the row flips only after it lands. */
        post: operations["submitDelegationRevocation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/rekey": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-key step 0: preflight — residual check, and open the re-key (#1698).
         * @description Opens an owner-authorised re-key: same agent identity, new delegate key, new API key, old authority revoked. Delegation rail only — a legacy AllowanceModule account is refused 409 with re-onboarding named as the path. An agent API key is refused 403: an agent can never re-key itself. new_delegate_address is the PUBLIC address of a keypair generated on the target machine; Haven never receives the private half. Preflight reads the residual balance on the OLD delegate EOA and refuses 409 on a non-zero one until residual_disposition says what happened to it, because sweeping needs the old key's signature and after the rotation that balance is unrecoverable. A failed balance read is 503 rather than a shrug.
         */
        post: operations["startAgentRekey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/rekey/{rekeyId}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-key step 1a: prepare the batched revoke of every live delegation (#1698).
         * @description Revoke comes FIRST, always. If the revoke lands and the issue does not, the agent has no authority — recoverable, and the correct posture when a key is lost. The reverse ordering would leave two simultaneously live keys. The response branches on the signature scheme, exactly as the per-hash and batch delegation revokes do: an EOA owner signs EIP-712 typed data (signing_payload); a passkey signs the userOpHash via WebAuthn (user_op_hash). A multi-signer account (EOA owner AND enrolled passkeys) picks per request with signature_scheme — without it the server would infer the owner path and estimate verification gas for a 65-byte signature the device may not be able to produce (#1870). An agent with no live delegations short-circuits: nothing to revoke, so the re-key advances straight to the metered stage — inheriting an abandoned predecessor’s frozen carry when one qualifies (#1868), otherwise with an empty carry.
         */
        post: operations["prepareRekeyRevocation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/rekey/{rekeyId}/revoke/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-key steps 1b + 2: land the revoke, THEN read the now-frozen meter (#1698).
         * @description Submits the owner-signed disableDelegation UserOp and, only once it has landed, reads each revoked delegation's remaining period budget and boundary into a frozen carry snapshot. The ordering is the point: reading before the revoke leaves a window in which a payment lands and the carried remainder over-counts it by that amount; after the revoke the on-chain state cannot move. It is safe because the revoke writes to the DelegationManager while the meter is read from the ERC20PeriodTransferEnforcer — two different contracts, and the read consults nothing the revoke writes. On a failed submit nothing is written and the old key is still live, so a retry is safe.
         */
        post: operations["submitRekeyRevocation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/rekey/{rekeyId}/issue": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-key step 3: build the carried delegations for the new delegate (#1698).
         * @description Refuses unless the re-key is at stage "metered" — which is only reachable through the revoke, so issue-before-revoke is forbidden structurally rather than by convention. Each replaced budget yields up to two grants: a "carry" capped at the frozen remainder and EXPIRING at the old period boundary, and a paired "steady" carrying the original budget and cadence starting at that same instant. The two never overlap, so no re-key can shorten a period or grant more than the original budget within one. Returns EIP-712 payloads for the owner to sign.
         */
        post: operations["issueRekeyDelegations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/rekey/{rekeyId}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-key steps 4 + 5: activate, rotate BOTH credentials, invalidate old-payer intents (#1698).
         * @description Activates every signed replacement delegation and, in the same transaction, swaps the agent's delegate address AND mints a new API key — one operation retires the whole old credential set, because a stale API key is its own hazard (#1681 finding A). Every unexecuted intent stamped with the old payer is expired in that same transaction; #1690's signer-side payer guard is a backstop, not the primary defence. The new API key is returned ONCE, to the authenticated owner.
         */
        post: operations["completeAgentRekey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/rekey/{rekeyId}/abandon": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record a stopped re-key, and say plainly if it left the agent without authority (#1698).
         * @description Recorded, not deleted: an abandoned re-key that got past the revoke left the agent with no authority, and the dashboard has to be able to say so rather than letting it read as a mysterious 403.
         */
        post: operations["abandonAgentRekey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegations/revoke-all": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch revoke step 1: ONE signature kills every non-revoked budget (#1400).
         * @description Bundles one disableDelegation call per pending/active delegation into a single sponsored UserOp (capped at 25 per batch; a coarser 100-row ceiling refuses before any reconciliation reads). Rows already disabled on-chain are healed to revoked and dropped from the batch first (#1423). Response shape matches the per-hash prepare, plus the delegation_hashes the batch will kill.
         */
        post: operations["prepareRevokeAllDelegations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/delegations/revoke-all/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Batch revoke step 2: submit the signed batch; rows flip only after the UserOp lands.
         * @description The response reports the hashes that actually flipped (scoped to this agent), never an echo of the request.
         */
        post: operations["submitRevokeAllDelegations"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/account-signers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the treasury account's signer set (public key material only).
         * @description The exact owner configuration the account address was derived from (#887) — the dashboard rebuilds the WebAuthn signer from this. Nothing secret: an address and P256 public-key coordinates.
         */
        get: operations["getAccountSigners"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/account-signers/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Prepare a signer-set change (enroll a backup, remove a key) for an EXISTING signer to sign.
         * @description Signer changes are ACCOUNT operations prepared here and signed by an existing signer — Haven prepares, never signs (#824). The chain's CannotRemoveLastSigner rule is mirrored as a clear 409 instead of an opaque revert; an informed two-to-one transition is permitted (#1199). Unlike the revocation prepares, this response carries no treasury_address.
         */
        post: operations["prepareSignerChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/account-signers/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit the signed signer-set change; storage syncs only after the on-chain op succeeds.
         * @description Body precedence is envelope first, config second: a malformed body is a 400 regardless of account state. The DB sync is pinned to the SIGNED calldata — a user_operation that does not match the signed action is refused.
         */
        post: operations["submitSignerChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/resources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the caller's registered resources, newest first.
         * @description Includes deactivated resources — active is a field, not a filter, so an owner can see what they took down. pay_to and challenge are null together when the linked Safe was detached.
         */
        get: operations["listX402Resources"];
        put?: never;
        /**
         * Register a resource behind an x402 payment wall.
         * @description Stores the resource and returns the 402 challenge a resource server embeds in its own responses. Price is ALWAYS atomic units (price_amount); price_human is derived for display only. Payment lands on the linked Safe — safe_id when given (ownership-checked), otherwise the user's default Safe; with neither, registration refuses rather than creating an unpayable resource.
         */
        post: operations["createX402Resource"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/resources/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Deactivate a resource (soft delete).
         * @description Sets active=false, scoped to the caller. The row is kept so existing receipts keep their resource, and the challenge endpoint answers 410 rather than 404 — a payer learns the resource retired, not that it never existed.
         */
        delete: operations["deactivateX402Resource"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/receipts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List payments verified against the caller's resources (max 100, newest first).
         * @description Receipts are written only by the verify endpoint, after on-chain verification. amount_human formats with the receipt token’s OWN decimals (#1630); a token this deployment does not recognise falls back to 6. amount_raw remains the authoritative field — amount_human is a display string.
         */
        get: operations["listX402Receipts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/resources/{id}/challenge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * PUBLIC: fetch a resource's 402 payment challenge.
         * @description No authentication — a challenge is public by construction, and it grants nothing: it states a price and a destination. NOTE THE SUCCESS CODE: this answers **402 Payment Required** with the challenge body, not 200, so a resource server can relay the status verbatim. 410 means the resource was deactivated; 503 means it has no payment address (its Safe was detached).
         */
        get: operations["getX402ResourceChallenge"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/resources/{id}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * PUBLIC: verify a transaction paid for this resource, and mint a receipt.
         * @description No authentication — verification reads the chain and the resource's own terms, so it grants the caller nothing they could not check themselves. The transaction must be an AllowanceModule transfer to the resource's Safe, in the resource's token, for at least its price. A tx_hash already used is a 409 (receipts are one-per-transaction, enforced before any RPC call). A failed verification is **402 with verified:false plus the expected terms** — a documented negative answer, not an error envelope.
         */
        post: operations["verifyX402Payment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/passport": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read an agent's passport state and its authoritative standing.
         * @description `passport: null` means the agent has none — the normal case for a basic agent, never an error (issuance is opt-in). The two fields answer different questions and are deliberately not collapsed into one badge: `standing` is the DATABASE's authoritative answer about the agent, while `passport.status`/the anchor describe how far the on-chain attestation has got. The chain lags; the database does not.
         */
        get: operations["getAgentPassport"];
        put?: never;
        /**
         * Opt an existing agent in to a passport.
         * @description Owner action, never agent-authenticated: an agent must not be able to issue itself a credential. Records the request synchronously and returns **202** — the EAS write is fire-and-forget, so poll the GET (or the public verifier) for the anchored state. Idempotent: an already-anchored passport returns **200** with `already_issued: true` rather than minting a second attestation. Refusals are shaped by whose problem it is — a revoked agent is a 409 (terminal, and anchoring now would spend gas on an attestation that must be revoked immediately), an account on a RETIRED rail is also a 409 (#2138: passports are issued on the delegation rail only, because a rail that cannot transact has no spending for a contract to govern), an unbound or unsupported chain is a 400, and a deployment that has not configured issuance is a 503, because that is the operator's gap and not the caller's mistake. The rail refusal is ordered AFTER the idempotency check, so a passport already anchored on a legacy account still returns 200 — existing passports are left alone rather than revoked. A PAUSED agent is deliberately not blocked: pausing is reversible and `standing` already reports it as suspended.
         */
        post: operations["requestAgentPassport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/passport/issuer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * PUBLIC: the issuer address a merchant pins to verify receipts offline.
         * @description Published so pinning is a one-time setup step rather than something a merchant extracts from a receipt it has not yet verified — trusting the issuer field of an unverified artifact is circular. Rate-limited.
         */
        get: operations["getPassportIssuer"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/passport/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * PUBLIC: fetch a signed governance receipt for an agent.
         * @description Unauthenticated by design — the caller is a merchant deciding whether to serve an agent; it has no Haven account and cannot be asked to get one. That makes the disclosure boundary the only protection, so the receipt carries booleans and public on-chain addresses and nothing else: no budget, no balance, no owner, and no Safe/treasury identifier beyond the spend accounts a merchant already needs in order to recognise the payer (the delegate EOA on an EIP-3009 header, the smart account in erc7710 redemption). Query by EXACTLY ONE of `address` or `uid`; both or neither is a 400. **An agent with no passport is 200 with `found: false`, not a 404** — issuance is opt-in so most agents have none, and an error status invites integrations to treat a lookup failure as a pass. Only passports already public on-chain resolve; a pending or failed one is indistinguishable from having none. Caching follows the same logic: a negative answer is `no-store` (today's no can be tomorrow's yes), a receipt is cacheable for half its TTL so an HTTP cache can never outlive the signed envelope.
         */
        get: operations["verifyPassport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/safes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List the Safes linked to the caller's account, oldest first. */
        get: operations["listUserSafes"];
        put?: never;
        /**
         * RETIRED — always answers 410. Importing a Safe is closed.
         * @description **RETIRED (#1984, epic #1440) — always answers 410 and writes nothing.** The Safe rail is being retired outright, and importing is one of the four ways a Safe could enter Haven; all four are closed. The refusal is a route preHandler, so it precedes every read and write. The route is kept as a compatibility tombstone rather than removed — a 410 tells an old client the flow is permanently gone, where a 404 reads as a transient routing error and invites retries (the #834 session-rail / #1328 mpp_demo pattern); the route itself goes in deletion slice #1988. Create a Haven account on the delegation rail instead (POST /accounts/hybrid). Existing linked Safes are unaffected: GET /user/safes, rename, re-default, unlink and every read path behave exactly as before. Historically this was registration only — it moved nothing on-chain and granted Haven no authority over the Safe.
         */
        post: operations["addUserSafe"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/safes/deploy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * RETIRED — always answers 410. Haven no longer deploys Safes.
         * @description **RETIRED (#1984, epic #1440) — always answers 410 and spends no relayer gas.** The refusal is a route preHandler, so it precedes the relayer entirely. Kept as a compatibility tombstone; removed in deletion slice #1988. Create a Haven account on the delegation rail instead (POST /accounts/hybrid). Historically the relayer sponsored the deployment and returned the deployed address plus the transaction hash, and owner_address was NOT checked against the caller — an unbounded-by-ownership relayer-gas surface that this retirement closes as a side effect.
         */
        post: operations["deployUserSafe"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/safes/{safeId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Rename a linked Safe.
         * @description Display metadata only — the name exists nowhere on-chain.
         */
        put: operations["renameUserSafe"];
        post?: never;
        /**
         * Unlink a Safe from the Haven account.
         * @description Removes the link and its Haven-side metadata. **The Safe itself is untouched on-chain** — the user still owns it and can re-link it later. Unlinking the default Safe promotes another one.
         */
        delete: operations["unlinkUserSafe"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/safes/{safeId}/default": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Make a linked Safe the default.
         * @description Exactly one Safe is default per user; setting one clears the previous.
         */
        put: operations["setDefaultUserSafe"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Rename the caller's own account.
         * @description Returns the FULL profile row (including currency_preference and created_at) — a wider shape than the wallet and safe writes below.
         */
        put: operations["updateUserProfile"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/wallet": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Record the caller's connected wallet address.
         * @description Bookkeeping only: recording an address grants Haven nothing and moves nothing. Returns the narrower five-field identity projection, not the full profile.
         */
        put: operations["updateUserWallet"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/safe": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * RETIRED — always answers 410. This link is an import.
         * @description **RETIRED (#1984, epic #1440) — always answers 410 and writes nothing.** This route wrote the legacy users.safe_address column AND linked the Safe into user_safes as the default, emitting the `safe_imported` funnel event: it is an IMPORT, so it retires with the rail. It is named here explicitly because no shipped client calls it, which is exactly what would have made it the hole left open. Kept as a compatibility tombstone; create a Haven account on the delegation rail instead (POST /accounts/hybrid).
         */
        put: operations["updateUserSafe"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the caller's display-currency preference.
         * @description Defaults to 'USD' when the account has never set one — a value, not an absence.
         */
        get: operations["getUserPreferences"];
        /**
         * Set the display-currency preference.
         * @description Display only — it changes no balance, no price and no settlement asset.
         */
        put: operations["updateUserPreferences"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/owners": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The owner directory across every linked Safe, with aliases.
         * @description Reads each linked Safe's owners LIVE from the chain and groups them by address, so one owner appearing on three accounts is one entry listing three. Aliases are looked up ONLY for the addresses just confirmed on-chain, which is what stops a removed owner's alias from reappearing. **A partial chain failure is reported, never hidden**: partialFailure/failedSafeIds name the Safes whose owners could not be read, so a caller can tell an incomplete directory from a complete one. Those two fields are camelCase, unlike the rest of this API — documented as-is rather than silently normalised.
         */
        get: operations["listUserOwners"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/user/owners/{ownerAddress}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Name an owner address.
         * @description An alias is a label, never a grant — naming an address confers no authority over any Safe. The address must be a CURRENT owner of a linked account, checked against the live directory: an unknown address is a 404, but if the chain read partially failed the answer is **503 rather than 404**, because 'not an owner' and 'could not check' must not look the same.
         */
        put: operations["setOwnerAlias"];
        post?: never;
        /**
         * Remove an owner's alias.
         * @description Drops the label only. Idempotent — removing an alias that does not exist still succeeds, and no ownership check is needed because no authority is involved either way.
         */
        delete: operations["deleteOwnerAlias"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Legacy SIE export — GATED OFF by default.
         * @description Superseded by the non-asserting reporting feed (#491): agent spend now syncs into the accounting tool as draft transactions instead of being exported as an asserting SIE file. **410 is the normal answer on a default deployment**; the route only serves when the legacy flag is on. Responds with a FILE, not JSON — Content-Disposition attachment, plus the custom headers X-Export-Entry-Count and X-Export-Skipped reporting how many entries were written and how many could not be.
         */
        get: operations["exportAccounting"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Surface the entries that cannot book cleanly over a period.
         * @description Read-only diagnosis, never a fix: it classifies each entry and counts the classes, so a user can see WHY a period will not balance before trying to book it. Note the camelCase byStatus/paymentId/txHash/settledAt fields — this report comes from the accounting module, not from SQL rows.
         */
        get: operations["reconcileAccounting"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/categories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's per-merchant BAS account overrides.
         * @description NOTE THE CASING: this read returns the SQL rows as-is (resource_url/bas_account, snake_case), while the write below echoes its own request fields (resourceUrl/account, camelCase). Same path, two conventions — documented rather than normalised, because a generated client must match what the routes actually emit.
         */
        get: operations["listAccountOverrides"];
        /**
         * Map a merchant to a BAS account.
         * @description Idempotent upsert keyed on (user, resourceUrl). A category is a bookkeeping label — it changes no payment and moves nothing. The response echoes the request fields in camelCase, unlike the snake_case read above.
         */
        put: operations["setAccountOverride"];
        post?: never;
        /**
         * Clear a merchant's BAS account override.
         * @description Answers **204 No Content**, not a success envelope. Idempotent: clearing an override that was never set still succeeds.
         */
        delete: operations["clearAccountOverride"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/reporting/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether the reporting feed is available, connected, and live — plus recent syncs.
         * @description Deliberately NOT gated, unlike the actions below: the page must be able to tell whether to render the full UI, an upsell, or nothing at all, and a 404 here would make "not entitled" indistinguishable from "broken". `liveSyncReady` false means sync is a preview that delivers nowhere — the provider adapter is not configured on this deployment. When the feed is unavailable the answer is a complete, honest shape with available:false and an empty syncs list, not an error.
         */
        get: operations["getReportingStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/reporting/sync": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Backfill and retry the feed for the caller.
         * @description Pushes what has not been pushed and retries what failed. Gated: **404 when the feed is unavailable**, which is how an unentitled caller sees it. Returns how many rows were fed — 0 is a normal answer, not a failure.
         */
        post: operations["syncReportingFeed"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/reporting/verify/{paymentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read back a pushed invoice from the provider's own records.
         * @description Strictly read-only (#1362): it confirms whether the supplier invoice still exists and whether a human has booked it, and asserts nothing — the non-asserting principle is untouched. A payment that was never pushed, a disconnected provider, or a sync row with no invoice reference all answer 409 with a machine-readable error_code, because none of them is a verification result.
         */
        get: operations["verifyReportingInvoice"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/reporting/reopen/{paymentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Reopen a pushed row for retry — only when the provider confirms the invoice is gone.
         * @description The ONLY path that flips a pushed row back to retryable, and it is conditional on the PROVIDER, not on the caller's say-so (#1365): the server re-runs the read-back and reopens only when the invoice is confirmed gone, or when a number collision proves the invoice at that number is not ours. **An invoice that still exists refuses with 409 and writes nothing** — that is the double-post guard, and reopening against a live invoice would duplicate it. A row that moved between the check and the flip (raced by a concurrent sync) also refuses rather than pretending. After a successful reopen, the next sync re-claims and re-pushes through the normal retry path.
         */
        post: operations["reopenReportingPush"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/fortnox/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Whether Fortnox is configured on this deployment and connected for the caller.
         * @description Returns SAFE METADATA ONLY: the granted scope and the token expiry, never the tokens themselves. Two shapes, deliberately: when the deployment has no Fortnox credentials the answer omits scope/expiresAt entirely (there is nothing to report), and when it is configured they are present but null until a connection exists. `legacyBookkeeping` tells the UI whether the asserting voucher-push surface below is reachable at all — off by default (#492).
         */
        get: operations["getFortnoxStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/fortnox/connect-url": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get the Fortnox consent URL as JSON.
         * @description The JSON twin of /connect, and it exists for a concrete reason: a single-page app cannot carry its Bearer token through a plain browser navigation, so it fetches the URL here and navigates itself. The URL embeds a signed `state` that expires in 10 minutes and carries a purpose claim — see the callback.
         */
        post: operations["getFortnoxConnectUrl"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/fortnox/connect": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Redirect the browser to Fortnox consent.
         * @description The redirect twin of /connect-url, for a navigation that can carry the session. Same signed, 10-minute, purpose-scoped state.
         */
        get: operations["startFortnoxConnect"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/fortnox/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * PUBLIC OAuth callback — authenticated by the signed state, not by a session.
         * @description Hit by a browser redirect from Fortnox, which carries no JWT. The caller is authenticated by the `state` this flow issued: it must verify, and it must carry the fortnox_oauth PURPOSE claim — an ordinary session token is rejected here, so a valid Haven token cannot be replayed as OAuth state. **Every outcome is a redirect, never JSON**, and every failure collapses to the same `?fortnox=error` regardless of cause: a bad state, a failed code exchange and a failed save are indistinguishable to the browser by design. A user-declined consent is reported separately as `?fortnox=denied` because that is the user's own action, not a failure to hide.
         */
        get: operations["fortnoxOAuthCallback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/fortnox": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Disconnect Fortnox for the caller.
         * @description Deletes the stored connection, tokens included. Answers **204 No Content** and returns no token material. Idempotent — disconnecting when nothing is connected still succeeds.
         */
        delete: operations["disconnectFortnox"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounting/fortnox/push": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Legacy asserting voucher push — GATED OFF by default.
         * @description The asserting counterpart to the reporting feed: it pushes FINISHED vouchers rather than drafts, which is exactly what #491/#492 moved away from. **410 is the normal answer on a default deployment.** When enabled, it reports per-entry outcomes rather than failing the batch: an entry with no book-time SEK amount is unbookable and counted as skipped, and a provider error is collected into failures with its payment id — so a partial push is visible as a partial push instead of an exception.
         */
        post: operations["pushFortnoxVouchers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/hybrid": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Provision a counterfactual Hybrid DeleGator account.
         * @description Computes the deterministic account address for an owner configuration (an EOA, P256 passkeys, or both) and records the row. **No transaction happens here** — the address is derived, not deployed, and `deployed: false` says so; the first sponsored operation (the budget grant) deploys the code. Refusals guard the derivation's own traps: the zero address is rejected because it derives the SAME account as the pure-passkey configuration while counting as a second signer, and duplicate passkey key_ids are rejected because they collapse to one on-chain key. A single-signer account is permitted (#1153) — the backup recommendation reaches the user after funding instead of walling the first minute.
         */
        post: operations["createHybridAccount"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/hybrid/{address}/signers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read an account's signer set (public key material only).
         * @description The account-scoped twin of the agent-scoped read, and it exists for two cases the agent route cannot serve: resolving a signer at LOGIN, before any agent exists, and giving account-level recovery a data source for an account with zero agents. Owner-scoped; nothing secret — an address and P256 public-key coordinates. The exact configuration the address was derived FROM, so a client can rebuild the same signer.
         */
        get: operations["getHybridAccountSigners"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/hybrid/{address}/signers/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Prepare a signer-set change for an EXISTING signer to sign.
         * @description Enroll a backup passkey or EOA, or remove one. Haven prepares; an existing signer signs — Haven never signs a signer change. The chain's own last-signer rule is mirrored as a clear 409 rather than an opaque revert. The response branches on the signature scheme the device can satisfy.
         */
        post: operations["prepareHybridSignerChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/hybrid/{address}/signers/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit the signed signer-set change.
         * @description Envelope first, account second — a malformed body is a 400 regardless of account state. Storage syncs only after the on-chain operation succeeds, and the sync is pinned to the SIGNED calldata: a user_operation that does not match the signed action is refused rather than trusted.
         */
        post: operations["submitHybridSignerChange"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/hybrid/{address}/transfers/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * MONEY PATH: prepare an owner-signed ERC-20 transfer from the account.
         * @description The rail's Send. The treasury executes the transfer as a sponsored account operation **the OWNER signs** — the same prepare/submit and calldata-pinning discipline as a signer change, and the same device-decides scheme. Haven constructs and relays; it never signs, so it cannot move these funds on its own. Works on a counterfactual account: deploy and transfer ride one sponsored operation. Rate-limited on the money-path limiter.
         */
        post: operations["prepareHybridTransfer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/accounts/hybrid/{address}/transfers/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * MONEY PATH: submit the owner-signed transfer.
         * @description Relays the signed operation. The calldata is pinned to what was signed, so the submitted transfer is the one the owner approved — a different recipient or amount is refused, not relayed. Rate-limited on the money-path limiter.
         */
        post: operations["submitHybridTransfer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/signup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an account and return a session token.
         * @description The email is NORMALISED before the uniqueness check, deliberately: an exact match on the raw input would let `ADA@Example.com` register alongside a stored `ada@example.com`, giving one person two accounts and two treasuries. Password bounds are 8-128 characters. The returned user is a fixed new-account shape — no wallet, no Safe, USD, an empty safes list — because none of those exist yet. **The 409 for a taken address is a deliberate, ACCEPTED disclosure (#1654):** one unauthenticated request tells the caller whether an email has a Haven account, which is stronger than the oracle #1646 closed on login. It stands because telling a returning user "you already have an account — sign in instead" is real product value, and because the standard mitigation is structurally unavailable here: a 201 carries the SESSION TOKEN, so answering 201 for a taken address would either mint a token for someone else's account or return a token-less 201 that is an equally strong oracle — genuine hardening needs an email-verification channel this API does not have. Bulk probing is additionally rate limited (#1670) — 10 requests/minute per client address, in deployments where TRUST_PROXY_HOPS is set so per-IP means the CLIENT rather than one shared proxy bucket; the tier deliberately disarms itself otherwise, since a shared-bucket limit on the front door is a denial-of-service, not a protection. Throttled is not closed: one request against one address still answers definitively, which is what the acceptance above is about. If an email channel is ever added, revisit this tradeoff in the same change. Timing is not equalised on this route because the status already discloses account existence — the clock has nothing to add beyond what the 409 already says.
         */
        post: operations["signup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Exchange credentials for a session token.
         * @description **An unknown email and a wrong password return the SAME 401**, deliberately: distinguishing them would turn this endpoint into an account-enumeration oracle, letting anyone discover which addresses have Haven accounts. Do not make the error message more helpful. The protection covers timing as well as the status and body (#1646): the password comparison runs on BOTH paths — against an absent-user hash when there is no account — so the answer costs materially the same either way (the remaining difference is the sub-millisecond indexed lookup, far below bcrypt cost). The token is valid for 7 days, and the response carries the user's Safes so a client needs no second call to render a session.
         */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the authenticated session: profile plus Safes.
         * @description Both reads are scoped to the JWT subject, never to a client-supplied id. Returns the FULL profile row (including created_at, unlike the login and signup user object) plus the same Safe list. A 404 here means the account was deleted while a valid token for it was still in flight.
         */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/passkeys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the caller's enrolled passkeys.
         * @description Wider than the create response: it also carries the bound Safe address and the enrollment time. Still no key material.
         */
        get: operations["listPasskeys"];
        put?: never;
        /**
         * Enroll a passkey signer for the caller.
         * @description Derives the Safe passkey-signer address from the P256 public key and records it. **A second passkey on the same chain is allowed and is the point** (#1229): it is a BACKUP SIGNER, and this rail's only recovery — refusing it used to lock out exactly the users who most needed protection. Only a duplicate credential_id is refused. HONEST LIMITATION: the attestation object is persisted for future verification but is NOT cryptographically verified yet, so a bad enrollment harms only the enrolling user. The response is NARROWER than the list read below — an id, the credential, the derived signer address and the chain, never the public-key coordinates or the stored attestation.
         */
        post: operations["registerPasskey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-activity/{id}/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One agent's payments, approvals and tool calls, newest first.
         * @description A heterogeneous list discriminated by `type`: payment, approval, or mcp_tool_call. **Read the pagination carefully — it is approximate by construction.** `limit` is applied to EACH of the three sources separately and the results are then merged and sorted, so this route can return up to three times `limit` entries, and `offset` walks each source independently rather than the merged sequence. (The combined feed below merges the same way but then truncates to `limit`, so the two routes do NOT paginate identically.) Treat the list as a recent-activity window, not as a stable paged sequence.
         */
        get: operations["getAgentActivity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-activity/{id}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * One agent's spend totals per token, plus its pending-approval count.
         * @description Totals count CONFIRMED spend only, so an in-flight payment does not inflate them. Each window (all time, today, this week) is a separate per-token list rather than one list with three numbers, because a token can appear in one window and not another.
         */
        get: operations["getAgentStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-activity/feed": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Combined activity across every agent the caller owns.
         * @description The same three entry types as the per-agent list, each additionally carrying agent_id and agent_name so the feed can attribute a row without a second lookup ('Unknown' when the agent row is gone — the activity stays visible). Unlike the per-agent route, the merged list IS truncated to `limit`. A caller with no agents gets an empty list and a zero count rather than an error. `pending_approvals` is always 0 since #2055 (the approval queue died with the Safe rail); the field survives for wire compatibility.
         */
        get: operations["getActivityFeed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/analytics/funnel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Onboarding step conversion and median time-to-first-payment.
         * @description Counts DISTINCT users per onboarding step over a date range, with the conversion from the previous step, plus the median time from signup to first settled payment. Defaults to the last 30 days. The window is echoed back as resolved ISO timestamps so a caller can tell exactly which range produced the numbers rather than re-deriving the default.
         */
        get: operations["getOnboardingFunnel"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chains": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * PUBLIC: which chains this deployment serves.
         * @description Two different lists, and the difference matters: `supported` is every chain the code knows, while `deployable` is the subset this environment will actually provision accounts on (#679). Onboarding pickers must offer `deployable`, not `supported`, or they will offer a chain the deployment refuses. No authentication — it is configuration, not data.
         */
        get: operations["getChains"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/{id}/settle": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * MONEY PATH: settle a delegation-rail x402 payment with the delegate signature.
         * @description The delegation rail's settlement step, and the reason the rail has no funding leg: the agent signs the settlement child delegation, Haven assembles the merchant X-PAYMENT header, and the merchant redeems the chain directly from the budget delegation — **money moves account→merchant, never through a delegate hot balance**. Retry the merchant with the returned `payment_header`; it is a signed, single-use, amount-and-merchant-bound authorization, not a key. Refusals are specific on purpose: a payment on the wrong rail is a 409 rather than a confusing 400, and a lost settlement context is a 502 telling you to re-authorize rather than a silent failure. Agent-authenticated and rate-limited on the money-path limiter.
         */
        post: operations["settleX402Payment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Pause an agent — reversible, unlike revoke.
         * @description Pausing stops Haven serving the agent while leaving its on-chain authority intact; revoking is the terminal action. A paused agent's standing reports as suspended rather than revoked.
         */
        post: operations["pauseAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Resume a paused agent. */
        post: operations["resumeAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/rotate-key": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue a new API key for an active agent.
         * @description **The plaintext key is returned ONCE, here, and is never retrievable again** — Haven stores only its hash. Rotation invalidates the previous key immediately, so a running agent must be given the new one before its next call. Only an ACTIVE agent can rotate: a revoked agent stays revoked (409), because handing out a fresh credential for it would undo the revocation.
         */
        post: operations["rotateAgentKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/allowances": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * RETIRED (410): per-token allowances died with the Safe rail.
         * @description Retired with the Safe rail (#1440/#2020). Always answers 410 and writes nothing — spend authority on the delegation rail is a signed budget delegation (`POST /agents/{id}/delegations/prepare` → activate), never a per-token allowance row. The typed operation stays as a tombstone so older clients get a stable, explicit answer rather than a 404.
         */
        post: operations["setAgentAllowance"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{id}/allowances/{tokenAddress}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * RETIRED (410): per-token allowances died with the Safe rail.
         * @description Retired with the Safe rail (#1440/#2020). Always answers 410 and deletes nothing (a malformed token address still gets its 400). Revoke or change the agent’s budget delegation instead.
         */
        delete: operations["deleteAgentAllowance"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/transactions/payment-intents/{paymentId}/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Read the stored evidence for one payment or approval.
         * @description The audit view behind a transaction row. `payment_id` is resolved for the caller — it carries whichever of the two source ids exists, so a client does not branch on payment-versus-approval to find its own identifier.
         */
        get: operations["getPaymentEvidence"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a pending Connect Agent 2 setup.
         * @description Creates setup metadata and a short-lived setup token before any agent signing address exists. Haven stores only a setup-token hash and never receives an agent private key.
         */
        post: operations["createAgentConnectionSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Resolve setup details for the local connector.
         * @description Uses the setup token from the request body to return public setup context and an exact challenge message. The response contains no API key or private key material.
         */
        post: operations["resolveAgentConnectionSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Register a locally generated public signing address.
         * @description The local connector signs the Haven challenge with its locally generated key and sends only the public signing address, proof, and locally generated API-key hash. Haven creates a non-active pending agent and never receives the private key or plaintext API key.
         */
        post: operations["registerAgentConnectionSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/{setupId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Read pending setup status for the signed-in user. */
        get: operations["getAgentConnectionSetup"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/{setupId}/install-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report local connector install readiness.
         * @description Updates best-effort local install/probe metadata only. A setup token may be used only before registration and before expiry; after registration the connector uses the pending agent API key. This endpoint cannot change signing address, wallet, allowances, approval status, or payment authority.
         */
        post: operations["updateAgentConnectionInstallStatus"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/{setupId}/connector-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Narrow post-register status read for the local connector.
         * @description Lets the connector wait for the user's budget approval after registering (#1377). Authenticated with the pending agent API key — deliberately usable while the key is still setup_pending-scoped. Read-only and narrow by design: it reveals only the setup status plus, once active, the approved budget summary; it grants no payment authority and returns 404 for setups not owned by the presented key.
         */
        get: operations["getAgentConnectionConnectorStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/{setupId}/wallet-approval": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record wallet approval evidence for Connect Agent 2.
         * @description Records user wallet approval or a Safe multisig proposal for a locally connected setup. Confirmed approvals activate the pending agent only after Haven verifies the live on-chain allowance state for the exact Haven wallet, public signing address, token budgets, and reset periods. Proposed approvals remain non-active until that on-chain authority is live.
         */
        post: operations["recordAgentConnectionWalletApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/{setupId}/budget-approval": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Complete a delegation-rail Connect Agent 2 setup.
         * @description The delegation rail's counterpart to wallet-approval. Activates the pending agent only after Haven confirms that every budget this setup promised exists as an active, owner-signed budget on the agent — the caller asserts nothing, so the request body is empty and the call is safe to retry. Rejected with 409 on a Safe / AllowanceModule wallet, which approves with a wallet transaction instead.
         */
        post: operations["recordAgentConnectionBudgetApproval"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agent-connection-setups/{setupId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cancel a pending Connect Agent 2 setup.
         * @description Cancels setup state and revokes the pending agent API key when no on-chain authority has been activated. Active agents must be paused or revoked through normal agent controls.
         */
        post: operations["cancelAgentConnectionSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List recent payment intents for the authenticated agent. */
        get: operations["listAgentPayments"];
        put?: never;
        /**
         * Create a direct Haven payment intent.
         * @description Creates a signable payment intent on the delegation rail. The agent must sign the returned sign_data with its delegate key before Haven can relay execution; the budget delegation's caveat enforcers authorize it on-chain at redemption. #2105: there is no over-budget approval branch — an over-budget payment REVERTS during gas estimation rather than queuing, and the approval queue died with the Safe rail (#2055). Both retired rails are refused with 410 before anything is written.
         */
        post: operations["createPaymentIntent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payments/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch direct payment intent status. */
        get: operations["getPaymentIntent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payments/{id}/sign": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit a delegate signature and relay a payment intent.
         * @description The signature must be produced outside Haven by the agent-held delegate key. #2105 (found by review): Haven does NOT verify it against the delegate address or an on-chain allowance, as this said — that was the retired AllowanceModule scheme (`sign_hash` + raw-ECDSA `recoverSigner`), which died with the rail (#1986). Haven now applies a SHAPE check only and relays; the real validator is the account itself (EIP-1271 / the 4337 signature check on the typed data) and the budget delegation's caveat enforcers on redemption. An intent pinned to a retired rail is refused 410 here rather than relayed.
         */
        post: operations["submitPaymentSignature"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payments/{id}/receipt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch a verifiable receipt for a settled payment.
         * @description Returns a self-contained proof bundle (payment facts, the delegate authorization signature, and the on-chain tx) plus a self-verification. The bundle is verifiable independently of Haven by recovering the signer from the authorization and confirming it is the agent delegate.
         */
        get: operations["getPaymentReceipt"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/payments/{id}/resume_state": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Rehydrate x402 or MPP resume state for a payment id.
         * @description Returns stored protocol context only. This endpoint does not sign, execute, relay, or authorize a payment. The agent still signs locally when it resumes the x402 or MPP flow.
         */
        get: operations["getPaymentResumeState"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Authorize an x402 funding payment.
         * @description Creates or executes the Haven side of an x402 merchant request. Haven relays only independently signed payloads; it does not sign on behalf of the agent. The scheme follows the payTo shape: a merchant payTo builds an erc7710 settlement child delegation and settles account→merchant directly with NO funding leg; the EIP-3009 bridge (agent-EOA payTo + merchantPayTo) is the fallback and is the only shape that still funds anything. #2105: there is no approval branch — spend authority is the agent's budget delegation, refused up front with 403 when the amount exceeds the live remaining budget (#2082) and enforced on-chain by the caveat enforcers at redemption. Preserve the original merchant session and resume once next_action is retry_original_x402_request.
         */
        post: operations["authorizeX402Payment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/{id}/sign-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch the exact signing payload for a pending delegation-rail x402 intent.
         * @description Read-only byte-free signing handoff (#1263): re-serves the stored delegation-rail signing payload (sign_data.typed_data) plus a freshly Haven-signed expected context committing to its digest, so a LOCAL SIGNER can fetch exact bytes by payment_id instead of an agent re-emitting them. Constructs and signs nothing new; the signer re-derives the digest and verifies the binding exactly as against an authorize response.
         */
        get: operations["getX402SignContext"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402/{id}/merchant-call-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch the stored MCP merchant-call context for an x402 intent.
         * @description Read-only settle-leg handoff (#1307): re-serves the merchant_url, tool_name, arguments, and mcp_transport recorded on the intent at quote time (haven_pay_mcp_tool), so haven_settle_mcp_tool / haven_complete_mcp_tool can omit them and let Haven rehydrate by payment_id instead of the caller re-threading them. Convenience metadata for retrying the MERCHANT's own call — never payment authority.
         */
        get: operations["getX402MerchantCallContext"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/x402": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Legacy alias for POST /x402/authorize.
         * @deprecated
         */
        post: operations["authorizeX402PaymentLegacy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/agent": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch the authenticated agent identity. */
        get: operations["getMachinePaymentAgent"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/allowances": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Fetch live spend-authority state for the authenticated agent.
         * @description Rail-aware (#1135): on the delegation rail the response carries the ACTIVE budget delegations (remaining = the period budget; AllowanceModule-only fields are zeroed placeholders). BOTH retired rails answer 410 — the session rail (#993) and, since #2020 reversed #1986’s left-readable decision, the Safe/AllowanceModule rail too. Reporting only — enforcement stays on-chain.
         */
        get: operations["getMachinePaymentAllowances"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/authorize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Retired: the legacy MPP demo machine-payment authorize flow (#1328).
         * @description The internal mpp_demo flow is retired outright — this endpoint now refuses unconditionally with HTTP 410, fail-closed, before the body is inspected (mirrors the #834 session-rail retirement pattern). DELIBERATE EXCEPTION (review decision on #1339): the route is retained as a compatibility tombstone rather than removed — a 410 tells an old client the flow is permanently gone, where a 404 reads as a transient routing error and invites retries. No new mpp_demo challenge can be authorized. Use the x402 merchant flow instead (POST /x402/authorize). Existing mpp_demo payment/receipt/evidence/status records remain readable through the other /machine-payments/* endpoints.
         */
        post: operations["authorizeMachinePayment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/{id}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch x402 or MPP payment/approval state. */
        get: operations["getMachinePaymentStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/send": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * RETIRED: plain transfer. Validates the body, then always refuses.
         * @description RETIRED (#1987, epic #1440). This route belonged to the Safe / AllowanceModule rail and no longer has a success path: `modules/mpp/send.ts` is three refusals and nothing else. After body validation (400) the account's rail decides which refusal you get — **410** on either retired rail (Safe / AllowanceModule, #1986; session, #834) and **422** `rail_not_supported` on the delegation rail, which MPP never supported (#1251). Those three cases exhaust the HANDLER, so 2xx is unreachable here; the route in front of it can still answer 400, 401, 403 or 429. Fail-closed: no intent row, no approval row, no sign_data, no chain read. To send from a delegation-rail account use POST /payments, which redeems the agent's budget delegation directly. The operation stays documented rather than deleted because it is still registered and still answers — an integrator needs the refusal contract, not a 404.
         */
        post: operations["sendTransfer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/receipts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List stored machine-payment receipts for the authenticated agent. */
        get: operations["listMachinePaymentReceipts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/evidence": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Attach merchant proof evidence for a settled machine payment.
         * @description Records proof-loop evidence for a settled x402 or MPP payment owned by the authenticated agent. This does not authorize or execute payment. On most schemes the payment is already confirmed and this only attaches merchant/protocol evidence. On erc7710 direct settlement the merchant redeems the delegation chain and Haven submits nothing, so this call is also what COMPLETES the payment: it verifies the reported txHash on-chain against the intent (token, payer, merchant, exact amount, and the settlement window) and confirms the intent before recording evidence. It fails closed — 409 when the transaction does not settle this payment or cannot be attributed to it unambiguously, 503 when the chain could not be read or the transaction is not mined yet; neither confirms anything.
         */
        post: operations["attachMachinePaymentEvidence"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/{id}/merchant-receipt": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report the merchant's own receipt for a settled payment.
         * @description Captures the receipt document the merchant handed back in the paid response (invoice number, VAT breakdown — facts Haven's own payment evidence cannot assert). The reporting feed attaches it verbatim next to the Haven-generated evidence document. Best-effort and idempotent: absence is the normal case, the first report wins, and nothing here affects the payment itself. Provide either `url` (https, fetched at feed time under strict guards) or `json` (the inline receipt document, max 64KB).
         */
        post: operations["reportMerchantReceipt"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/reconciliation-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Record a merchant retry reconciliation event.
         * @description Records a post-payment reconciliation marker when the merchant/protocol retry rejects or needs follow-up after a confirmed payment. The event is audit context only; it does not move funds.
         */
        post: operations["recordMachinePaymentReconciliationEvent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/sweep/prepare": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Prepare a gasless USDC sweep from the delegate wallet to the Safe.
         * @description Reads the delegate EOA's stranded USDC and returns an EIP-3009 TransferWithAuthorization (delegate → the agent's own Safe) plus Haven's authorization binding. The edge signer signs the authorization with haven_sign_sweep_delegate; POST /machine-payments/sweep/submit relays it. The delegate never needs ETH and Haven never holds the key. Returns { nothing_stranded: true } when the delegate is empty.
         */
        post: operations["prepareDelegateSweep"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/machine-payments/sweep/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Relay a delegate-signed gasless USDC sweep.
         * @description Submits the delegate-signed EIP-3009 authorization from /machine-payments/sweep/prepare. Haven's relayer pays gas; the relayer is never a spender. The authorization is re-derived from server state, the delegate signature is verified, and the balance is re-read before relaying.
         */
        post: operations["submitDelegateSweep"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/transactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List wallet transactions for the signed-in user. */
        get: operations["listTransactions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/transactions/filters": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Filter metadata (safes, agents, tokens) for the transactions view. */
        get: operations["getTransactionFilterOptions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/transactions/{safeAddress}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Page-based transaction list for one Safe. */
        get: operations["listSafeTransactions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/dashboard/overview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Aggregated dashboard overview: totals, day change, metrics, previews. */
        get: operations["getDashboardOverview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/balances/{safeAddress}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Token balances for one Safe. */
        get: operations["getSafeBalances"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/portfolio/{safeAddress}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fiat-valued portfolio breakdown for one Safe. */
        get: operations["getSafePortfolio"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/safe/{safeAddress}/details": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** On-chain Safe details: owners, threshold, nonce. */
        get: operations["getSafeDetails"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/contacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List the user's saved address-book entries.
         * @description Dashboard address book: a name for an address, scoped to the user. Naming an address changes nothing on-chain and grants no authority — it is presentation only, so a transfer to a named contact is exactly as constrained as a transfer to a raw address.
         */
        get: operations["listContacts"];
        put?: never;
        /**
         * Save a new address-book entry.
         * @description The address must be a valid EVM address and unique per user — a second entry for the same address is a 409, not a silent overwrite, so an existing name is never replaced by accident.
         */
        post: operations["createContact"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/contacts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Rename an address-book entry.
         * @description Only the name is mutable; an address is never re-pointed under an existing name. To point a name at a different address, delete and re-create.
         */
        put: operations["renameContact"];
        post?: never;
        /**
         * Delete an address-book entry.
         * @description Hard delete of a label, not of history: transactions to that address remain, and simply stop rendering a name. A contact belonging to another user is a 404, never a 403 — the route does not confirm that an id exists.
         */
        delete: operations["deleteContact"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List curated payable services agents can discover and pay.
         * @description Read-only discovery surface. One source of truth consumed by both the dashboard catalog page and the haven_discover_tools MCP tool. Entries are operator-curated and periodically re-verified against the live merchant 402 challenge; category matching is case-insensitive and search matches product name, description, or category. Blank search is rejected after trimming and non-empty search is capped at 120 characters; nothing here creates payments or signatures. **What `active` means, exactly (#1669):** verification exercises the 402 CHALLENGE only, so `active` says the merchant answers — it cannot say the merchant settles. One deliberate consequence is in the catalog on purpose: entries with `category: 'test-fixture'` simulate failure modes (today, a stranded-funds simulator whose funding leg succeeds but which never settles); their name and description say so plainly, and clients that pre-filter should treat the category as the structural signal.
         */
        get: operations["listCatalog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog/submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit a payable (x402/MCP) endpoint for verification and listing.
         * @description Public, unauthenticated self-service submission (epic #1717). Writes a queue row only and returns a `verify_token`; the request path makes **no outbound request of any kind** — nothing here probes, signs, or pays. The seller proves domain control (well-known token / DNS TXT) and a leader-locked, SSRF-hardened, read-only probe watches a real 402 challenge before anything is listed; listed means domain-controlled AND verified-payable, and verification exercises the 402 challenge only, never settlement. Submitting a host that already has a pending/active submission is a no-op returning the same id. A flood is bound by a per-IP rate limit and a capped pending queue (429), and the request body is capped at 8 KB (413). `resource_url` must be https and must NOT carry embedded credentials (`https://user:pass@host/`) — those are refused (400) rather than stored, so nothing downstream can replay them. A queued row is inert: it confers no listing and no standing until domain control and a live 402 challenge have both been observed. Money-path: none; no payment, signature, or authority change.
         */
        post: operations["submitCatalogEntry"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog/submit/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Public status of a catalogue submission (#1715).
         * @description Coarse current state plus, while the domain-ownership proof is still valid, the exact well-known / DNS-TXT proof instructions. Deliberately minimal: the `verify_token` is never returned (it is a credential minted once at creation), and failures surface only as the coarse `failed` status — the granular SSRF/ownership reasons stay in server logs so this cannot become an internal-DNS oracle. 404 for an unknown id.
         */
        get: operations["getCatalogSubmissionStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/catalog/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fetch one catalog entry. */
        get: operations["getCatalogEntry"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
};
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        /** @description A hybrid account's signer set — the exact configuration the account address was derived from. Public key material plus per-credential enrollment time (#1679); nothing secret. */
        HybridAccountSigners: {
            account_address: string;
            chain_id: number;
            /** @description Null for a pure-passkey account. */
            owner_address: string | null;
            passkeys: {
                key_id: string;
                x: string;
                y: string;
                /**
                 * Format: date-time
                 * @description When this credential was enrolled (#1679) — the UI labels the row "Passkey · added {date}". Null only if the stored row is missing; clients fall back to ordinal "Passkey N" labels, never a platform name.
                 */
                created_at: string | null;
            }[];
        };
        /** @description One budget-delegation row (#828). start_date and expires_at are unix-second BIGINTs and arrive as digit STRINGS (node-postgres decodes int8 as string). The signed delegation object is never included here — the list is lifecycle metadata only. */
        Delegation: {
            /** Format: uuid */
            id: string;
            chain_id: number;
            /** @description Stored lowercase (table CHECK). */
            token_address: string;
            /** @description Lowercase recipient pin, or null for an open budget. */
            recipient_address: string | null;
            delegation_hash: string;
            version: number;
            /** @enum {string} */
            status: "pending" | "active" | "replaced" | "revoked";
            budget_atomic: string;
            period_seconds: number;
            /** @description Unix seconds as a string (BIGINT). */
            start_date: string;
            /** @description Unix seconds as a string (BIGINT). */
            expires_at: string;
            /** Format: date-time */
            created_at: string;
        };
        Contact: {
            /** Format: uuid */
            id: string;
            name: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            address: string;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        CatalogEntry: {
            /** Format: uuid */
            id: string;
            name: string;
            description: string;
            category: string;
            resource_url: string;
            /** @enum {string} */
            rail: "x402" | "mpp";
            /** @enum {string} */
            protocol: "http" | "mcp";
            tool_name: string | null;
            /** @description Suggested MCP tool arguments for this catalog item, when the row represents a specific product variant. Agents should pass this object unchanged to the pay tool arguments field after confirming the live merchant quote. */
            tool_arguments: {
                [key: string]: unknown;
            } | null;
            price_display: string | null;
            price_atomic: string | null;
            asset: string | null;
            network: string | null;
            /** @description Comma-separated set of x402 assetTransferMethods the merchant advertises (e.g. "eip3009" or "eip3009,erc7710"). Null until the first successful x402 probe; MPP entries stay null. */
            asset_transfer_methods: string | null;
            /** @enum {string} */
            status: "active" | "degraded" | "delisted";
            verified_at: string | null;
            /**
             * @description Where the entry came from. `operator` = curated in migrations/scripts (the operator vouches; no verification badges). `ingestion` = self-submitted through the Verified Payable Directory (epic #1717) and passed domain-ownership proof plus the read-only quote probe.
             * @enum {string}
             */
            source: "operator" | "ingestion";
            /** @description True only for `ingestion` entries whose seller proved control of the endpoint domain. Always false for operator-curated rows, which have a different (operator) trust story. */
            domain_verified: boolean;
            /** @description True only for `ingestion` entries that a leader-locked, SSRF-hardened, read-only probe watched answer a real x402 quote. The badge claims domain-control AND verified-payable — never merchant honesty, quality, or settlement reliability. */
            verified_payable: boolean;
        };
        CatalogSubmitRequest: {
            /** @description https URL of the payable x402/MCP endpoint the seller wants verified and listed. This endpoint makes no request to it: the submission is queue-only, and ownership proof plus the verification probe run later, asynchronously under the leader-locked catalog monitor. */
            resource_url: string;
            /** @description Honeypot. Bots that fill this plausible-looking field are dropped with a fake success and nothing is written; human submitters leave it empty. */
            website?: string;
        };
        CatalogSubmissionAccepted: {
            /** Format: uuid */
            id: string;
            /** @description Domain-ownership proof token. The seller proves control of the endpoint domain by serving the expected value at https://<host>/.well-known/haven-verify-<token>.txt (DNS TXT supported as fallback). Verification, and any public listing, waits for that proof; `submitted` alone guarantees nothing. PRESENT ONLY on the response to the request that created the submission — it is a credential minted for that one submitter. A request that de-duplicates onto an existing pending submission gets `id` and `status` only, so naming a hostname can never disclose another party's token. */
            verify_token?: string;
            /** @enum {string} */
            status: "submitted" | "ownership_verified" | "verified_payable";
        };
        CatalogOwnershipInstructions: {
            /** Format: date-time */
            expires_at: string;
            well_known: {
                url: string;
                content: string;
                instruction: string;
            };
            dns_txt: {
                name: string;
                value: string;
                instruction: string;
            };
        };
        CatalogSubmissionStatus: {
            /** Format: uuid */
            id: string;
            /** @enum {string} */
            status: "submitted" | "ownership_verified" | "verified_payable" | "failed" | "delisted";
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
            last_verified_at: string | null;
            name: string | null;
            description: string | null;
            entrypoint: string | null;
            /** @description Present while the submission can still prove ownership (submitted / ownership_verified) and the deployment has CATALOG_OWNERSHIP_SECRET set. Absent once verified_payable, failed or delisted — the proof is no longer actionable. */
            instructions?: components["schemas"]["CatalogOwnershipInstructions"] | null;
        };
        /**
         * @description Stable Haven agent payment state phase.
         * @enum {string}
         */
        AgentPaymentPhase: "agent_signature_required" | "payment_submitted" | "payment_confirmed" | "user_approval_required" | "user_execution_required" | "waiting_for_additional_approvals" | "funding_sent" | "rejected" | "expired" | "failed" | "insufficient_funds" | "funded_but_unsettled";
        /**
         * @description Stable next action an agent should take for a Haven payment state.
         * @enum {string}
         */
        AgentPaymentNextAction: "sign_and_submit_payment" | "check_status_later" | "none" | "wait_for_user_approval" | "wait_for_user_to_complete_payment" | "retry_original_x402_request" | "stop_and_tell_user" | "request_again_if_user_still_wants_it" | "retry_with_explicit_context" | "payment_window_expired" | "fund_safe_or_raise_allowance" | "sweep_stranded_funds";
        /**
         * @description Stable rail identifier for Haven agent payment states.
         * @enum {string}
         */
        AgentPaymentRail: "direct" | "x402" | "mpp" | "mpp_demo" | "mpp_crypto" | "stripe_deposit" | "spt";
        HealthResponse: {
            /** @enum {string} */
            status: "ok" | "degraded";
            /** Format: date-time */
            timestamp: string;
            db: {
                /** @enum {string} */
                status: "ok" | "error";
                latencyMs?: number;
                error?: string;
            };
            /** @description Cached per-chain relayer gas balance from the hourly scan. Never a live RPC read. */
            relayer?: {
                chainId: number;
                /** @example 0x1111111111111111111111111111111111111111 */
                address: string;
                balanceWei: string;
                low: boolean;
                /** Format: date-time */
                checkedAt: string;
            }[];
            /** @description L0 Agent Passport configuration state (#1151). Booleans plus the published issuer address only — never key material, never the schema UID. A chain in `issuance_only` anchors passports no merchant can verify. */
            passport?: {
                verification: {
                    configured: boolean;
                    issuer: string | null;
                };
                chains: {
                    chainId: number;
                    issuanceConfigured: boolean;
                    verificationConfigured: boolean;
                    /** @enum {string} */
                    state: "ready" | "issuance_only" | "verification_only" | "unconfigured";
                }[];
                unverifiableChainIds: number[];
            };
            /** @description Trust-proxy state (#1670): the hop count the process actually read, and whether the per-IP auth rate-limit tier is therefore armed. Exists because the armed/disarmed split is otherwise invisible from outside — the tier deliberately returns NO limit when the proxy is untrusted, which a probe cannot tell apart from a variable the process never saw. */
            trustProxy?: {
                hops: number;
                authRateLimitArmed: boolean;
            };
        };
        SuccessResponse: {
            success: boolean;
        };
        /**
         * @description Connect Agent 2 setup state. Pending/proposed states are not payment authority.
         * @enum {string}
         */
        AgentConnectionSetupState: "awaiting_connection" | "connected_local" | "awaiting_wallet_approval" | "approval_in_progress" | "proposed" | "active" | "expired" | "cancelled" | "failed";
        AgentConnectionAllowanceInput: {
            /** @example 0x1111111111111111111111111111111111111111 */
            token_address: string;
            token_symbol: string;
            /** @description Decimal atomic token amount. Leading zeroes are accepted and canonicalized; effective amount must be positive and capped at uint96 — the word size of the delegation rail's ERC20PeriodTransferEnforcer. */
            allowance_amount: string;
            reset_period_min: number;
        };
        AgentConnectionAllowance: components["schemas"]["AgentConnectionAllowanceInput"] & {
            /** Format: uuid */
            id?: string;
        };
        AgentConnectionWallet: {
            /** Format: uuid */
            id: string;
            name: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            address: string;
            chain_id: number;
            network: string;
        };
        AgentConnectionConnector: {
            connector_version?: string | null;
            environment_label?: string;
            runtime_version?: string;
            config_target?: string;
        };
        AgentConnectionInstallStatus: {
            runtime?: string;
            runtime_mcp_mode?: string;
            connector_version?: string;
            hosted_mcp_configured?: boolean;
            local_signer_configured?: boolean;
            local_mcp_configured?: boolean;
            credential_files_written?: boolean;
            signer_acknowledged?: boolean;
            local_mcp_acknowledged?: boolean;
            activation_command_available?: boolean;
            skill_installed?: boolean;
            probe_result?: string;
            restart_required?: boolean;
            next_user_action?: string;
            error_code?: string | null;
            environment_label?: string;
            last_probe_at?: string;
        };
        CreateAgentConnectionSetupRequest: {
            name: string;
            description?: string;
            /** Format: uuid */
            safe_id?: string;
            runtime?: string;
            allowances?: components["schemas"]["AgentConnectionAllowanceInput"][];
            /** @description Opt in to an L0 Agent Passport for the agent this setup creates. Default false. */
            issue_passport?: boolean;
        };
        CreateAgentConnectionSetupResponse: {
            /** Format: uuid */
            setup_id: string;
            status: components["schemas"]["AgentConnectionSetupState"];
            setup_token: string;
            /** Format: date-time */
            expires_at: string;
            connector_command: string;
            setup_prompt: string;
        };
        ResolveAgentConnectionSetupRequest: {
            setup_token: string;
            connector_version?: string;
            runtime?: string;
        };
        ResolveAgentConnectionSetupResponse: {
            /** Format: uuid */
            setup_id: string;
            status: components["schemas"]["AgentConnectionSetupState"];
            agent: {
                name: string;
                description?: string | null;
            };
            haven_wallet: components["schemas"]["AgentConnectionWallet"];
            agent_budget: components["schemas"]["AgentConnectionAllowance"][];
            /** Format: uri */
            hosted_mcp_url: string;
            challenge: {
                /** Format: uuid */
                id: string;
                message: string;
                /** Format: date-time */
                expires_at: string;
            };
        };
        RegisterAgentConnectionSetupRequest: {
            setup_token: string;
            /** Format: uuid */
            challenge_id: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            delegate_address: string;
            proof_signature: string;
            api_key_hash: string;
            api_key_prefix: string;
            runtime?: string;
            connector_version?: string;
            connector_context?: components["schemas"]["AgentConnectionConnector"];
            install_capabilities?: {
                can_write_runtime_config?: boolean;
                restart_required?: boolean;
            };
        };
        RegisterAgentConnectionSetupResponse: {
            /** Format: uuid */
            setup_id: string;
            /** Format: uuid */
            agent_id: string;
            status: components["schemas"]["AgentConnectionSetupState"];
            /** @enum {string} */
            agent_status: "pending_approval";
            api_key_prefix: string;
            /** @enum {string} */
            api_key_scope: "setup_pending";
            /** @example 0x1111111111111111111111111111111111111111 */
            delegate_address: string;
            /** Format: uri */
            hosted_mcp_url: string;
            /** @enum {string} */
            next_action: "return_to_haven_for_wallet_approval";
            /** @description True when the setup opted in and its chain issues L0 passports. */
            passport_requested?: boolean;
        };
        AgentConnectionSetupStatus: {
            /** Format: uuid */
            setup_id: string;
            agent_id?: string | null;
            status: components["schemas"]["AgentConnectionSetupState"];
            /** Format: date-time */
            expires_at?: string;
            agent: {
                name: string;
                description?: string | null;
            };
            haven_wallet: components["schemas"]["AgentConnectionWallet"];
            agent_budget: components["schemas"]["AgentConnectionAllowance"][];
            delegate_address?: string | null;
            api_key_prefix?: string | null;
            runtime?: string | null;
            connector?: components["schemas"]["AgentConnectionConnector"];
            install_status: components["schemas"]["AgentConnectionInstallStatus"];
            approval: {
                safe_tx_hash: string | null;
                tx_hash: string | null;
                status: string;
            };
            failure_reason?: string | null;
        };
        RecordAgentConnectionWalletApprovalRequest: {
            /** @enum {string} */
            result: "confirmed" | "proposed";
            tx_hash?: string;
            safe_tx_hash: string;
            chain_id: number;
            /** @example 0x1111111111111111111111111111111111111111 */
            safe_address: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            allowance_module_address: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            delegate_address: string;
            /**
             * @description Use receipt_timeout only when the wallet transaction was submitted but the local receipt wait timed out.
             * @enum {string}
             */
            confirmation_status?: "confirmed" | "receipt_timeout";
        };
        UpdateConnectorInstallStatusRequest: {
            setup_token?: string;
            runtime?: string;
            runtime_mcp_mode?: string;
            connector_version?: string;
            hosted_mcp_configured?: boolean;
            local_signer_configured?: boolean;
            local_mcp_configured?: boolean;
            credential_files_written?: boolean;
            signer_acknowledged?: boolean;
            local_mcp_acknowledged?: boolean;
            activation_command_available?: boolean;
            probe_result?: string;
            restart_required?: boolean;
            next_user_action?: string;
            error_code?: string | null;
            environment_label?: string;
        };
        UpdateConnectorInstallStatusResponse: {
            /** Format: uuid */
            setup_id: string;
            status: components["schemas"]["AgentConnectionSetupState"];
            install_status: components["schemas"]["AgentConnectionInstallStatus"];
        };
        AgentConnectionConnectorStatus: {
            status: components["schemas"]["AgentConnectionSetupState"];
            approved_budget: {
                token_symbol: string;
                /** @example 0x1111111111111111111111111111111111111111 */
                token_address: string;
                amount: string;
                reset_period_min: number;
            } | null;
        };
        AgentAllowance: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            agent_id: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            token_address: string;
            token_symbol: string;
            allowance_amount: string;
            reset_period_min: number;
        };
        Agent: {
            /** Format: uuid */
            id: string;
            name: string;
            description?: string | null;
            delegate_address: string | null;
            safe_id: string | null;
            safe_address: string | null;
            safe_name: string | null;
            safe_chain_id: number | null;
            account_type?: string | null;
            api_key_prefix: string | null;
            /** @enum {string} */
            status: "active" | "paused" | "pending_approval" | "revoked";
            /** Format: date-time */
            created_at: string;
            archived_at?: string | null;
            allowances: components["schemas"]["AgentAllowance"][];
            mcp_last_seen_at?: string | null;
            mcp_server_name?: string | null;
            has_stranded_funds?: boolean;
        } & {
            [key: string]: unknown;
        };
        CreateAgentRequest: {
            name: string;
            description?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            delegate_address: string;
            /** Format: uuid */
            safe_id?: string;
            /** @description RETIRED (#1440/#2020): per-token allowances died with the Safe rail. A non-empty array is refused with 400 — grant the agent a budget delegation after creation instead. The field survives (empty-only) so older clients sending `allowances: []` keep working. */
            allowances?: {
                [key: string]: unknown;
            }[];
        };
        DelegateBalance: {
            delegate_address: string;
            safe_address: string | null;
            chain_id: number;
            eth: string;
            eth_atomic: string;
            usdc: string;
            usdc_atomic: string;
            usdc_address: string | null;
        };
        CreateAgentResponse: components["schemas"]["Agent"] & {
            api_key: string;
            passport_requested: boolean;
        };
        CreatePaymentRequest: {
            /**
             * @example USDC
             * @example EURe
             * @example xDAI
             */
            token: string;
            /** @description Human-readable token amount. */
            amount: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to: string;
            /** @description Optional dedupe key (#1207): a retried request with the same key returns the first request's result (idempotent_replay: true) instead of minting a second transfer or approval. A key reused for a different transfer is a 409. Same contract as /machine-payments/send. */
            idempotency_key?: string;
        } & {
            [key: string]: unknown;
        };
        SignablePaymentIntent: {
            /** Format: uuid */
            payment_id: string;
            /** @enum {string} */
            status: "pending_signature";
            /** Format: date-time */
            expires_at: string;
            sign_data: {
                /** @description The UserOperation hash. Present for reference and replay-matching — do NOT sign it directly; sign `typed_data`. */
                hash: string;
                /**
                 * @description The delegation rail's only scheme. The retired AllowanceModule rail's raw-ECDSA-over-`hash` scheme died with it (#1986) and is not offered here.
                 * @enum {string}
                 */
                signature_scheme: "eip712_userop";
                /** @description The EIP-712 payload to sign VERBATIM with the delegate key. The account validates this, not `hash`. */
                typed_data: {
                    [key: string]: unknown;
                };
                components: {
                    /**
                     * @description The delegator account the UserOperation runs on.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    account?: string;
                    /**
                     * @description Present on the x402 funding shape only.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    safe?: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    token: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    to: string;
                    /** @description Atomic token amount. */
                    amount: string;
                };
                instructions: string;
            };
        };
        PaymentIntentStatus: {
            /** Format: uuid */
            payment_id: string;
            status: string;
            chain_id?: number;
            token: string;
            amount: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to: string;
            tx_hash: string | null;
            explorer_url?: string | null;
            error_message: string | null;
            /** Format: date-time */
            created_at: string;
            signed_at: string | null;
            submitted_at: string | null;
            confirmed_at: string | null;
            /** Format: date-time */
            expires_at: string;
        };
        PaymentExecutionResult: {
            /** Format: uuid */
            payment_id: string;
            status: string;
            tx_hash?: string;
            chain_id?: number;
            explorer_url?: string;
            token?: string;
            amount?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to?: string;
            error?: string;
            details?: string;
        } & {
            [key: string]: unknown;
        };
        PaymentListItem: {
            /** Format: uuid */
            payment_id: string;
            status: string;
            token: string;
            amount: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to: string;
            tx_hash: string | null;
            /** Format: date-time */
            created_at: string;
            confirmed_at: string | null;
        };
        RailContext: {
            amount_atomic: string | null;
            asset: string | null;
            network: string | null;
            /** Format: uri */
            resource_url: string | null;
            merchant_address: string | null;
            description: string | null;
            idempotency_key: string | null;
        };
        AgentPaymentStatus: {
            /** Format: uuid */
            payment_id: string;
            /**
             * @description Always `payment_intent` in practice. `approval_request` is kept for wire compatibility in the #2055 style: the approval queue died with the Safe rail and `approval_requests` was dropped (migration 070), so no payment can resolve to that kind any more — but the value stays declared because the backend's own status type still carries it and this route still serializes the field. Do not write a branch on it.
             * @enum {string}
             */
            kind: "payment_intent" | "approval_request";
            rail: components["schemas"]["AgentPaymentRail"];
            status: string;
            phase: components["schemas"]["AgentPaymentPhase"];
            next_action: components["schemas"]["AgentPaymentNextAction"];
            /** @description Human-readable token amount. */
            amount: string;
            token: string;
            /** Format: uri */
            resource_url: string | null;
            merchant_address: string | null;
            /** @description Delegate EOA captured on a payment intent. */
            payer_address?: string | null;
            tx_hash: string | null;
            /** Format: date-time */
            expires_at: string;
            chain_id: number;
            message: string;
            amount_atomic?: string | null;
            asset?: string | null;
            network?: string | null;
            description?: string | null;
            idempotency_key?: string | null;
            x402?: components["schemas"]["RailContext"];
            mpp?: components["schemas"]["RailContext"] & {
                challenge_id?: string | null;
            };
        };
        X402PaymentOption: {
            /** @enum {string} */
            scheme: "exact";
            network: string;
            amount: string;
            maxAmountRequired?: string;
            resource?: string;
            description?: string;
            mimeType?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            asset: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            payTo: string;
            maxTimeoutSeconds: number;
            extra?: {
                [key: string]: unknown;
            };
        } & {
            [key: string]: unknown;
        };
        X402PaymentRequired: {
            x402Version: number;
            resource: {
                /** Format: uri */
                url: string;
                description?: string;
                mimeType?: string;
            } & {
                [key: string]: unknown;
            };
            accepts: components["schemas"]["X402PaymentOption"][];
            error?: string;
        } & {
            [key: string]: unknown;
        };
        X402AuthorizeRequest: {
            /** Format: uri */
            url: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            payTo: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            merchantPayTo?: string;
            /** @description Atomic token amount from the x402 challenge. */
            amount: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            asset: string;
            /**
             * @example base
             * @example eip155:8453
             */
            network: string;
            description?: string;
            maxTimeoutSeconds?: number;
            category?: string;
            idempotencyKey?: string;
            signature?: string;
            /** @description #1307: the merchant MCP-tool call this quote was made against (haven_pay_mcp_tool). Persisted so GET /x402/{id}/merchant-call-context can rehydrate it at settle/complete time. */
            mcpCallContext?: {
                /** Format: uri */
                merchantUrl: string;
                toolName: string;
                arguments?: {
                    [key: string]: unknown;
                };
                mcpTransport?: {
                    handshakeRequired: boolean;
                    /** @enum {string} */
                    source: "path" | "bazaar";
                };
            };
            /** @description #1355: the merchant's full parsed 402 PaymentRequired (max 64KB serialized). Persisted so GET /x402/{id}/sign-context can re-serve it and a local signer needs only payment_id. Reporting material, not payment authority — the signer verifies whichever copy it uses against the Haven-signed expected context. */
            paymentRequired?: {
                [key: string]: unknown;
            };
        };
        X402MerchantCallContext: {
            /** Format: uuid */
            payment_id: string;
            /** Format: uri */
            merchant_url: string;
            tool_name: string;
            arguments?: {
                [key: string]: unknown;
            };
            mcp_transport?: {
                handshake_required?: boolean;
                /** @enum {string} */
                source?: "path" | "bazaar";
            };
        };
        X402SignablePayment: components["schemas"]["SignablePaymentIntent"] & {
            chain_id?: number;
            /** @example 0x1111111111111111111111111111111111111111 */
            safe_address?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            payer?: string;
            token?: string;
            amount?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to?: string;
            merchant_to?: string | null;
            /** Format: uri */
            resource_url?: string;
            x402_expected_auth: {
                /**
                 * @description Contents-derived, never chosen: 1 = hash-only (legacy rail); 2 = commits to the EIP-712 typedDataHash (delegation rail, #1138); 3 = additionally binds the payer identity (#1690). The enum previously claimed [1] while v2 had shipped — corrected here.
                 * @enum {integer}
                 */
                version: 1 | 2 | 3;
                /** @description Haven-signed expected x402 context. Includes expiresAt when the funding window is time-bound. */
                message: string;
                signature: string;
                /** @example 0x1111111111111111111111111111111111111111 */
                signer: string;
            };
            /**
             * @description #1690: the delegate this quote was created FOR, bound inside the Haven-signed expected context (version 3). The edge signer refuses to sign when it is not its own delegate — the guard that turns a stale-host quote-as-A-sign-as-B into a named refusal instead of an on-chain revert. Emitted only when the deployment has flipped X402_EMIT_PAYER_CONTEXT (signer-first rollout).
             * @example 0x1111111111111111111111111111111111111111
             */
            payer_delegate?: string;
            /** @description #1690: the paying agent's id, carried so the signer's refusal can name both sides. Same gate as payer_delegate. */
            payer_agent_id?: string;
            /** @description #1355: the stored 402 PaymentRequired, present on GET /x402/{id}/sign-context responses when it was persisted at authorize time. Lets the local signer build the merchant header from the context fetch alone. */
            payment_required?: {
                [key: string]: unknown;
            };
        };
        X402ConfirmedPayment: {
            success: boolean;
            /** Format: uuid */
            payment_id: string;
            status: string;
            tx_hash: string;
            chain_id?: number;
            /** @example 0x1111111111111111111111111111111111111111 */
            safe_address?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            payer?: string;
            token?: string;
            amount?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to?: string;
            merchant_to?: string | null;
            /** Format: uri */
            resource_url?: string;
            explorer_url?: string;
        };
        X402ResumeState: {
            /** @enum {string} */
            rail: "x402";
            /** Format: uuid */
            paymentId: string;
            idempotencyKey: string;
            paymentRequired: components["schemas"]["X402PaymentRequired"];
            accepted: components["schemas"]["X402PaymentOption"];
            /** Format: uri */
            url: string;
            request?: components["schemas"]["SerializableRequest"];
            /** Format: uri */
            resourceUrl: string;
            description?: string | null;
            amountAtomic: string;
            amount: string;
            token: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            asset: string;
            network: string;
            chainId: number | null;
            /** @example 0x1111111111111111111111111111111111111111 */
            merchantAddress: string;
        };
        SerializableRequest: {
            /** Format: uri */
            url: string;
            method: string;
            headers: [
                string,
                string
            ][];
            body?: string;
        };
        MachinePaymentChallenge: {
            /** @enum {string} */
            rail: "mpp_demo" | "mpp_crypto" | "stripe_deposit" | "spt";
            version: string;
            challengeId: string;
            /** Format: uri */
            resource: string;
            description: string;
            network: {
                chainId: number;
                /** @enum {string} */
                name: "base";
            };
            asset: {
                /** @enum {string} */
                symbol: "USDC";
                /** @example 0x1111111111111111111111111111111111111111 */
                address: string;
                /** @enum {integer} */
                decimals: 6;
            };
            amount: {
                display: string;
                atomic: string;
            };
            /** @example 0x1111111111111111111111111111111111111111 */
            recipient: string;
            /** Format: date-time */
            expiresAt: string;
            metadata?: {
                [key: string]: unknown;
            };
        };
        MachinePaymentAuthorizeRequest: {
            challenge: components["schemas"]["MachinePaymentChallenge"];
            idempotencyKey: string;
            signature?: string;
        };
        MachinePaymentAuthorizeResponse: components["schemas"]["AgentPaymentStatus"] | components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"];
        MppResumeState: {
            /** @enum {string} */
            rail: "mpp";
            paymentRail: string;
            /** Format: uuid */
            paymentId: string;
            idempotencyKey: string;
            challenge: components["schemas"]["MachinePaymentChallenge"];
            /** Format: uri */
            url: string;
            request?: components["schemas"]["SerializableRequest"];
            /** Format: uri */
            resourceUrl: string;
            description?: string | null;
            amountAtomic: string;
            amount: string;
            token: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            asset: string;
            network: string;
            chainId: number;
            /** @example 0x1111111111111111111111111111111111111111 */
            merchantAddress: string;
            /** Format: date-time */
            expiresAt: string;
        };
        PaymentResumeState: components["schemas"]["X402ResumeState"] | components["schemas"]["MppResumeState"];
        MachinePaymentAgent: {
            /** Format: uuid */
            id: string;
            name: string;
            status: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            safe_address: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            delegate_address: string;
            delegate_account_address: string | null;
            chain_id: number;
            /**
             * @description Which rail this agent's account is on (#1306). `delegation` means spend is gated by the agent's active budget delegations, enforced on-chain by the caveat enforcers. `legacy` is the RETIRED Safe / AllowanceModule rail (#1986) and gates nothing any more — every payment entry point answers 410 for such an account, so read it as "this account cannot pay until it re-onboards via POST /accounts/hybrid", not as a second live policy primitive. Reporting only; the enum keeps both values because a retired-rail account can still read its own identity here.
             * @enum {string}
             */
            execution_rail: "legacy" | "delegation";
        };
        AllowanceSummary: {
            /** Format: uuid */
            agent_id: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            safe_address: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            delegate_address: string;
            chain_id: number;
            allowances: {
                /** Format: uuid */
                id: string;
                /** @example 0x1111111111111111111111111111111111111111 */
                token_address: string;
                token_symbol: string;
                configured_amount: string;
                reset_period_min: number;
                onchain: {
                    amount: string;
                    spent: string;
                    remaining: string;
                    effective_spent: string;
                    reset_time_min: number;
                    last_reset_min: number;
                    nonce: number;
                    is_reset_pending: boolean;
                    /** @description Delegation rail only (#1319, provenance for #1145's fallback): true when `remaining` came from a live ERC20PeriodTransferEnforcer read, false when the read failed and this is the fallback full configured budget. #2105: it is now effectively always present, because this whole summary is a delegation-rail response — since #2020 the retired Safe / AllowanceModule rail answers 410 here rather than a summary, so there is no longer a second rail for the field to be absent on. Reporting only — the on-chain policy is the actual gate; this only says how fresh this number is. */
                    remaining_is_from_chain?: boolean;
                };
            }[];
        };
        MachinePaymentReceipt: {
            /** Format: uuid */
            id: string;
            /** Format: uuid */
            payment_id: string;
            payment_intent_id?: string | null;
            approval_request_id?: string | null;
            rail: string;
            /** @description Which settlement branch ran (eip3009 | erc7710), from the intent (#946). Null on legacy-rail receipts. */
            settlement_scheme?: string | null;
            /** @description The metering budget delegation, uniform across schemes (#1059). Null on the legacy rail and on intents predating migration 053. */
            budget_delegation_hash?: string | null;
            /** @enum {string} */
            proof_status: "payment_confirmed" | "merchant_response_observed" | "protocol_receipt_attached";
            tx_hash: string;
            chain_id: number;
            /** Format: uri */
            resource_url: string;
            merchant_address?: string | null;
            /** @example 0x1111111111111111111111111111111111111111 */
            payer_address?: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            settlement_address?: string;
            token_symbol: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            token_address: string;
            amount_raw: string;
            amount_human: string;
            challenge_id?: string | null;
            idempotency_key?: string | null;
            merchant_status?: number | null;
            confirmed_at?: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        } & {
            [key: string]: unknown;
        };
        MachinePaymentEvidenceRequest: {
            /** Format: uuid */
            paymentId: string;
            rail: string;
            txHash: string;
            /** Format: uri */
            resourceUrl?: string;
            merchantStatus?: number;
            challengePayload?: {
                [key: string]: unknown;
            };
            selectedPayment?: {
                [key: string]: unknown;
            };
            paymentProofHeaderName?: string;
            paymentProofHeader?: string;
            protocolReceiptHeaderName?: string;
            protocolReceiptHeader?: string;
            protocolReceiptPayload?: {
                [key: string]: unknown;
            };
        };
        MachinePaymentReconciliationEventRequest: {
            /** Format: uuid */
            paymentId: string;
            rail: string;
            /** @enum {string} */
            eventType: "merchant_retry_rejected_after_payment";
            txHash?: string;
            reason?: string;
            details?: {
                [key: string]: unknown;
            };
        };
        MachinePaymentReconciliationEventResponse: {
            /** Format: uuid */
            event_id: string;
            /** @enum {string} */
            status: "open" | "resolved";
            /** Format: uuid */
            payment_id: string;
            rail: string;
            event_type: string;
            /** Format: date-time */
            created_at: string;
        };
        /** @description EIP-3009 TransferWithAuthorization fields for a delegate → Safe USDC sweep. */
        SweepAuthorization: {
            /** @example 0x1111111111111111111111111111111111111111 */
            from: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to: string;
            /** @description Atomic USDC amount. */
            value: string;
            /** @description Unix seconds the authorization becomes valid. */
            validAfter: string;
            /** @description Unix seconds the authorization expires. */
            validBefore: string;
            /** @description 0x-prefixed 32-byte hex nonce. */
            nonce: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            token: string;
            /** @example 8453 */
            chainId: number;
        };
        /** @description Haven's binding over the sweep authorization context, verified by the edge signer. */
        SweepExpectedAuth: {
            /** @enum {integer} */
            version: 1;
            message: string;
            signature: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            signer: string;
        };
        SweepPrepareResponse: {
            authorization: components["schemas"]["SweepAuthorization"];
            expected_auth: components["schemas"]["SweepExpectedAuth"];
            /** @example USDC */
            asset: string;
            amount: string;
            amount_atomic: string;
            /** @example 8453 */
            chain_id: number;
            sign_instructions?: string;
        };
        SweepSubmitRequest: {
            authorization: components["schemas"]["SweepAuthorization"];
            /** @description Delegate EIP-712 signature over the authorization. */
            signature: string;
        };
        SweepSubmitResponse: {
            tx_hash: string;
            /** @example USDC */
            asset: string;
            amount: string;
            amount_atomic: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            from_address: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            to_address: string;
            /** @example 8453 */
            chain_id: number;
            explorer_url: string;
            idempotent_replay?: boolean;
        };
        /** @description Fields shared by every transaction representation. The per-Safe page items (`GET /transactions/{safeAddress}`) are exactly this shape; the aggregated feed adds Safe scope on top (`Transaction`). */
        TransactionBase: {
            hash: string;
            /** @enum {string} */
            type: "native" | "erc20" | "internal";
            /** @description Counterparty address, or the empty string when the explorer reported none. */
            from: string;
            /** @description Counterparty address, or the empty string when the explorer reported none. */
            to: string;
            value: string;
            valueFormatted: string;
            /** @description Token ticker where known; falls back to the raw contract address for unknown tokens. */
            asset: string;
            decimals: number;
            /** @enum {string} */
            direction: "in" | "out";
            timestamp: number;
            /** @description 0 for x402-synthesized rows with no on-chain receipt yet. */
            blockNumber: number;
            isError: boolean;
            /** @example 0x1111111111111111111111111111111111111111 */
            tokenAddress?: string;
            tokenSymbol?: string;
            /** @description Origin of the row. Known values: 'direct', 'x402', 'mpp_demo', 'mpp_crypto', 'spt', 'stripe_deposit'. Open set — new payment rails add values. */
            source?: string;
            x402ResourceUrl?: string | null;
            x402MerchantAddress?: string | null;
            paymentId?: string;
            paymentProofStatus?: string | null;
            /** @enum {string|null} */
            paymentFlowStatus?: "paid" | "confirming_merchant" | "needs_attention" | null;
            /** @enum {string|null} */
            paymentAttentionReason?: "merchant_retry_rejected_after_payment" | null;
            /** @enum {string} */
            activityType?: "delegate_sweep";
            agentName?: string;
            /**
             * @description Which settlement branch actually moved the money: `erc7710` (direct settlement, account → merchant, no funding leg) or `eip3009` (funded transfer — the budget delegation funds the delegate EOA, which then signs the standard EIP-3009 header). This is the settlement SCHEME and is three-way distinct from its neighbours: `source` is the payment PROTOCOL (x402, mpp_crypto, …), and the account's `execution_rail` is the ACCOUNT ARCHITECTURE (delegation vs the legacy AllowanceModule). Do not collapse them. Null when no scheme was recorded — non-machine transfers, and legacy-rail rows, which are structurally EIP-3009 but never stamp the key. Null-in-null-out: nothing is inferred or backfilled.
             * @enum {string|null}
             */
            settlementScheme?: "eip3009" | "erc7710" | null;
            amountSek?: string | null;
        };
        /** @description Aggregated-feed transaction: the shared base plus Safe scope. Also used by the dashboard overview preview, which never populates the payment-enrichment fields. */
        Transaction: components["schemas"]["TransactionBase"] & {
            chainId: number;
            /** Format: uuid */
            safeId: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            safeAddress: string;
            safeName: string;
            /** Format: uuid */
            agentId?: string;
        };
        /** @description Per-Safe paginated transaction list (`GET /transactions/{safeAddress}`). Items carry no Safe scope — the Safe is the path parameter. */
        TransactionsPageResponse: {
            transactions: components["schemas"]["TransactionBase"][];
            total: number;
            page: number;
            limit: number;
            /** @description 0 when total is 0. */
            pages: number;
        };
        BalanceItem: {
            symbol: string;
            /** @description Token contract address; null for the chain-native token (exactly one entry). */
            address: string | null;
            /** @description Raw base units; '0' when the RPC lookup failed. */
            balance: string;
            formatted: string;
            decimals: number;
        };
        BalancesResponse: {
            /** @description Native token first, then ERC-20s in registry order. Never empty. */
            balances: components["schemas"]["BalanceItem"][];
        };
        PortfolioBreakdown: {
            symbol: string;
            /** @description Raw base units; '0' on RPC failure. */
            balance: string;
            formatted: string;
            /** @description 0 when the price feed failed. */
            usdValue: number;
            eurValue: number;
        };
        PortfolioResponse: {
            totalUsd: number;
            totalEur: number;
            breakdown: components["schemas"]["PortfolioBreakdown"][];
        };
        SafeDetails: {
            /** @description Echoed back as supplied — not re-checksummed. */
            address: string;
            /** @description Checksummed owner addresses from the contract. */
            owners: string[];
            threshold: number;
            nonce: number;
        };
        TransactionFilterOptionsResponse: {
            safes: {
                /** Format: uuid */
                id: string;
                name: string;
                /** @example 0x1111111111111111111111111111111111111111 */
                address: string;
                chainId: number;
            }[];
            /** @description ALL agents including revoked — unlike the dashboard preview. */
            agents: {
                /** Format: uuid */
                id: string;
                name: string;
                /** @enum {string} */
                status: "active" | "paused" | "pending_approval" | "revoked";
            }[];
            tokens: {
                /** @description '<chainId>:native' or '<chainId>:<lowercased address>'. */
                key: string;
                symbol: string;
                /** @description null iff isNative. */
                address: string | null;
                chainId: number;
                isNative: boolean;
            }[];
        };
        DashboardAgentAllowance: {
            tokenSymbol: string;
            allowanceAmount: string;
            resetPeriodMin: number;
        };
        DashboardAgentPreview: {
            /** Format: uuid */
            id: string;
            name: string;
            /**
             * @description Revoked agents are excluded from the preview query.
             * @enum {string}
             */
            status: "active" | "paused";
            /** Format: uuid */
            safeId: string | null;
            safeName: string | null;
            safeChainId: number | null;
            allowances: components["schemas"]["DashboardAgentAllowance"][];
        };
        DashboardOverviewResponse: {
            totals: {
                usd: number;
                eur: number;
            };
            change: {
                /** @description true iff a yesterday snapshot existed to diff against. */
                available: boolean;
                usdAmount: number;
                eurAmount: number;
                /** @description 0 when unavailable or the previous total was 0. */
                usdPercent: number;
                eurPercent: number;
            };
            metrics: {
                /** @description Agents with status 'active' only. */
                connectedAgents: number;
                monthlyAgentSpendUsd: number;
                monthlyAgentSpendEur: number;
                successfulTransactions: number;
                /** @description All linked Safes, regardless of activity. */
                activeAccounts: number;
            };
            /** @description Always 0 since #2055 — the approval queue died with the Safe rail and its table is dropped; the field survives for wire compatibility. */
            actionableApprovals: number;
            /** @description Duplicate of actionableApprovals; always 0 since #2055, kept for compatibility. */
            pendingApprovals: number;
            onboardingProgress: {
                hasFirstAgentPayment: boolean;
            };
            /** @description At most 6. */
            agents: components["schemas"]["DashboardAgentPreview"][];
            /** @description At most 5. Payment-enrichment fields (paymentId, paymentFlowStatus, amountSek, …) are never populated in this projection. */
            transactions: components["schemas"]["Transaction"][];
        };
        /** @description Reported whether or not it is recoverable — nothing about a stranded residual fails quietly. */
        AgentRekeyResidual: {
            atomic: string;
            token_address?: string | null;
            disposition?: string | null;
            recoverable_after_rekey: boolean;
            note?: string;
        };
        AgentRekeyRevokePrepare: {
            /** @enum {string} */
            signature_scheme: "eip712_userop";
            signing_payload: {
                [key: string]: unknown;
            };
            user_operation: {
                [key: string]: unknown;
            };
            /** @example 0x1111111111111111111111111111111111111111 */
            treasury_address: string;
            delegation_hashes: string[];
            instructions: string;
        } | {
            /** @enum {string} */
            signature_scheme: "webauthn_userop";
            user_op_hash: string;
            user_operation: {
                [key: string]: unknown;
            };
            /** @example 0x1111111111111111111111111111111111111111 */
            treasury_address: string;
            delegation_hashes: string[];
            instructions: string;
        } | {
            /** @enum {boolean} */
            revoked: true;
            /** @description Null on the empty walk; the ABANDONED predecessor’s revoke transaction when its carry was inherited. */
            tx_hash?: string | null;
            delegation_hashes?: string[];
            stage: string;
            /** @description Empty on the plain short-circuit; the inherited frozen measurement when an abandoned predecessor’s carry was adopted (#1868). */
            carry?: {
                /** @description The delegation's stable identity (#827) — keccak of the unsigned delegation. */
                delegation_hash: string;
                remaining_atomic: string;
                from_chain: boolean;
            }[];
            /**
             * Format: uuid
             * @description Present only when the carry was inherited: the abandoned re-key whose frozen measurement this re-key adopted (#1868).
             */
            carry_inherited_from_rekey_id?: string;
            agent_has_no_authority: boolean;
            next_step: string;
        };
        AgentRekeyPreflight: {
            /** Format: uuid */
            rekey_id: string;
            /** @enum {string} */
            stage: "preflight";
            /** @example 0x1111111111111111111111111111111111111111 */
            old_delegate_address: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            new_delegate_address: string;
            residual: components["schemas"]["AgentRekeyResidual"];
            delegations_to_revoke: string[];
            next_step: string;
            ordering_note?: string;
        };
        AgentRekeyIssuedDelegation: {
            /** @description The delegation's stable identity (#827) — keccak of the unsigned delegation. */
            delegation_hash: string;
            /** @enum {string} */
            carry_role: "carry" | "steady" | "reanchor";
            /** @example 0x1111111111111111111111111111111111111111 */
            token_address: string;
            recipient_address?: string | null;
            budget_atomic: string;
            period_seconds?: number;
            start_date?: number;
            expires_at?: number;
            signing_payload: {
                [key: string]: unknown;
            };
        };
        AgentRekeyIssueResponse: {
            /** @enum {string} */
            stage: "issued";
            /** @example 0x1111111111111111111111111111111111111111 */
            delegate_account_address: string;
            delegations: components["schemas"]["AgentRekeyIssuedDelegation"][];
            skipped?: {
                /** @description The delegation's stable identity (#827) — keccak of the unsigned delegation. */
                delegation_hash?: string;
                reason?: string;
            }[];
            carry_note?: string;
            next_step?: string;
        };
        AgentRekeyCompleteResponse: {
            completed: boolean;
            /** @enum {string} */
            stage: "completed";
            /** Format: uuid */
            agent_id: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            new_delegate_address: string;
            /** @description Shown ONCE. Never stored in plaintext and never logged. */
            api_key: string;
            api_key_prefix: string;
            old_api_key_revoked: boolean;
            invalidated_intents?: number;
            superseded_delegations?: number;
            residual_on_old_delegate?: {
                atomic?: string;
                recoverable?: boolean;
                note?: string;
            };
        };
        TransactionsResponse: {
            transactions: components["schemas"]["Transaction"][];
            total: number;
            offset: number;
            limit: number;
            hasMore: boolean;
            partialFailure: boolean;
            failedSafeIds: string[];
        };
    };
    responses: never;
    parameters: {
        AgentId: string;
        PaymentId: string;
        SetupId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export interface operations {
    getOpenApiSpec: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description OpenAPI 3.1 document for the Haven Agent Payment API. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Backend is healthy. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
            /** @description Backend is reachable but degraded. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HealthResponse"];
                };
            };
        };
    };
    listAgents: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agents owned by the user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        agents: components["schemas"]["Agent"][];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createAgent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentRequest"];
            };
        };
        responses: {
            /** @description Agent created. The api_key is shown once and should be stored by the user or agent runtime. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateAgentResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent details. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    updateAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Trimmed. */
                    name?: string;
                    /** @description Trimmed. */
                    description?: string;
                };
            };
        };
        responses: {
            /** @description The updated agent, with allowances. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Always. The message names the archive route to use instead. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getDelegateBalance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Delegate balance. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DelegateBalance"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    archiveAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Archived (or already archived). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        success: boolean;
                        /** Format: date-time */
                        archived_at: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    unarchiveAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No longer archived (or was not archived). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        success: boolean;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    revokeAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent revoked. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listAgentDelegations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Delegations ordered by created_at DESC. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        delegations: components["schemas"]["Delegation"][];
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    buildAgentDelegation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    token_address: string;
                    /**
                     * @description Optional recipient pin. Omit (or null) for an open budget.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    recipient_address?: string;
                    /** @description Positive atomic token amount; must fit uint96 (the enforcer word size). */
                    budget_atomic: string;
                    /** @description Native refill period; ≥ 60. */
                    period_seconds: number;
                    /** @description Unix seconds, must be in the future. Default: now + 90 days. */
                    expires_at?: number;
                };
            };
        };
        responses: {
            /** @description Pending delegation stored; the owner signs signing_payload next. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The delegation's stable identity (#827) — keccak of the unsigned delegation. */
                        delegation_hash: string;
                        /** @description Fresh per (agent, token, recipient) slot — replacement identity (#827). */
                        version: number;
                        /** @example 0x1111111111111111111111111111111111111111 */
                        delegate_account_address: string;
                        /** @description EIP-712 typed data (primaryType 'Delegation') the owner signs verbatim. */
                        signing_payload: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Revoked agents cannot receive a new budget delegation; other delegation-account conflicts also return 409. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    activateAgentDelegation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Delegation hash from the build/list response. */
                hash: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    signature: string;
                };
            };
        };
        responses: {
            /** @description Budget is live. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        activated: boolean;
                        /** @description The delegation's stable identity (#827) — keccak of the unsigned delegation. */
                        delegation_hash: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Revoked agents cannot activate a new budget delegation; non-pending delegation and account conflicts also return 409. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Relayer gas budget exhausted — retry later. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Stored owner config no longer derives the stored account address. */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Account deploy failed; the grant stays pending and activate can be retried. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    prepareDelegationRevocation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Delegation hash from the build/list response. */
                hash: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /**
                     * @description Multi-signer accounts choose per request; omitted, an EOA owner defaults to eip712_userop.
                     * @enum {string}
                     */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                };
            };
        };
        responses: {
            /** @description Prepared revocation, shaped by the signature scheme. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        signature_scheme: "eip712_userop";
                        signing_payload: {
                            [key: string]: unknown;
                        };
                        user_operation: {
                            [key: string]: unknown;
                        };
                        /** @example 0x1111111111111111111111111111111111111111 */
                        treasury_address: string;
                        instructions: string;
                    } | {
                        /** @enum {string} */
                        signature_scheme: "webauthn_userop";
                        user_op_hash: string;
                        user_operation: {
                            [key: string]: unknown;
                        };
                        /** @example 0x1111111111111111111111111111111111111111 */
                        treasury_address: string;
                        instructions: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitDelegationRevocation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Delegation hash from the build/list response. */
                hash: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    signature: string;
                    user_operation: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Delegation disabled on-chain and marked revoked. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        revoked: boolean;
                        tx_hash: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    startAgentRekey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description PUBLIC address of the new delegate keypair, generated locally. Must differ from the current delegate and must not collide with another live agent.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    new_delegate_address: string;
                    /**
                     * @description Required only when the old delegate EOA holds a non-zero balance. "swept" after sweeping it with the old key; "acknowledged_unrecoverable" to proceed knowing the key is lost and the balance is written off.
                     * @enum {string}
                     */
                    residual_disposition?: "swept" | "acknowledged_unrecoverable";
                };
            };
        };
        responses: {
            /** @description Re-key opened at stage preflight. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentRekeyPreflight"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description An agent credential was presented — an agent can never re-key itself. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not on the delegation rail, a re-key already in flight (the body names its rekey_id, stage and the new_delegate_address it is bound to, #1868), a colliding delegate address, or an undispositioned residual balance. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The residual balance read failed; proceeding would retire the only key that could sweep it. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    prepareRekeyRevocation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Re-key id from the preflight response. */
                rekeyId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /**
                     * @description Multi-signer accounts choose per request; omitted, an EOA owner defaults to eip712_userop.
                     * @enum {string}
                     */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                };
            };
        };
        responses: {
            /** @description Prepared revocation, shaped by the signature scheme — or the no-authority short-circuit. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentRekeyRevokePrepare"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Wrong stage — this re-key is past the revoke; the account signer configuration is unknown; or the requested signature_scheme is one this account cannot sign. Every one of these lands BEFORE the revoke, so the re-key stays retryable (#1868). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitRekeyRevocation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Re-key id from the preflight response. */
                rekeyId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    signature: string;
                    user_operation: {
                        [key: string]: unknown;
                    };
                    delegation_hashes: string[];
                };
            };
        };
        responses: {
            /** @description Revoked on-chain and metered. The agent now has NO authority until the issue step completes. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        revoked: boolean;
                        tx_hash?: string | null;
                        delegation_hashes?: string[];
                        /** @enum {string} */
                        stage: "metered";
                        /** @description The frozen measurement, one entry per revoked delegation. */
                        carry?: {
                            /** @description The delegation's stable identity (#827) — keccak of the unsigned delegation. */
                            delegation_hash?: string;
                            remaining_atomic?: string;
                            /** @description False means the read fell back to the full budget. The carry REFUSES these rather than granting a fresh full period. */
                            from_chain?: boolean;
                        }[];
                        agent_has_no_authority: boolean;
                        next_step?: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    issueRekeyDelegations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Re-key id from the preflight response. */
                rekeyId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Replacement delegations built, pending the owner signature. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentRekeyIssueResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Wrong stage (issue may never precede the revoke), or the carry was refused because the meter read did not come from the chain. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    completeAgentRekey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Re-key id from the preflight response. */
                rekeyId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description One entry per delegation from the issue step. Every one must be signed — a partial completion would rotate credentials while some replacement authority stayed unsigned. */
                    signatures: {
                        /** @description The delegation's stable identity (#827) — keccak of the unsigned delegation. */
                        delegation_hash: string;
                        signature: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Re-key complete. The old API key stops authenticating immediately. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentRekeyCompleteResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    abandonAgentRekey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                /** @description Re-key id from the preflight response. */
                rekeyId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description Re-key abandoned. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        abandoned: boolean;
                        /** @enum {string} */
                        stage: "abandoned";
                        agent_has_no_authority: boolean;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    prepareRevokeAllDelegations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    /**
                     * @description Multi-signer accounts choose per request; omitted, an EOA owner defaults to eip712_userop.
                     * @enum {string}
                     */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                };
            };
        };
        responses: {
            /** @description Prepared batch revocation, shaped by the signature scheme. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        signature_scheme: "eip712_userop";
                        signing_payload: {
                            [key: string]: unknown;
                        };
                        user_operation: {
                            [key: string]: unknown;
                        };
                        /** @example 0x1111111111111111111111111111111111111111 */
                        treasury_address: string;
                        delegation_hashes: string[];
                        instructions: string;
                    } | {
                        /** @enum {string} */
                        signature_scheme: "webauthn_userop";
                        user_op_hash: string;
                        user_operation: {
                            [key: string]: unknown;
                        };
                        /** @example 0x1111111111111111111111111111111111111111 */
                        treasury_address: string;
                        delegation_hashes: string[];
                        instructions: string;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Batch too large — revoke per hash, then retry. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitRevokeAllDelegations: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    signature: string;
                    user_operation: {
                        [key: string]: unknown;
                    };
                    delegation_hashes: string[];
                };
            };
        };
        responses: {
            /** @description Batch disabled on-chain; the listed rows are marked revoked. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        revoked: boolean;
                        tx_hash: string;
                        delegation_hashes: string[];
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getAccountSigners: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The signer set. Same shape as the account-scoped read (#1679). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HybridAccountSigners"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    prepareSignerChange: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action: "add_passkey" | "remove_passkey" | "add_owner" | "remove_owner";
                    /** @description Required for add_passkey/remove_passkey. */
                    passkey?: {
                        key_id?: string;
                        x?: string;
                        y?: string;
                    };
                    /**
                     * @description Required for add_owner.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    owner_address?: string;
                    /** @enum {string} */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                };
            };
        };
        responses: {
            /** @description Prepared signer change, shaped by the signature scheme. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        signature_scheme: "eip712_userop";
                        signing_payload: {
                            [key: string]: unknown;
                        };
                        user_operation: {
                            [key: string]: unknown;
                        };
                        instructions: string;
                    } | {
                        /** @enum {string} */
                        signature_scheme: "webauthn_userop";
                        user_op_hash: string;
                        user_operation: {
                            [key: string]: unknown;
                        };
                        instructions: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitSignerChange: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action?: "add_passkey" | "remove_passkey" | "add_owner" | "remove_owner";
                    /** @description Required for add_passkey/remove_passkey. */
                    passkey?: {
                        key_id?: string;
                        x?: string;
                        y?: string;
                    };
                    /**
                     * @description Required for add_owner.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    owner_address?: string;
                    /** @enum {string} */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                    signature: string;
                    user_operation: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Signer set updated on-chain and in storage. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        updated: boolean;
                        tx_hash: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listX402Resources: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resources ordered by created_at DESC. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        resources: {
                            /** Format: uuid */
                            resource_id: string;
                            name: string;
                            description: string | null;
                            /** @description Atomic units. */
                            price_amount: string;
                            /** @description Formatted with the token decimals; falls back to 6 for an unknown token. */
                            price_human: string;
                            /** @description Stored uppercase. */
                            token_symbol: string;
                            /** @description Read back verbatim from storage. The create route lowercases on insert, but x402_resources has NO lowercase CHECK constraint (unlike agent_delegations), so a row written any other way keeps its case — compare case-insensitively. */
                            token_address: string;
                            chain_id: number;
                            /** @description Null when the linked Safe was detached (safe_id is ON DELETE SET NULL) — the resource stays listed but cannot be paid. */
                            pay_to: string | null;
                            active: boolean;
                            /** Format: date-time */
                            created_at: string;
                            /** @description Null exactly when pay_to is null — a challenge cannot be built without a payment address. */
                            challenge: {
                                /** @example 1 */
                                version: string;
                                /** Format: uuid */
                                resource_id: string;
                                accepts: {
                                    /** @example exact */
                                    scheme: string;
                                    /** @example eip155:8453 */
                                    network: string;
                                    /** @example 0x1111111111111111111111111111111111111111 */
                                    asset: string;
                                    /** @description Atomic units. */
                                    maxAmountRequired: string;
                                    /** @example 0x1111111111111111111111111111111111111111 */
                                    payTo: string;
                                    description: string;
                                    extra: {
                                        name: string;
                                        authorize_endpoint: string;
                                        verify_endpoint: string;
                                    };
                                }[];
                            } | null;
                        }[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createX402Resource: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Trimmed; blank after trimming is a 400. */
                    name: string;
                    description?: string;
                    /** @description Atomic units; must parse as an integer. */
                    price_amount: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    token_address: string;
                    /** @description Stored uppercase. */
                    token_symbol: string;
                    /** @description Defaults to DEFAULT_CHAIN_ID (Base). */
                    chain_id?: number;
                    /**
                     * Format: uuid
                     * @description Must belong to the caller; omitted, the user's default Safe is used.
                     */
                    safe_id?: string;
                };
            };
        };
        responses: {
            /** @description Resource registered; the challenge is ready to embed. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        resource_id: string;
                        name: string;
                        price_amount: string;
                        price_human: string;
                        token_symbol: string;
                        token_address: string;
                        chain_id: number;
                        /** @example 0x1111111111111111111111111111111111111111 */
                        pay_to: string;
                        challenge: {
                            /** @example 1 */
                            version: string;
                            /** Format: uuid */
                            resource_id: string;
                            accepts: {
                                /** @example exact */
                                scheme: string;
                                /** @example eip155:8453 */
                                network: string;
                                /** @example 0x1111111111111111111111111111111111111111 */
                                asset: string;
                                /** @description Atomic units. */
                                maxAmountRequired: string;
                                /** @example 0x1111111111111111111111111111111111111111 */
                                payTo: string;
                                description: string;
                                extra: {
                                    name: string;
                                    authorize_endpoint: string;
                                    verify_endpoint: string;
                                };
                            }[];
                        };
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deactivateX402Resource: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resource deactivated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listX402Receipts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Receipts ordered by verified_at DESC, capped at 100. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        receipts: {
                            /** Format: uuid */
                            receipt_id: string;
                            /** Format: uuid */
                            resource_id: string;
                            resource_name: string;
                            tx_hash: string;
                            payer_address: string | null;
                            amount_raw: string;
                            /** @description Display string, formatted with the token's own decimals (6 for an unrecognised token). Read amount_raw for the authoritative value. */
                            amount_human: string;
                            chain_id: number;
                            /** Format: date-time */
                            verified_at: string;
                        }[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getX402ResourceChallenge: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The payment challenge (the success case for this route). */
            402: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 1 */
                        version: string;
                        /** Format: uuid */
                        resource_id: string;
                        accepts: {
                            /** @example exact */
                            scheme: string;
                            /** @example eip155:8453 */
                            network: string;
                            /** @example 0x1111111111111111111111111111111111111111 */
                            asset: string;
                            /** @description Atomic units. */
                            maxAmountRequired: string;
                            /** @example 0x1111111111111111111111111111111111111111 */
                            payTo: string;
                            description: string;
                            extra: {
                                name: string;
                                authorize_endpoint: string;
                                verify_endpoint: string;
                            };
                        }[];
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Resource deactivated. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Resource has no payment address configured. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    verifyX402Payment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Resource id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    tx_hash: string;
                };
            };
        };
        responses: {
            /** @description Payment verified on-chain; a receipt was stored. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        verified: true;
                        /** Format: uuid */
                        receipt_id: string;
                        /** Format: uuid */
                        resource_id: string;
                        resource_name: string;
                        /** @description Lowercased before storage. */
                        tx_hash: string;
                        payer_address: string | null;
                        /** @description The VERIFIED on-chain amount, which can exceed the resource price. */
                        amount_raw: string;
                        amount_human: string;
                        token_symbol: string;
                        /** Format: date-time */
                        verified_at: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Verification failed — the documented negative answer, with the terms the transaction had to meet. */
            402: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        verified: false;
                        reason: string;
                        expected: {
                            /** @example 0x1111111111111111111111111111111111111111 */
                            to: string;
                            /** @description From storage, so case is not guaranteed (see the list schema). */
                            token: string;
                            min_amount: string;
                            chain_id: number;
                        };
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description This transaction was already used as payment. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Resource deactivated. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Resource has no payment address. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getAgentPassport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Passport state (or null) plus the agent's standing. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        passport: {
                            /**
                             * @description Issuance progress. The enum is the table CHECK (migration 048), so a client can branch on it safely.
                             * @enum {string}
                             */
                            status: "pending" | "anchored" | "failed";
                            /** @description L0 only. The table CHECK pins this to 0 — higher tiers are not issuable (#970). */
                            assurance_level: number;
                            /** @description EAS UID once anchored — the evidence pointer, never the decision. */
                            attestation_uid: string | null;
                            tx_hash: string | null;
                            chain_id: number | null;
                            attempts: number;
                            last_error: string | null;
                            /** Format: date-time */
                            requested_at: string | null;
                            /** Format: date-time */
                            anchored_at: string | null;
                        } | null;
                        /** @description The standing OBJECT (not a bare string): the database-authoritative answer plus the chain-lag transparency fields. Always present, even for an agent with no passport row. */
                        standing: {
                            agentId: string;
                            /**
                             * @description THE answer, derived from agents.status alone — an agent revoked before its passport ever anchored is still revoked.
                             * @enum {string}
                             */
                            standing: "active" | "suspended" | "revoked" | "unknown";
                            /**
                             * @description Describes the chain, for transparency — not for deciding. `re_anchoring` means a re-key rotated the delegate key and the attestation naming the old one is being retired and reissued (#1699); standing is unaffected.
                             * @enum {string}
                             */
                            anchor: "not_anchored" | "anchored" | "re_anchoring" | "revocation_pending" | "revoked_onchain";
                            attestationUid: string | null;
                            /** @description True when the database says revoked but the chain has not caught up — a merchant reading only the chain in this window would be WRONG. */
                            chainLagging: boolean;
                            /** Format: date-time */
                            revocationConfirmedAt: string | null;
                        };
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    requestAgentPassport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Already anchored — nothing was minted and no gas was spent. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        passport: {
                            /**
                             * @description Issuance progress. The enum is the table CHECK (migration 048), so a client can branch on it safely.
                             * @enum {string}
                             */
                            status: "pending" | "anchored" | "failed";
                            /** @description L0 only. The table CHECK pins this to 0 — higher tiers are not issuable (#970). */
                            assurance_level: number;
                            /** @description EAS UID once anchored — the evidence pointer, never the decision. */
                            attestation_uid: string | null;
                            tx_hash: string | null;
                            chain_id: number | null;
                            attempts: number;
                            last_error: string | null;
                            /** Format: date-time */
                            requested_at: string | null;
                            /** Format: date-time */
                            anchored_at: string | null;
                        };
                        /** @enum {boolean} */
                        already_issued: true;
                    };
                };
            };
            /** @description Passport requested; the anchor is in progress. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        passport: {
                            /**
                             * @description Issuance progress. The enum is the table CHECK (migration 048), so a client can branch on it safely.
                             * @enum {string}
                             */
                            status: "pending" | "anchored" | "failed";
                            /** @description L0 only. The table CHECK pins this to 0 — higher tiers are not issuable (#970). */
                            assurance_level: number;
                            /** @description EAS UID once anchored — the evidence pointer, never the decision. */
                            attestation_uid: string | null;
                            tx_hash: string | null;
                            chain_id: number | null;
                            attempts: number;
                            last_error: string | null;
                            /** Format: date-time */
                            requested_at: string | null;
                            /** Format: date-time */
                            anchored_at: string | null;
                        } | null;
                    };
                };
            };
            /** @description Agent has no bound account, or passports are not issued on its chain. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent is revoked (terminal), or its account is on a retired rail — passports are issued on the delegation rail only (#2138). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Passport issuance is not configured on this deployment. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPassportIssuer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The issuer and the receipt envelope parameters. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 0x1111111111111111111111111111111111111111 */
                        issuer: string;
                        version: string;
                        receipt_ttl_seconds: number;
                        /** @example eip191-personal-sign-over-canonical-json */
                        signature_scheme: string;
                    };
                };
            };
            /** @description Rate limited. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Verification is not configured on this deployment. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    verifyPassport: {
        parameters: {
            query?: {
                /** @description The agent's delegate EOA or smart account. */
                address?: string;
                /** @description EAS attestation UID. */
                uid?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Either a signed receipt, or a clean `found: false` — both are normal answers. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        found: true;
                        receipt: {
                            version: string;
                            /**
                             * @description The signing address a merchant pins — fetch it from GET /passport/issuer.
                             * @example 0x1111111111111111111111111111111111111111
                             */
                            issuer: string;
                            /** @description Haven's opaque agent id. Not PII and not a wallet. */
                            agentId: string;
                            /** @description The delegate EOA a merchant sees on an EIP-3009 header. */
                            agentEoa: string | null;
                            /** @description The Hybrid delegator a merchant sees in erc7710 redemption. */
                            smartAccount: string | null;
                            /** @enum {integer} */
                            assuranceLevel: 0;
                            /**
                             * @description THE answer, sourced from the database — never derived from the chain.
                             * @enum {string}
                             */
                            standing: "active" | "suspended" | "revoked" | "unknown";
                            /**
                             * @description The on-chain anchor's progress, for transparency. Never the authority. `re_anchoring` is the re-key window (#1699): the attestation on-chain is live but names the agent's RETIRED delegate key, because EAS attestations are immutable — the agent's standing is unaffected.
                             * @enum {string}
                             */
                            anchor: "not_anchored" | "anchored" | "re_anchoring" | "revocation_pending" | "revoked_onchain";
                            evidenceUid: string | null;
                            chainId: number | null;
                            controls: {
                                /**
                                 * @description The account's execution rail, verbatim from user_safes. Only 'delegation' is live; 'allowance_module' (#1440) and 'session_key' (#834) are retired and cannot transact. This field named a shorter, non-existent rail value until #2110 — one the column CHECK has never permitted.
                                 * @enum {string}
                                 */
                                rail: "delegation" | "allowance_module" | "session_key";
                                /** @description True only on the delegation rail, where the caveat enforcers revert an out-of-policy redemption on-chain. False on both retired rails: a legacy account may still hold a real on-chain allowance, but every agent payment entry point answers 410, so there is no spend for a contract to govern. */
                                policyEnforcedOnchain: boolean;
                                treasuryBound: boolean;
                            } | null;
                            /** @description Monotonic ORDERING marker (ms) over changes to the agent record, not a causation signal; 0 means no timestamp. Equal epochs do NOT imply equal receipts — anchor progress moves without it (#1015). */
                            standingEpoch: number;
                            issuedAt: number;
                            /** @description issuedAt + the TTL published by GET /passport/issuer. */
                            expiresAt: number;
                        };
                        /** @description EIP-191 signature over the canonical JSON of `receipt`. */
                        signature: string;
                    } | {
                        /** @enum {boolean} */
                        found: false;
                        reason?: string;
                    };
                };
            };
            /** @description Not exactly one of address/uid, or a malformed value. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Rate limited. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Receipt signing is not configured — fail closed rather than serve an unsigned receipt. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listUserSafes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Linked Safes ordered by created_at ASC. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        safes: {
                            /** Format: uuid */
                            id: string;
                            /** @example 0x1111111111111111111111111111111111111111 */
                            safe_address: string;
                            chain_id: number;
                            /** @description Display label; defaults to 'My account' when none is given. */
                            name: string;
                            /** @description The first Safe a user links becomes the default. */
                            is_default: boolean;
                            /** Format: date-time */
                            created_at: string;
                        }[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    addUserSafe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    safe_address: string;
                    /** @description Defaults to DEFAULT_CHAIN_ID (Base); must be a supported chain. */
                    chain_id?: number;
                    /** @description Trimmed; blank or absent becomes 'My account'. */
                    name?: string;
                };
            };
        };
        responses: {
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Always. The Safe rail is retired; the message names POST /accounts/hybrid. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deployUserSafe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    owner_address: string;
                    /** @description Defaults to DEFAULT_CHAIN_ID (Base); must be a supported chain. */
                    chain_id?: number;
                };
            };
        };
        responses: {
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Always. The Safe rail is retired; the message names POST /accounts/hybrid. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    renameUserSafe: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Linked-Safe id. */
                safeId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Trimmed; blank after trimming is a 400. */
                    name: string;
                };
            };
        };
        responses: {
            /** @description The renamed Safe. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @example 0x1111111111111111111111111111111111111111 */
                        safe_address: string;
                        chain_id: number;
                        /** @description Display label; defaults to 'My account' when none is given. */
                        name: string;
                        /** @description The first Safe a user links becomes the default. */
                        is_default: boolean;
                        /** Format: date-time */
                        created_at: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    unlinkUserSafe: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Linked-Safe id. */
                safeId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Safe unlinked. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    setDefaultUserSafe: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Linked-Safe id. */
                safeId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default updated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    updateUserProfile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Trimmed; blank or over 80 characters is a 400. */
                    name: string;
                };
            };
        };
        responses: {
            /** @description The updated profile. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string | null;
                        email: string;
                        wallet_address: string | null;
                        safe_address: string | null;
                        currency_preference: string | null;
                        /** Format: date-time */
                        created_at: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The account was deleted while a valid token for it was still in flight. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    updateUserWallet: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    wallet_address: string;
                };
            };
        };
        responses: {
            /** @description The updated identity projection. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string | null;
                        email: string;
                        wallet_address: string | null;
                        safe_address: string | null;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    updateUserSafe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    safe_address: string;
                    /** @description Defaults to DEFAULT_CHAIN_ID (Base). */
                    chain_id?: number;
                };
            };
        };
        responses: {
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Always. The Safe rail is retired; the message names POST /accounts/hybrid. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getUserPreferences: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The current preference. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        currency_preference: string;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    updateUserPreferences: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    currency_preference: "USD" | "EUR";
                };
            };
        };
        responses: {
            /** @description The stored preference. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        currency_preference: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listUserOwners: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Owners grouped by address, plus the partial-failure report. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        owners: {
                            /** @description Lowercased for grouping. */
                            owner_address: string;
                            /** @description The stored alias, or null. */
                            name: string | null;
                            accounts: {
                                /** Format: uuid */
                                id: string;
                                /** @example 0x1111111111111111111111111111111111111111 */
                                safe_address: string;
                                chain_id: number;
                                name: string;
                            }[];
                        }[];
                        partialFailure: boolean;
                        failedSafeIds: string[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    setOwnerAlias: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Owner address; matched case-insensitively (stored lowercase). */
                ownerAddress: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                };
            };
        };
        responses: {
            /** @description The stored alias. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        owner_address: string;
                        name: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not a current owner of any linked account. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Owners could not be verified — distinct from "not an owner". */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteOwnerAlias: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Owner address; matched case-insensitively (stored lowercase). */
                ownerAddress: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Alias removed (or was already absent). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    exportAccounting: {
        parameters: {
            query?: {
                /** @description Defaults to 'sie'; anything else is a 400. */
                format?: "sie";
                /** @description ISO date (YYYY-MM-DD…). */
                from?: string;
                /** @description ISO date (YYYY-MM-DD…). */
                to?: string;
                /** @description Company name in the file header; defaults to 'Haven'. */
                company?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The SIE file. */
            200: {
                headers: {
                    /** @description Entries written. */
                    "X-Export-Entry-Count"?: string;
                    /** @description Entries that could not be written. */
                    "X-Export-Skipped"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The default: SIE export is retired in favour of the reporting feed. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    reconcileAccounting: {
        parameters: {
            query?: {
                /** @description ISO date. */
                from?: string;
                /** @description ISO date. */
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The reconciliation report. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        total: number;
                        ok: number;
                        issues: number;
                        byStatus: {
                            ok: number;
                            /** @description No SEK amount — the FX rate was unavailable. */
                            missing_fx: number;
                            /** @description No transaction hash to anchor the entry. */
                            missing_tx: number;
                            /** @description Debits and credits disagree. */
                            unbalanced: number;
                        };
                        /** @description ONLY the entries that need attention — an entry classified ok is counted in byStatus but never listed here, so items.length is issues, not total. */
                        items: {
                            paymentId: string;
                            txHash: string;
                            settledAt: string;
                            /** @enum {string} */
                            status: "ok" | "missing_fx" | "missing_tx" | "unbalanced";
                        }[];
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listAccountOverrides: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Overrides ordered by resource_url. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        overrides: {
                            resource_url: string;
                            bas_account: string;
                        }[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    setAccountOverride: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    resourceUrl: string;
                    /** @description A BAS account number. */
                    account: string;
                };
            };
        };
        responses: {
            /** @description The stored override, echoed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        resourceUrl: string;
                        account: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    clearAccountOverride: {
        parameters: {
            query: {
                resourceUrl: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Override cleared (or was never set). */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getReportingStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Feed status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        hosted: boolean;
                        flagEnabled: boolean;
                        /** @description A real provider adapter is registered. */
                        liveSyncReady: boolean;
                        /** @description The caller is entitled to the feed. */
                        available: boolean;
                        /** @description The caller has a live provider connection. */
                        connected: boolean;
                        syncs: {
                            /** Format: uuid */
                            id: string;
                            /** Format: uuid */
                            user_id: string;
                            /** @example fortnox */
                            provider: string;
                            payment_id: string;
                            /** @description The provider-side reference once pushed. */
                            external_ref: string | null;
                            /** @enum {string} */
                            status: "pending" | "pushed" | "failed" | "skipped";
                            error: string | null;
                            attempts: number;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                        }[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    syncReportingFeed: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Rows fed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        fed: number;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The reporting feed is not available for this caller. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    verifyReportingInvoice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Haven payment id. */
                paymentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The provider's verdict. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description The invoice exists in Fortnox under our external_ref. */
                        registered: boolean;
                        /**
                         * @description Why registered is false. 'deleted' = the number 404s; 'foreign_invoice' = an invoice exists at that number but carries someone else's ExternalInvoiceNumber (a company-switch collision). Null when registered. Both mean OUR record was never delivered under our ref — but an audit trail must not say 'no longer exists' about an invoice that does.
                         * @enum {string|null}
                         */
                        missing: "deleted" | "foreign_invoice" | null;
                        /** @description A human has booked it. Null when not registered. */
                        booked: boolean | null;
                        /** @description Registered but struck. Null when not registered. */
                        cancelled: boolean | null;
                        invoice_number: number;
                        /** @description `<series><number> <year>` once booked, e.g. "A123 2026". Null until then. */
                        voucher: string | null;
                        invoice_date: string | null;
                        total: number | null;
                        /** Format: date-time */
                        checked_at: string;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The reporting feed is not available for this caller. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not verifiable — not pushed, not connected, or no invoice reference. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        /** @enum {string} */
                        error_code: "not_pushed" | "not_connected" | "no_invoice_ref";
                        status?: string | null;
                    };
                };
            };
        };
    };
    reopenReportingPush: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Haven payment id. */
                paymentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Row reopened for retry. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        reopened: true;
                        payment_id: string;
                        next: string;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The reporting feed is not available for this caller. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Refused, nothing written — the invoice still exists, the row is not pushed, or it moved under us. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        /** @enum {string} */
                        error_code: "not_pushed" | "not_connected" | "no_invoice_ref" | "invoice_exists";
                        invoice_number?: number;
                    };
                };
            };
        };
    };
    getFortnoxStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Connection metadata. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        configured: false;
                        /** @enum {boolean} */
                        connected: false;
                        legacyBookkeeping: boolean;
                    } | {
                        /** @enum {boolean} */
                        configured: true;
                        connected: boolean;
                        /** @description The granted OAuth scope. Null until connected. */
                        scope: string | null;
                        /** @description Access-token expiry. Null until connected. */
                        expiresAt: string | null;
                        legacyBookkeeping: boolean;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getFortnoxConnectUrl: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The consent URL. Carries no token material. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        url: string;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Fortnox is not configured on this deployment. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    startFortnoxConnect: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redirect to the Fortnox consent screen. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Fortnox is not configured on this deployment. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    fortnoxOAuthCallback: {
        parameters: {
            query?: {
                /** @description Authorization code from Fortnox. */
                code?: string;
                /** @description The signed, purpose-scoped state this flow issued. */
                state?: string;
                /** @description Present when the user declined consent. */
                error?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Always a redirect to the settings page: ?fortnox=connected, ?fortnox=denied, or ?fortnox=error. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    disconnectFortnox: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Disconnected (or was never connected). */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    pushFortnoxVouchers: {
        parameters: {
            query?: {
                /** @description ISO date. */
                from?: string;
                /** @description ISO date. */
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Per-entry outcome of the push. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        pushed: number;
                        /** @description Entries with no book-time SEK amount — unbookable, not errors. */
                        skipped: number;
                        failed: number;
                        failures: {
                            paymentId: string;
                            error: string;
                        }[];
                    };
                };
            };
            /** @description Malformed date, or Fortnox is not connected. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The default: pushing finished vouchers is retired in favour of the draft feed. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createHybridAccount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Defaults to Base Sepolia while delegation onboarding is dark-launched. */
                    chain_id?: number;
                    /** @description Display label; defaults to 'My account'. */
                    name?: string;
                    /**
                     * @description EOA owner. Must not be the zero address.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    owner_address?: string;
                    passkeys?: {
                        key_id: string;
                        /** @description P256 public-key x coordinate. */
                        x: string;
                        /** @description P256 public-key y coordinate. */
                        y: string;
                    }[];
                    /** @description Accepted and recorded as history, but REQUIRED FOR NOTHING (#1153) — sending it changes no outcome and omitting it changes no outcome. Kept on the request shape so existing clients keep working. */
                    single_signer_waiver?: {
                        acknowledged?: boolean;
                    };
                };
            };
        };
        responses: {
            /** @description Account row recorded. Counterfactual — nothing was deployed. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        /** @example 0x1111111111111111111111111111111111111111 */
                        account_address: string;
                        chain_id: number;
                        /** @enum {string} */
                        account_type: "delegator_hybrid";
                        /**
                         * @description Always false here — deployment rides the first sponsored operation.
                         * @enum {boolean}
                         */
                        deployed: false;
                        /** Format: date-time */
                        created_at: string;
                    };
                };
            };
            /** @description Bad owner configuration, or a chain the delegation rail does not serve. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description This account is already registered for the caller. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The account address could not be derived. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getHybridAccountSigners: {
        parameters: {
            query?: {
                /** @description Required — the (address, chain) pair identifies the account. */
                chain_id?: string;
            };
            header?: never;
            path: {
                /** @description The hybrid account address. */
                address: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The signer set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HybridAccountSigners"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The account signer configuration is unknown. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    prepareHybridSignerChange: {
        parameters: {
            query?: {
                /** @description Required — the (address, chain) pair identifies the account. */
                chain_id?: string;
            };
            header?: never;
            path: {
                /** @description The hybrid account address. */
                address: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action: "add_passkey" | "remove_passkey" | "add_owner" | "remove_owner";
                    /** @description Required for add_passkey/remove_passkey. */
                    passkey?: {
                        key_id?: string;
                        x?: string;
                        y?: string;
                    };
                    /**
                     * @description Required for add_owner.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    owner_address?: string;
                    /** @enum {string} */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                };
            };
        };
        responses: {
            /** @description Prepared change, shaped by the signature scheme. Carries no treasury_address. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        signature_scheme: "eip712_userop";
                        signing_payload: {
                            [key: string]: unknown;
                        };
                        user_operation: {
                            [key: string]: unknown;
                        };
                        instructions: string;
                    } | {
                        /** @enum {string} */
                        signature_scheme: "webauthn_userop";
                        user_op_hash: string;
                        user_operation: {
                            [key: string]: unknown;
                        };
                        instructions: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitHybridSignerChange: {
        parameters: {
            query?: {
                /** @description Required — the (address, chain) pair identifies the account. */
                chain_id?: string;
            };
            header?: never;
            path: {
                /** @description The hybrid account address. */
                address: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    action?: "add_passkey" | "remove_passkey" | "add_owner" | "remove_owner";
                    /** @description Required for add_passkey/remove_passkey. */
                    passkey?: {
                        key_id?: string;
                        x?: string;
                        y?: string;
                    };
                    /**
                     * @description Required for add_owner.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    owner_address?: string;
                    /** @enum {string} */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                    signature: string;
                    user_operation: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Signer set updated on-chain and in storage. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        updated: boolean;
                        tx_hash: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    prepareHybridTransfer: {
        parameters: {
            query?: {
                /** @description Required — the (address, chain) pair identifies the account. */
                chain_id?: string;
            };
            header?: never;
            path: {
                /** @description The hybrid account address. */
                address: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    token_address: string;
                    /**
                     * @description Recipient.
                     * @example 0x1111111111111111111111111111111111111111
                     */
                    to: string;
                    /** @description Atomic units. */
                    amount_atomic: string;
                    /** @enum {string} */
                    signature_scheme?: "eip712_userop" | "webauthn_userop";
                };
            };
        };
        responses: {
            /** @description Prepared transfer, shaped by the signature scheme. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {string} */
                        signature_scheme: "eip712_userop";
                        signing_payload: {
                            [key: string]: unknown;
                        };
                        user_operation: {
                            [key: string]: unknown;
                        };
                        instructions: string;
                    } | {
                        /** @enum {string} */
                        signature_scheme: "webauthn_userop";
                        user_op_hash: string;
                        user_operation: {
                            [key: string]: unknown;
                        };
                        instructions: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Money-path rate limit. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitHybridTransfer: {
        parameters: {
            query?: {
                /** @description Required — the (address, chain) pair identifies the account. */
                chain_id?: string;
            };
            header?: never;
            path: {
                /** @description The hybrid account address. */
                address: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    token_address?: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    to?: string;
                    amount_atomic?: string;
                    signature: string;
                    user_operation: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description Transfer submitted on-chain. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        submitted: boolean;
                        tx_hash: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Money-path rate limit. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    signup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Trimmed; control characters are rejected. */
                    name: string;
                    email: string;
                    password: string;
                };
            };
        };
        responses: {
            /** @description Account created; the token is valid for 7 days. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        token: string;
                        user: {
                            /** Format: uuid */
                            id: string;
                            name: string | null;
                            email: string;
                            wallet_address: string | null;
                            safe_address: string | null;
                            currency_preference: string;
                            safes: {
                                /** Format: uuid */
                                id: string;
                                /** @example 0x1111111111111111111111111111111111111111 */
                                safe_address: string;
                                chain_id: number;
                                name: string;
                                is_default: boolean;
                                /** Format: date-time */
                                created_at: string;
                                account_type: string | null;
                                /** @description Derived from the chain — is real value at stake here. */
                                value_bearing_chain: boolean;
                                /** @description Delegation-rail accounts only (null otherwise): whether to RECOMMEND a backup signer. A recommendation, never a gate (#1153) — nothing refuses a single-signer account. */
                                needs_backup_recommendation: boolean | null;
                            }[];
                        };
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description An account with this email already exists. A deliberate, documented enumeration disclosure — see this operation's description (#1654). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Rate limited (10/min per client address, #1670) — only in deployments with a trusted proxy. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    email: string;
                    password: string;
                };
            };
        };
        responses: {
            /** @description Session established. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        token: string;
                        user: {
                            /** Format: uuid */
                            id: string;
                            name: string | null;
                            email: string;
                            wallet_address: string | null;
                            safe_address: string | null;
                            currency_preference: string;
                            safes: {
                                /** Format: uuid */
                                id: string;
                                /** @example 0x1111111111111111111111111111111111111111 */
                                safe_address: string;
                                chain_id: number;
                                name: string;
                                is_default: boolean;
                                /** Format: date-time */
                                created_at: string;
                                account_type: string | null;
                                /** @description Derived from the chain — is real value at stake here. */
                                value_bearing_chain: boolean;
                                /** @description Delegation-rail accounts only (null otherwise): whether to RECOMMEND a backup signer. A recommendation, never a gate (#1153) — nothing refuses a single-signer account. */
                                needs_backup_recommendation: boolean | null;
                            }[];
                        };
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Invalid email or password — one answer for both, on purpose. */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Rate limited (30/min per client address, #1670) — only in deployments with a trusted proxy. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The session. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        name: string | null;
                        email: string;
                        wallet_address: string | null;
                        safe_address: string | null;
                        currency_preference: string | null;
                        /** Format: date-time */
                        created_at: string;
                        safes: {
                            /** Format: uuid */
                            id: string;
                            /** @example 0x1111111111111111111111111111111111111111 */
                            safe_address: string;
                            chain_id: number;
                            name: string;
                            is_default: boolean;
                            /** Format: date-time */
                            created_at: string;
                            account_type: string | null;
                            /** @description Derived from the chain — is real value at stake here. */
                            value_bearing_chain: boolean;
                            /** @description Delegation-rail accounts only (null otherwise): whether to RECOMMEND a backup signer. A recommendation, never a gate (#1153) — nothing refuses a single-signer account. */
                            needs_backup_recommendation: boolean | null;
                        }[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The account no longer exists. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listPasskeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Enrolled passkeys. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        passkeys: {
                            /** Format: uuid */
                            id: string;
                            credential_id: string;
                            signer_address: string;
                            chain_id: number;
                            /** @description Null until the passkey is bound to a Safe. */
                            safe_address: string | null;
                            /** Format: date-time */
                            created_at: string;
                        }[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    registerPasskey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Non-empty base64url. */
                    credential_id: string;
                    /** @description 32-byte 0x-hex. */
                    public_key_x: string;
                    /** @description 32-byte 0x-hex. */
                    public_key_y: string;
                    chain_id: number;
                    /** @description Optional base64url attestation. Stored, not yet verified. */
                    raw_attestation_object?: string;
                };
            };
        };
        responses: {
            /** @description Passkey enrolled. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** Format: uuid */
                        id: string;
                        credential_id: string;
                        /** @description Derived from the public key; stored lowercase. */
                        signer_address: string;
                        chain_id: number;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description This credential is already registered. Note: a SECOND passkey on the same chain is NOT a conflict. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getAgentActivity: {
        parameters: {
            query?: {
                /** @description Capped at 100. */
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                /** @description Agent id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Merged activity, newest first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        activity: ({
                            /** @enum {string} */
                            type: "payment";
                            id: string;
                            token: string | null;
                            amount_raw?: string | null;
                            amount: string | null;
                            to: string | null;
                            status: string | null;
                            tx_hash?: string | null;
                            payment_id?: string;
                            payment_proof_status?: string | null;
                            /** @description Derived from the payment lifecycle. */
                            payment_flow_status?: string | null;
                            /** @description Derived: why this payment needs a human look, if it does. */
                            payment_attention_reason?: string | null;
                            /** @description Falls back to 'direct'. */
                            source?: string;
                            x402_resource_url?: string | null;
                            x402_merchant_address?: string | null;
                            chain_id?: number | null;
                            token_address?: string | null;
                            safe_id?: string | null;
                            safe_address?: string | null;
                            safe_name?: string | null;
                            /** @description Null exactly when tx_hash is null. */
                            explorer_url?: string | null;
                            /** @description Which on-chain mechanism moved the money (#799). */
                            execution_rail?: string | null;
                            session_permission_id?: string | null;
                            /** @description Which delegation authorized a delegation-rail payment (#829). */
                            delegation_hash?: string | null;
                            confirmed_at?: string | null;
                            created_at: string;
                            /** @description Feed only — the per-agent list already knows the agent. */
                            agent_id?: string;
                            /** @description Feed only; 'Unknown' when the agent row is gone. */
                            agent_name?: string;
                        } | {
                            /** @enum {string} */
                            type: "approval";
                            id: string;
                            token: string | null;
                            amount: string | null;
                            to: string | null;
                            reason?: string | null;
                            status: string | null;
                            tx_hash?: string | null;
                            /** @description Synthesised when absent: an executed approval reports 'payment_confirmed'. */
                            payment_proof_status?: string | null;
                            payment_flow_status?: string | null;
                            payment_attention_reason?: string | null;
                            source?: string;
                            x402_resource_url?: string | null;
                            chain_id?: number | null;
                            token_address?: string | null;
                            safe_id?: string | null;
                            safe_address?: string | null;
                            safe_name?: string | null;
                            explorer_url?: string | null;
                            created_at: string;
                            /** @description Feed only. */
                            agent_id?: string;
                            /** @description Feed only. */
                            agent_name?: string;
                        } | {
                            /** @enum {string} */
                            type: "mcp_tool_call";
                            id: string;
                            tool_name: string;
                            /** @description Set when the call created or advanced a payment. */
                            payment_id?: string | null;
                            result_status?: string | null;
                            next_action?: string | null;
                            error_code?: string | null;
                            status_code?: number | null;
                            created_at: string;
                            /** @description Feed only. */
                            agent_id?: string;
                            /** @description Feed only. */
                            agent_name?: string;
                        })[];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No such agent for this caller. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getAgentStats: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Agent id. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Spend totals and the pending count. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        all_time: {
                            token: string | null;
                            total_spent: string | null;
                            tx_count: number;
                        }[];
                        today: {
                            token: string | null;
                            total_spent: string | null;
                            tx_count: number;
                        }[];
                        this_week: {
                            token: string | null;
                            total_spent: string | null;
                            tx_count: number;
                        }[];
                        /** @description Always 0 since #2055 — the approval queue died with the Safe rail; kept for wire compatibility. */
                        pending_approvals: number;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No such agent for this caller. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getActivityFeed: {
        parameters: {
            query?: {
                /** @description Capped at 100. */
                limit?: number;
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Merged cross-agent activity plus the actionable-approval count. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        activity: ({
                            /** @enum {string} */
                            type: "payment";
                            id: string;
                            token: string | null;
                            amount_raw?: string | null;
                            amount: string | null;
                            to: string | null;
                            status: string | null;
                            tx_hash?: string | null;
                            payment_id?: string;
                            payment_proof_status?: string | null;
                            /** @description Derived from the payment lifecycle. */
                            payment_flow_status?: string | null;
                            /** @description Derived: why this payment needs a human look, if it does. */
                            payment_attention_reason?: string | null;
                            /** @description Falls back to 'direct'. */
                            source?: string;
                            x402_resource_url?: string | null;
                            x402_merchant_address?: string | null;
                            chain_id?: number | null;
                            token_address?: string | null;
                            safe_id?: string | null;
                            safe_address?: string | null;
                            safe_name?: string | null;
                            /** @description Null exactly when tx_hash is null. */
                            explorer_url?: string | null;
                            /** @description Which on-chain mechanism moved the money (#799). */
                            execution_rail?: string | null;
                            session_permission_id?: string | null;
                            /** @description Which delegation authorized a delegation-rail payment (#829). */
                            delegation_hash?: string | null;
                            confirmed_at?: string | null;
                            created_at: string;
                            /** @description Feed only — the per-agent list already knows the agent. */
                            agent_id?: string;
                            /** @description Feed only; 'Unknown' when the agent row is gone. */
                            agent_name?: string;
                        } | {
                            /** @enum {string} */
                            type: "approval";
                            id: string;
                            token: string | null;
                            amount: string | null;
                            to: string | null;
                            reason?: string | null;
                            status: string | null;
                            tx_hash?: string | null;
                            /** @description Synthesised when absent: an executed approval reports 'payment_confirmed'. */
                            payment_proof_status?: string | null;
                            payment_flow_status?: string | null;
                            payment_attention_reason?: string | null;
                            source?: string;
                            x402_resource_url?: string | null;
                            chain_id?: number | null;
                            token_address?: string | null;
                            safe_id?: string | null;
                            safe_address?: string | null;
                            safe_name?: string | null;
                            explorer_url?: string | null;
                            created_at: string;
                            /** @description Feed only. */
                            agent_id?: string;
                            /** @description Feed only. */
                            agent_name?: string;
                        } | {
                            /** @enum {string} */
                            type: "mcp_tool_call";
                            id: string;
                            tool_name: string;
                            /** @description Set when the call created or advanced a payment. */
                            payment_id?: string | null;
                            result_status?: string | null;
                            next_action?: string | null;
                            error_code?: string | null;
                            status_code?: number | null;
                            created_at: string;
                            /** @description Feed only. */
                            agent_id?: string;
                            /** @description Feed only. */
                            agent_name?: string;
                        })[];
                        /** @description Always 0 since #2055 — the approval queue died with the Safe rail; kept for wire compatibility. */
                        pending_approvals: number;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getOnboardingFunnel: {
        parameters: {
            query?: {
                /** @description Date; defaults to 30 days before `to`. */
                from?: string;
                /** @description Date; defaults to now. */
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Funnel counts and median TTFP. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        steps: {
                            /** @enum {string} */
                            event: "signed_up" | "safe_deployed" | "safe_imported" | "agent_created" | "allowance_granted" | "safe_funded" | "first_payment_settled";
                            /** @description DISTINCT users who reached this step. */
                            users: number;
                            /** @description Null when there is nothing to convert from: the first step, or any step whose predecessor counted zero users. */
                            conversionFromPrev: number | null;
                        }[];
                        /** @description Median signup→first-settled-payment in ms. Null when nobody has completed it in the window. */
                        medianTtfpMs: number | null;
                        /**
                         * Format: date-time
                         * @description The resolved window start.
                         */
                        from: string;
                        /**
                         * Format: date-time
                         * @description The resolved window end.
                         */
                        to: string;
                    };
                };
            };
            /** @description Unparseable dates, or from is not before to. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getChains: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The chain registry for this deployment. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Chains this environment will provision on. */
                        deployable: number[];
                        /** @description Chains the code knows about at all. */
                        supported: number[];
                    };
                };
            };
        };
    };
    settleX402Payment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Payment intent id from authorize. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description The delegate EIP-712 signature over the settlement child. */
                    signature: string;
                };
            };
        };
        responses: {
            /** @description Settled; retry the merchant with payment_header. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        payment_id: string;
                        /** @enum {string} */
                        status: "submitted";
                        /** @description The merchant X-PAYMENT header. Single-use and bound to this amount and merchant. */
                        payment_header: string;
                        resource_url?: string | null;
                        /** @description Optional passport reference for the paying agent. */
                        passport?: unknown;
                    };
                };
            };
            /** @description A delegate signature is required. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payment not found. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Not a delegation-rail settlement, or not awaiting a signature. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Money-path rate limit. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Settlement state was lost — re-authorize. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    pauseAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paused. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No such agent for this caller, or it cannot be paused from its current state. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    resumeAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Resumed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No such agent for this caller, or it cannot be resumed from its current state. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    rotateAgentKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The new key. Store it now. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @description Plaintext, shown once. */
                        api_key: string;
                        /** @description The prefix Haven keeps for display. */
                        api_key_prefix: string;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The agent is not active. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    setAgentAllowance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": {
                    [key: string]: unknown;
                };
            };
        };
        responses: {
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Always. The Safe rail is retired; grant a budget delegation instead. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteAgentAllowance: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["AgentId"];
                tokenAddress: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Always, for a well-formed token address. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPaymentEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                paymentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The evidence record. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        evidence: {
                            /** @description Resolved from the payment intent id, else the approval request id. */
                            payment_id: string | null;
                        } & {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            /** @description Malformed paymentId. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description No evidence for this payment. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createAgentConnectionSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentConnectionSetupRequest"];
            };
        };
        responses: {
            /** @description Pending setup created. The setup_token is returned once and should be passed to the local connector. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateAgentConnectionSetupResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    resolveAgentConnectionSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveAgentConnectionSetupRequest"];
            };
        };
        responses: {
            /** @description Public setup details and proof-of-possession challenge. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResolveAgentConnectionSetupResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    registerAgentConnectionSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RegisterAgentConnectionSetupRequest"];
            };
        };
        responses: {
            /** @description Public signing address registered. Payment tools remain unavailable until wallet approval activates the agent. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RegisterAgentConnectionSetupResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getAgentConnectionSetup: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                setupId: components["parameters"]["SetupId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Recoverable setup status for the Haven UI. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentConnectionSetupStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    updateAgentConnectionInstallStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                setupId: components["parameters"]["SetupId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateConnectorInstallStatusRequest"];
            };
        };
        responses: {
            /** @description Install status updated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpdateConnectorInstallStatusResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getAgentConnectionConnectorStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                setupId: components["parameters"]["SetupId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current setup status for the polling connector. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentConnectionConnectorStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    recordAgentConnectionWalletApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                setupId: components["parameters"]["SetupId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecordAgentConnectionWalletApprovalRequest"];
            };
        };
        responses: {
            /** @description Wallet approval was recorded and the setup status was returned. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentConnectionSetupStatus"];
                };
            };
            /** @description Confirmation evidence was recorded, but on-chain authority is not verified yet. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentConnectionSetupStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    recordAgentConnectionBudgetApproval: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                setupId: components["parameters"]["SetupId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The budget was confirmed and the setup status was returned. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentConnectionSetupStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    cancelAgentConnectionSetup: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                setupId: components["parameters"]["SetupId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Setup cancelled. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SuccessResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listAgentPayments: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Recent payment intents. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        payments: components["schemas"]["PaymentListItem"][];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
        };
    };
    createPaymentIntent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreatePaymentRequest"];
            };
        };
        responses: {
            /** @description Idempotent replay of a request whose intent has already progressed to a terminal, reportable state. Body is an `AgentPaymentStatus` plus `idempotent_replay: true`. Deliberately NOT a strict $ref: `AgentPaymentStatus` is `additionalProperties: false`, so the replay marker is not a member of it — the permissive shape is the accurate one here, and narrowing it would be a claim the route does not honour. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Payment intent requires the agent signature. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignablePaymentIntent"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Idempotency conflict: the key already belongs to a payment with a different token, recipient or amount, or it replays an intent that is mid-flight (pending_signature / submitted). Only `payment_intents` carry the key — the approval-queue replay fallback is gone with the table (#2055). */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description EITHER a retired rail — the Safe / AllowanceModule rail (#1986) or the session rail (#834), refused before anything is written and before any chain read, with a message naming POST /accounts/hybrid — OR an idempotent replay of a request whose intent has since expired. The two are distinguished by `idempotent_replay` on the body; only the first is a rail refusal. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Money-path rate limit. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Preparation failed against the chain, or an idempotent replay of a request whose payment has failed. */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPaymentIntent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["PaymentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Payment intent status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentIntentStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitPaymentSignature: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["PaymentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    signature: string;
                };
            };
        };
        responses: {
            /** @description Payment execution result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentExecutionResult"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The intent is pinned to a retired rail — the AllowanceModule rail (#1986) or the session rail (#834) — or it has expired. A retired-rail intent is refused before the expiry flip, so nothing is written. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPaymentReceipt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["PaymentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Receipt bundle and verification result. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        receipt?: {
                            [key: string]: unknown;
                        };
                        verification?: {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getPaymentResumeState: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["PaymentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Serializable x402 or MPP resume state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PaymentResumeState"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    authorizeX402Payment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["X402AuthorizeRequest"];
            };
        };
        responses: {
            /** @description Existing or resumed x402 state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Signable or confirmed x402 funding payment. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Spend authority the agent does not have. Either it holds no active budget delegation for this token/merchant, or (#2082) the erc7710 direct-settlement amount exceeds that delegation's live remaining period budget. The over-budget refusal is PRE-FUNDING — no settlement child is built, no intent row is written, no delegate account is deployed — and carries error_code "delegation_budget_exceeded", phase "insufficient_funds", next_action "fund_safe_or_raise_allowance", plus remaining/remaining_atomic, amount/amount_atomic and shortfall/shortfall_atomic. It is a fail-fast convenience, not the gate: the budget delegation's ERC20PeriodTransferEnforcer still refuses an over-budget redemption on-chain, and a degraded budget read fails OPEN (the payment proceeds). */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description A retired rail: the Safe / AllowanceModule rail (#1986) or the session rail (#834). Fail-closed — nothing is written and no chain read is made. The message names POST /accounts/hybrid. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getX402SignContext: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Payment intent id from the quote/authorize response. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The rebuilt sign_data + complete snake_case x402_expected context (field-for-field as signed). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getX402MerchantCallContext: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Payment intent id from the quote/authorize response. */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The stored merchant call context. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402MerchantCallContext"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    authorizeX402PaymentLegacy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["X402AuthorizeRequest"];
            };
        };
        responses: {
            /** @description Same response as POST /x402/authorize. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Same response as POST /x402/authorize. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Same as POST /x402/authorize: a retired rail — Safe / AllowanceModule (#1986) or session (#834). Fail-closed, nothing written. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getMachinePaymentAgent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent identity for machine-payment tools. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachinePaymentAgent"];
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
        };
    };
    getMachinePaymentAllowances: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Configured and remaining spend authority for the account's rail. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AllowanceSummary"];
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description The account is on a RETIRED rail — session (#993) or Safe/AllowanceModule (#2020, reversing #1986’s left-readable decision on the recorded owner call: the accounts are emptied and unsupported, so no state is read). Fail-closed; nothing is read or written. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    authorizeMachinePayment: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["MachinePaymentAuthorizeRequest"];
            };
        };
        responses: {
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description The mpp_demo flow is retired (#1328) — no new legacy MPP demo challenge can be authorized. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getMachinePaymentStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: components["parameters"]["PaymentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent payment status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    sendTransfer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Asset to send.
                     * @enum {string}
                     */
                    asset: "ETH" | "USDC";
                    /** @description Recipient address (checksummed or lowercase). */
                    recipient: string;
                    /** @description Human-readable amount, e.g. "1.5". */
                    amount: string;
                    /** @description Validated (1–128 characters) and then IGNORED — nothing is deduplicated, because every call refuses. Accepted only so an existing client is refused by the rail rather than by a body error (#2105). */
                    idempotency_key?: string;
                };
            };
        };
        responses: {
            /** @description Body validation, in `routes/machine-payments.ts` and therefore BEFORE the rail refusal: unsupported asset, malformed recipient, non-positive amount, or an idempotency_key outside 1–128 characters. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description The account is on a retired rail — Safe / AllowanceModule (#1986) or session (#834). Fail-closed: nothing is written and no chain read is made. The message names POST /accounts/hybrid. */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description The account is on the delegation rail, which this MPP route never supported (#1251). `error_code` is `rail_not_supported` and the message names POST /payments and the x402 purchase flow. With both retired rails answering 410 above, this is the response every remaining account gets. */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Money-path rate limit. */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listMachinePaymentReceipts: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Machine-payment receipts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        receipts: components["schemas"]["MachinePaymentReceipt"][];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
        };
    };
    attachMachinePaymentEvidence: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MachinePaymentEvidenceRequest"];
            };
        };
        responses: {
            /** @description Evidence accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        evidence: components["schemas"]["MachinePaymentReceipt"];
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    reportMerchantReceipt: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description The payment id (intent or approval) the receipt belongs to. */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description https URL to the merchant receipt document (pdf/png/jpg). */
                    url?: string;
                    /** @description The inline receipt document as provided by the merchant. */
                    json?: {
                        [key: string]: unknown;
                    };
                };
            };
        };
        responses: {
            /** @description A merchant receipt was already recorded for this payment (first write wins). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        stored: boolean;
                        message?: string;
                    };
                };
            };
            /** @description Merchant receipt stored. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        stored: boolean;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    recordMachinePaymentReconciliationEvent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MachinePaymentReconciliationEventRequest"];
            };
        };
        responses: {
            /** @description Reconciliation event recorded. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachinePaymentReconciliationEventResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    prepareDelegateSweep: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Nothing stranded — no authorization to sign. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {boolean} */
                        nothing_stranded: true;
                        /** @example USDC */
                        asset?: string;
                        /** @example 8453 */
                        chain_id: number;
                        message?: string;
                    };
                };
            };
            /** @description Sweep authorization prepared; sign and submit it. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SweepPrepareResponse"];
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    submitDelegateSweep: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SweepSubmitRequest"];
            };
        };
        responses: {
            /** @description Sweep relayed (or idempotent replay of a prior relay). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SweepSubmitResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            502: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listTransactions: {
        parameters: {
            query?: {
                safeId?: string;
                agentId?: string;
                tokenKey?: string;
                offset?: number;
                limit?: number;
                fresh?: "1" | "true";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paginated transactions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TransactionsResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getTransactionFilterOptions: {
        parameters: {
            query?: {
                fresh?: "1" | "true";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Available filter options. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TransactionFilterOptionsResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listSafeTransactions: {
        parameters: {
            query?: {
                chain_id?: number;
                page?: number;
                limit?: number;
                fresh?: "1" | "true";
            };
            header?: never;
            path: {
                safeAddress: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Paginated per-Safe transactions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TransactionsPageResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getDashboardOverview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dashboard overview. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DashboardOverviewResponse"];
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getSafeBalances: {
        parameters: {
            query?: {
                /** @description Required when the same address is linked on more than one chain. */
                chain_id?: number;
            };
            header?: never;
            path: {
                safeAddress: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Balances, native token first. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["BalancesResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getSafePortfolio: {
        parameters: {
            query?: {
                /** @description Required when the same address is linked on more than one chain. */
                chain_id?: number;
            };
            header?: never;
            path: {
                safeAddress: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Portfolio totals and per-token breakdown. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PortfolioResponse"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getSafeDetails: {
        parameters: {
            query?: {
                chain_id?: number;
            };
            header?: never;
            path: {
                safeAddress: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Safe details. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SafeDetails"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listContacts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Contacts, alphabetical by name (LIST_CONTACTS_FOR_USER_SQL orders by name ASC). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        contacts: components["schemas"]["Contact"][];
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    createContact: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description Trimmed before storage; blank after trimming is a 400. */
                    name: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    address: string;
                };
            };
        };
        responses: {
            /** @description Contact created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Contact"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    renameContact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                };
            };
        };
        responses: {
            /** @description Updated contact. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Contact"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    deleteContact: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        success: boolean;
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    listCatalog: {
        parameters: {
            query?: {
                category?: string;
                /** @description Whitespace is trimmed/collapsed. Blank search after trimming returns 400. */
                search?: string;
                rail?: "x402" | "mpp";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Catalog entries. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        entries: components["schemas"]["CatalogEntry"][];
                    };
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
        };
    };
    submitCatalogEntry: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CatalogSubmitRequest"];
            };
        };
        responses: {
            /** @description Submission accepted (or an existing pending submission for the same host). */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogSubmissionAccepted"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getCatalogSubmissionStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Submission status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogSubmissionStatus"];
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
    getCatalogEntry: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Catalog entry. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CatalogEntry"];
                };
            };
            /** @description Error response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Error response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Agent authenticated but not authorized to act (#1130): `agent_pending_approval` — the key is valid but the agent awaits its first budget grant in Haven; `agent_paused` — the owner paused API-initiated transactions. `detail` carries the operator action. Contrast 401, which means the key itself is unknown or revoked. */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        detail?: string;
                    };
                };
            };
            /** @description Error response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        error: string;
                        statusCode?: number;
                        details?: string;
                    } & {
                        [key: string]: unknown;
                    };
                };
            };
        };
    };
}
