// #3251: no connect test may reach the developer's real home. Every writer
// that defaults to ~/.haven (the tombstone ledger, the agents root, runtime
// configs) resolves homedir() at call time, so pointing HOME/USERPROFILE at a
// per-worker scratch directory turns a forgotten override into a write into
// that scratch directory instead of ~/.haven. TMPDIR moves too: a ledger is
// written beside a credential root, so a test whose agent directory sits
// directly under a mkdtemp() root writes `<tmpdir>/tombstones` — per worker
// here, never a directory shared across runs. Runs in each test worker before
// any test module is imported.
import { mkdirSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const realHome = homedir()
const scratchHome = mkdtempSync(join(tmpdir(), 'haven-connect-test-home-'))
process.env.HOME = scratchHome
process.env.USERPROFILE = scratchHome
const scratchTmp = join(scratchHome, 'tmp')
mkdirSync(scratchTmp)
process.env.TMPDIR = scratchTmp
process.env.TMP = scratchTmp
process.env.TEMP = scratchTmp
// Exposed so the isolation test can prove the redirect took effect.
process.env.HAVEN_CONNECT_TEST_REAL_HOME = realHome
