import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const exitStory = readFileSync(
  path.resolve(process.cwd(), '../../docs/exit/README.md'),
  'utf8',
)

describe('no lock-in: delegation budgets have a backend-independent exit', () => {
  it('keeps the owner-signed disableDelegation exit story', () => {
    expect(exitStory).toContain('disableDelegation')
    expect(exitStory).toContain('DelegationManager')
    expect(exitStory).toMatch(/without\s+Haven's website,\s+servers,\s+or support/)
  })

  it('keeps the account-owner control boundary explicit', () => {
    expect(exitStory).toContain('requires `msg.sender == delegation.delegator`')
    expect(exitStory).toContain("your account's owner signs")
    expect(exitStory).toContain('neither involves Haven')
  })
})
