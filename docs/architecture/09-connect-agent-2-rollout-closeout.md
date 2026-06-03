# Haven - Connect Agent 2 Rollout Closeout

Issue: #237
Date: 2026-06-03

This is the closeout report for taking Connect Agent 2 from internal/beta work
to a guarded rollout path. It does not remove the original Connect Agent flow.

## Ship Decision

Connect Agent 2 can be merged behind opt-in rollout gates after PR CI passes.
The final reviewer pass for this branch completed with no blocking findings.

The safety property is unchanged:

```text
API auth is identity.
Local signature is authority.
On-chain Haven wallet rules are enforcement.
```

Haven must not hold the user private key, agent private key, or plaintext
Connect Agent 2 API key. The connector generates both local secrets and sends
Haven only public or hashed material.

## Rollout Gates

Frontend:

- `NEXT_PUBLIC_CONNECT_AGENT_2_ENABLED=true` shows the Connect Agent 2 entry
  point. Unset, `false`, `0`, and `off` keep it hidden.
- The original Connect Agent button remains reachable.

Backend:

- `CONNECT_AGENT_2_ENABLED=true` allows creation of new pending setups. Unset,
  `false`, `0`, and `off` block new setup creation.
- Existing read, install-status, wallet-approval, and cancel endpoints remain
  available so in-progress setups can recover, expire, or be cancelled.

Connector:

- Keep `@haven_ai/connect` treated as beta until runtime install behavior is
  verified across the supported runtimes.

Rollback:

1. Unset `NEXT_PUBLIC_CONNECT_AGENT_2_ENABLED`, or set it to `false`.
2. Unset `CONNECT_AGENT_2_ENABLED`, or set it to `false`.
3. Leave old Connect Agent available.
4. Keep status/cancel recovery endpoints live until pending setups expire or are
   resolved.
5. Ask users with completed on-chain approval to pause/revoke from the agent
   page, or revoke Safe permissions outside Haven if needed.

## Stuck Setup Recovery

`awaiting_connection`:

- User can rerun the connector while the setup token is valid.
- User can cancel from Haven.
- Expiry makes the setup unusable for registration.

`connected_local`:

- User can approve agent rules from Haven without rerunning the connector.
- If runtime config failed, rerun connector repair without rotating the
  registered signing address unless explicitly requested.
- User can cancel before wallet approval; the pending agent API key is revoked.

`approval_in_progress` or `proposed`:

- Do not cancel as setup cleanup. The user should finish approval, wait for
  multisig execution, or manage the agent from the agent page once authority is
  live.
- Haven can reconcile to `active` from live on-chain allowance state.

`active`:

- Use normal pause/revoke flows in Haven.
- Users can also revoke Safe permissions outside Haven.

## Deterministic Coverage

Backend:

- `packages/backend/src/routes/__tests__/agent-connection-setups.test.ts`
  covers pending setup creation, setup-token hashing, resolve scope, proof of
  possession, private-key/API-key rejection, cancelled/expired token rejection,
  pending-agent auth limits, row-locked cancel/approval behavior, idempotent
  activation, multisig proposed state, and on-chain allowance reconciliation.
- The closeout integration test exercises pending setup creation, connector
  public-address registration with proof, user status read of `connected_local`,
  wallet approval evidence, and activation after exact on-chain allowance
  verification.

Connector and signer:

- `packages/connect/src/runtime.test.ts` covers local key generation,
  public-address/proof registration, local API-key generation, credential
  storage, runtime install handoff, and redacted logs.
- `packages/connect/src/config-writers.test.ts` covers existing config
  preservation, hosted MCP config without delegate key, and private env storage
  for Codex bearer tokens.
- `packages/connect/src/storage.test.ts` and
  `packages/connect/src/storage-permissions.test.ts` cover split credential
  files, protected local storage permissions, and cleanup on partial write
  failure.
- `packages/signer/src/*test.ts` covers local signing behavior and signer
  consent/audit behavior.

Frontend:

- `packages/frontend/src/components/__tests__/AgentPanelConnectAgent2.test.tsx`
  covers old Connect Agent reachability and the Connect Agent 2 rollout gate.
- `packages/frontend/src/components/__tests__/ConnectAgent2Modal.test.tsx`
  covers pending setup creation, private-key-free prompts, waiting,
  connected-local, wallet/passkey blockers, approval transaction construction
  with the registered public signing address, multisig proposed state,
  approval-in-progress cancel lockout, manual fallback confirmation, and
  terminal setup statuses.
- `packages/frontend/e2e/connect-agent-2.spec.ts` covers the browser-level
  setup path with mocked API responses under the Playwright desktop and mobile
  projects, including old-flow reachability, keyless setup prompt, transition to
  connected-local, and no private-key text in the modal.

No default CI test requires real funds.

## Sensitive Value Audit

`delegate_key`, `delegatePrivateKey`, `privateKey`, `HAVEN_DELEGATE_KEY`:

- Happy path: must not appear in setup prompt, hosted MCP config, backend
  requests, backend responses, setup status, install status, hosted URLs,
  headers, logs, or deep links.
- Allowed locations: local connector signer credential file, local signer
  process, old Connect Agent/manual fallback after explicit user confirmation,
  and local SDK examples that instruct the user to provide their own key.
- Guards: backend rejects private-key fields in setup/register/install-status
  requests; connector redacts stdout/stderr; hosted MCP refuses delegate-key env.

`sk_agent_*`:

- Happy path plaintext is generated locally by the connector and stored locally.
  Haven receives only hash/prefix.
- Allowed locations: local identity credential file, hosted MCP Bearer header,
  local runtime secret/env reference, and old Connect Agent credential handoff.
- Backend stores hash/prefix only. Pending status is not spend authority.

Setup token:

- Allowed locations: create-setup response, setup prompt, connector command, and
  connector resolve/register requests.
- Backend stores only a hash and short display prefix.
- Token authenticates setup only. It cannot authorize payments or hosted MCP.

Copied prompt contents:

- Happy path prompt may include setup token, backend API URL, runtime, agent
  name, and budget summary.
- Happy path prompt must not include private key, plaintext API key, credential
  JSON, hosted MCP bearer header, or wallet approval transaction data.
- Manual fallback is collapsed by default and requires explicit confirmation.

Generated credential artifacts:

- `identity.json` or env file may contain the local API key.
- `signer.json` may contain the local delegate key.
- Hosted MCP config must not contain the delegate key.
- Local signer config references local protected storage.

Hosted MCP URLs, headers, and deep links:

- Hosted URL can include no secrets.
- Headers may include Bearer `sk_agent_*`.
- Deep links may include hosted URL and API identity where runtime-specific
  behavior is tested, but never the delegate key.

## Operational Status Events

There is no dedicated product analytics package in the current repo. Connect
Agent 2 uses operational status instead:

- setup status: `awaiting_connection`, `connected_local`,
  `approval_in_progress`, `proposed`, `active`, `expired`, `cancelled`,
  `failed`
- install status: hosted MCP configured, local signer configured, credential
  files written, probe result, restart required, next user action, last probe
  time

These fields must not contain private keys, plaintext API keys, raw paths,
usernames, hostnames, or chat transcripts.

## Removal Criteria For Old Flow

Do not remove or demote the original Connect Agent flow until:

- Connect Agent 2 has passed production/beta usage across target runtimes.
- Restart-required guidance is stable.
- Manual fallback support is documented and tested.
- Users can recover stuck setups without support intervention.
- Security review confirms no private-key leakage in prompts, logs, hosted MCP,
  backend requests, or generated artifacts.
- A separate removal issue and PR are opened.

## Current Merge Readiness

CI status:

- Pending until the #237 PR is opened. Green PR CI is required before merge.

Local checks run on this branch:

- `npm run test -w packages/backend -- agent-connection-setups.test.ts agents.test.ts agentAuth.test.ts`
  passed 33 tests.
- `npm run test -w packages/frontend -- ConnectAgent2Modal.test.tsx AgentPanelConnectAgent2.test.tsx useAgentConnectionSetupStatus.test.ts`
  passed 19 tests.
- `npm run test -w packages/connect` passed 14 tests.
- `npm run typecheck -w packages/backend` passed.
- `npm run typecheck -w packages/frontend` passed.
- `npm run typecheck -w packages/connect` passed when rerun in isolation after
  a transient parallel SDK build cleanup race.
- `npm run build -w packages/backend` passed.
- `npm run build -w packages/frontend` passed with the existing wallet-package
  optional-dependency warnings.
- `git diff --check` passed.

Browser/mobile checks:

- `PLAYWRIGHT_PORT=3105 npm run test:e2e -w packages/frontend -- connect-agent-2.spec.ts`
  passed under the Playwright desktop and mobile projects.

Review status:

- Initial `haven-reviewer` pass found blocking issues around rollout gates,
  concrete closeout reporting, deterministic end-to-end coverage, and stale
  architecture docs.
- This branch now makes Connect Agent 2 explicitly opt-in on both frontend and
  backend, adds deterministic backend/frontend/browser coverage, replaces the
  closeout template with this concrete readiness report, and updates the stale
  architecture/migration/signer docs.
- Final reviewer pass completed with no blocking findings.

Risk level:

- Medium behind opt-in gates. Risk becomes high if the gates are enabled broadly
  before beta runtime behavior and support recovery paths are proven.

Why it is safe to merge behind the gates:

- The original Connect Agent flow remains available.
- Unset rollout env hides the Connect Agent 2 entry point and blocks creation of
  new pending setups.
- Haven never receives the delegate private key or plaintext Connect Agent 2
  API key.
- Pending setup, API identity, and hosted MCP access are not spend authority.
- The agent cannot spend until the user signs wallet approval and the on-chain
  Safe AllowanceModule state confirms the delegated budget.
- Deterministic tests cover setup creation, setup-token hashing, proof of
  possession, registration with public/hash material only, connected-local
  status, wallet approval with the registered public address, and old-flow
  reachability.

Residual risk and follow-up:

- PR CI must still pass.
- Browser coverage uses mocked Haven API responses and no real funds.
- Runtime install behavior remains beta until verified across target agent
  environments.
- Old flow removal needs a separate issue, rollout decision, and PR.

Recommended merge order:

- #230, #231/#232, #233/#234, #235/#236, then #237. The earlier issues are
  already merged; #237 should merge last after CI.
