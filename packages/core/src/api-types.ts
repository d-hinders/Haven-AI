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
         * @description Creates the API identity for an agent. Payment authority still comes from the user-controlled Safe, the agent-held delegate key, and on-chain allowance state.
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
        put?: never;
        post?: never;
        delete?: never;
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
         * @description Creates a signable payment intent or queues an over-budget request for wallet owner approval. The agent must sign returned sign_data with its delegate key before Haven can relay execution.
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
         * @description The signature must be produced outside Haven by the agent-held delegate key. Haven verifies it against the delegate address and on-chain allowance before relaying.
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
         * @description Creates or executes the Haven funding leg for an x402 merchant request. Haven relays only independently signed payloads; it does not sign on behalf of the agent. If approval is required, preserve the original merchant session and resume after next_action is retry_original_x402_request.
         */
        post: operations["authorizeX402Payment"];
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
         * @description Rail-aware (#1135): on the legacy rail this reads the on-chain AllowanceModule per configured token; on the delegation rail the same response shape carries the ACTIVE budget delegations (remaining = the period budget; AllowanceModule-only fields are zeroed placeholders). A retired session-rail account gets 410. Reporting only — enforcement stays on-chain on every rail.
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
         * Authorize an MPP demo machine payment.
         * @description Authorizes the internal MPP demo rail with the same non-custodial boundary as x402: the delegate key signs locally, Haven validates and relays, and on-chain allowance state enforces spend. The current MPP rail is an internal demo surface; production MPP merchant settlement needs separate product and legal review.
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
         * Send ETH or USDC directly from the agent's Safe to a recipient address.
         * @description Creates an AllowanceModule payment intent for a plain transfer. If the amount is within the remaining on-chain allowance, a sign_data hash is returned for the agent to sign (via POST /payments/{id}/sign). If the amount exceeds the remaining allowance, the transfer is queued as a pending_approval for the wallet owner to approve in Haven.
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
         * Attach merchant proof evidence for a confirmed machine payment.
         * @description Records proof-loop evidence after a confirmed x402 or MPP payment. This does not authorize or execute payment; it attaches merchant/protocol evidence to an already confirmed payment or approval request owned by the authenticated agent.
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
    "/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List curated payable services agents can discover and pay.
         * @description Read-only discovery surface. One source of truth consumed by both the dashboard catalog page and the haven_discover_tools MCP tool. Entries are operator-curated and periodically re-verified against the live merchant 402 challenge; nothing here creates payments or signatures.
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
            tool_name?: string | null;
            price_display?: string | null;
            price_atomic?: string | null;
            asset?: string | null;
            network?: string | null;
            /** @description Comma-separated set of x402 assetTransferMethods the merchant advertises (e.g. "eip3009" or "eip3009,erc7710"). Null until the first successful x402 probe; MPP entries stay null. */
            asset_transfer_methods?: string | null;
            /** @enum {string} */
            status: "active" | "degraded" | "delisted";
            verified_at?: string | null;
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
        AgentPaymentNextAction: "sign_and_submit_payment" | "check_status_later" | "none" | "wait_for_user_approval" | "wait_for_user_to_complete_payment" | "retry_original_x402_request" | "stop_and_tell_user" | "request_again_if_user_still_wants_it" | "payment_window_expired" | "fund_safe_or_raise_allowance" | "sweep_stranded_funds";
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
            /** @description Decimal atomic token amount. Leading zeroes are accepted and canonicalized; effective amount must be positive and capped at uint96 for Safe AllowanceModule compatibility. */
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
            allowances: components["schemas"]["AgentAllowance"][];
            mcp_last_seen_at?: string | null;
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
            allowances?: {
                /** @example 0x1111111111111111111111111111111111111111 */
                token_address: string;
                token_symbol: string;
                /** @description Decimal atomic token amount. Leading zeroes are accepted and canonicalized; effective amount must be positive and capped at uint96 for Safe AllowanceModule compatibility. */
                allowance_amount: string;
                reset_period_min: number;
            }[];
        };
        CreateAgentResponse: components["schemas"]["Agent"] & {
            api_key: string;
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
                hash: string;
                components: {
                    /** @example 0x1111111111111111111111111111111111111111 */
                    safe: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    token: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    to: string;
                    /** @description Atomic token amount. */
                    amount: string;
                    /** @example 0x1111111111111111111111111111111111111111 */
                    payment_token: string;
                    payment: string;
                    nonce: number;
                };
                instructions: string;
            };
        };
        PendingApproval: {
            /** Format: uuid */
            payment_id: string;
            /** @enum {string} */
            kind: "approval_request";
            /** @enum {string} */
            status: "pending_approval" | "pending";
            phase: components["schemas"]["AgentPaymentPhase"];
            next_action: components["schemas"]["AgentPaymentNextAction"];
            message: string;
            remaining?: string | null;
            requested?: string;
            token?: string;
            /** Format: date-time */
            expires_at: string;
        } & {
            [key: string]: unknown;
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
            /** @enum {string} */
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
                /** @enum {integer} */
                version: 1;
                /** @description Haven-signed expected x402 context. Includes expiresAt when the funding window is time-bound. */
                message: string;
                signature: string;
                /** @example 0x1111111111111111111111111111111111111111 */
                signer: string;
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
        X402PendingApproval: components["schemas"]["PendingApproval"] & {
            /** @enum {string} */
            rail: "x402";
            /** Format: uri */
            resource_url: string;
            merchant_address?: string | null;
            chain_id: number;
            amount_atomic: string;
            /** @example 0x1111111111111111111111111111111111111111 */
            asset: string;
            network: string;
            idempotency_key?: string | null;
            challenge_id?: string | null;
            x402: components["schemas"]["RailContext"];
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
            chain_id: number;
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
            actionableApprovals: number;
            /** @description Duplicate of actionableApprovals (same query), kept for compatibility. */
            pendingApprovals: number;
            onboardingProgress: {
                hasFirstAgentPayment: boolean;
            };
            /** @description At most 6. */
            agents: components["schemas"]["DashboardAgentPreview"][];
            /** @description At most 5. Payment-enrichment fields (paymentId, paymentFlowStatus, amountSek, …) are never populated in this projection. */
            transactions: components["schemas"]["Transaction"][];
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
                    "application/json": {
                        delegate_address: string;
                        safe_address: string | null;
                        chain_id: number;
                        eth: string;
                        eth_atomic: string;
                        usdc: string;
                        usdc_atomic: string;
                        usdc_address: string | null;
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
            /** @description Payment intent requires the agent signature. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SignablePaymentIntent"];
                };
            };
            /** @description Payment exceeds remaining on-chain allowance and is waiting for wallet owner approval. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PendingApproval"];
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
                    "application/json": components["schemas"]["X402PendingApproval"] | components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Signable or confirmed x402 funding payment. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402PendingApproval"] | components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description x402 funding payment is waiting for wallet owner approval. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402PendingApproval"];
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
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402PendingApproval"] | components["schemas"]["X402SignablePayment"] | components["schemas"]["X402ConfirmedPayment"] | components["schemas"]["AgentPaymentStatus"];
                };
            };
            /** @description Same response as POST /x402/authorize. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["X402PendingApproval"];
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
            /** @description The account is on the retired session rail — no state is read (#993 fail-closed contract). */
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
        requestBody: {
            content: {
                "application/json": components["schemas"]["MachinePaymentAuthorizeRequest"];
            };
        };
        responses: {
            /** @description Existing or completed machine-payment state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachinePaymentAuthorizeResponse"];
                };
            };
            /** @description Signable or confirmed machine payment. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachinePaymentAuthorizeResponse"];
                };
            };
            /** @description Machine payment is waiting for wallet owner approval. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["MachinePaymentAuthorizeResponse"];
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
                    /** @description Optional idempotency key to deduplicate retried requests. */
                    idempotency_key?: string;
                };
            };
        };
        responses: {
            /** @description Idempotent replay of a request whose payment has already progressed (e.g. confirmed, or an approval the owner executed). Body is the canonical payment-status object with idempotent_replay: true. */
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
            /** @description Payment intent created — ready for signing. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        payment_id: string;
                        /** @enum {string} */
                        status: "pending_signature";
                        /** Format: date-time */
                        expires_at: string;
                        /** @enum {string} */
                        asset: "ETH" | "USDC";
                        amount: string;
                        recipient: string;
                        sign_data: {
                            hash: string;
                            components?: Record<string, never>;
                            instructions: string;
                        };
                        /** @description Present and true when this is a replay of an earlier request with the same idempotency_key. */
                        idempotent_replay?: boolean;
                    };
                };
            };
            /** @description Transfer queued as pending_approval — exceeds remaining on-chain allowance. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        payment_id: string;
                        /** @enum {string} */
                        status: "pending_approval";
                        asset: string;
                        amount?: string;
                        recipient?: string;
                        /** Format: date-time */
                        expires_at: string;
                        message?: string;
                        /** @description Present and true when this is a replay of an earlier request with the same idempotency_key. */
                        idempotent_replay?: boolean;
                    } & {
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
            /** @description Idempotent replay of a request that is mid-flight (intent submitted but not yet confirmed) or whose approval was rejected. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        [key: string]: unknown;
                    };
                };
            };
            /** @description Idempotent replay of a request whose payment has expired. */
            410: {
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
    listCatalog: {
        parameters: {
            query?: {
                category?: string;
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
