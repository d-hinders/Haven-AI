Restores byte-for-byte parity between the canonical agent runbook in
`packages/sdk/src/agent-guidance.ts` and the generated copy the CLI embeds at
`packages/cli/src/agent-guidance-text.ts`, and moves the two size assertions in
`packages/cli/src/agent-guidance-text.test.ts` that a content change invalidates
(10,225 → 10,543 UTF-8 bytes; 10,142 → 10,458 UTF-16 code units).

The divergence was introduced by #2713 (Closes #2709), which appended a sentence
to step 2 of the runbook — read `/.well-known/haven.json` before telling the user
which deployment they are on, because `environment` says whether it is
`production` and each `chains.supported` entry says whether that chain is a
`testnet` — without running `packages/cli/scripts/sync-agent-guidance.mjs`. The
generated copy is produced by that script and is not hand-edited here: the copy
in this change is its output, byte-identical to the SDK source it reads.

No authority, custody or settlement surface is touched. The runbook is
INSTRUCTIONAL TEXT printed by `haven guide` and served at `/for-agents.md`; it
confers nothing. Nothing in the diff reaches a rail, enforcer, delegation,
signer, relayer, route, schema or key path — the CLI change is a single string
constant, and the test change is two integers and a comment. The added sentence
itself, already live in the SDK since #2713, makes the agent MORE conservative
about real funds by telling it to distinguish a production non-testnet chain
from a testnet one before asking a human to send money; parity merely stops the
CLI from printing an older version of that advice than the SDK serves.

Recorded because `docs/regulatory/casp-risk-guardrails.md` declares
`packages/cli/src/**` in `covers:`, so the contract-doc gate implicates it on
any change under that path. Perimeter unchanged.
