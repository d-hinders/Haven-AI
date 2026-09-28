/**
 * #3412 — one upgrade command, two owners that cannot import each other.
 *
 * `@haven_ai/core`'s `upgradeCommandFor` feeds the backend's
 * `client_update.upgrade_command` and the public release/compat block
 * (`/discovery`, `/.well-known/haven.json`). `@haven_ai/sdk`'s
 * `connectorUpgradeCommand` feeds every upgrade hint the published signer and
 * the hosted MCP emit. Core is workspace-private and does not depend on the
 * SDK, so it carries a copy; the backend depends on both, which makes it the
 * one place the two can be compared. A disagreement means a refused client and
 * a signer refusal would name different commands for the same fix.
 */
import { describe, expect, it } from 'vitest'
import { upgradeCommandFor } from '@haven_ai/core'
import { connectorUpgradeCommand } from '@haven_ai/sdk'

const CONNECTOR_INSTALLED = ['@haven_ai/signer', '@haven_ai/mcp', '@haven_ai/connect'] as const

describe('connector upgrade command parity (#3412)', () => {
  for (const channel of ['alpha', 'dev', 'latest']) {
    it(`core's upgradeCommandFor matches the SDK's connectorUpgradeCommand on @${channel}`, () => {
      for (const pkg of CONNECTOR_INSTALLED) {
        expect(upgradeCommandFor(pkg, channel)).toBe(connectorUpgradeCommand({ channel }))
      }
    })
  }

  it('is the doctor form, never the bare setup re-run that stops at "Missing --setup"', () => {
    for (const pkg of CONNECTOR_INSTALLED) {
      expect(upgradeCommandFor(pkg, 'alpha')).toMatch(/ --doctor$/)
    }
  })
})
