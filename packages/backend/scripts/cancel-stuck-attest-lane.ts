/**
 * Thin CLI wrapper. The actual logic lives in
 * `packages/backend/src/ops/lane-cancel-command.ts` so it compiles into
 * `dist/` and is runnable in the deployed Railway container — which copies
 * only `dist/` and installs with `--omit=dev`, so neither this `scripts/`
 * directory nor `tsx` exist there. See that file's header for the full
 * account (#1743/#2769) and the deployed-container command. The file the
 * container starts, `src/ops/cancel-stuck-lane.ts`, is never imported: it
 * runs the command on import (#4786).
 *
 * Local/dev callers keep using either name, unchanged:
 *
 *   npm run ops:cancel-stuck-attest -w packages/backend -- <outbound-row-id>
 *   npm run ops:cancel-stuck-lane -w packages/backend -- <outbound-row-id>
 */
import { runCli } from '../src/ops/lane-cancel-command.js'

void runCli()
