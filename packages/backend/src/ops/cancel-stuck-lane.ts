/**
 * The file an operator starts:
 *
 *   node packages/backend/dist/ops/cancel-stuck-lane.js <outbound-row-id>
 *
 * It starts the CLI unconditionally and exports nothing. What the command
 * does, when to run it and what its exit codes mean are in the header of
 * `./lane-cancel-command.ts`, which holds the code.
 *
 * ## Why there is no "am I the entry point?" test here (#4786)
 *
 * This file used to hold the code as well, and decided whether to start by
 * comparing its own URL with `process.argv[1]`. Node resolves symlinks for
 * the first and not for the second, and leaves the second without the
 * extension when the operator typed none. So the tool printed nothing and
 * exited 0 when it was started by an absolute path through a symlink, from a
 * path with a space, or as `node …/cancel-stuck-lane` — and exit 0 is the
 * code that means "recovery in motion". No comparison of the two paths can
 * cover the missing extension. A file that always starts has no such case.
 *
 * The price is that importing this file runs the command. Import
 * `./lane-cancel-command.js` instead; a test in `scripts/ci` fails on any
 * import of this file.
 */
import { runCli } from './lane-cancel-command.js'

void runCli()
