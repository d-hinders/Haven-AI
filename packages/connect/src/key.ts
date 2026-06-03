import crypto from 'node:crypto'
import { Wallet } from 'ethers'

export interface LocalDelegateKey {
  privateKey: string
  address: string
  signChallenge(message: string): Promise<string>
}

export function generateDelegateKey(): LocalDelegateKey {
  return delegateKeyFromPrivateKey(Wallet.createRandom().privateKey)
}

export function delegateKeyFromPrivateKey(privateKey: string): LocalDelegateKey {
  const wallet = new Wallet(privateKey)
  return {
    privateKey: wallet.privateKey,
    address: wallet.address,
    signChallenge: (message: string) => wallet.signMessage(message),
  }
}

export function generateAgentApiKey(): string {
  return `sk_agent_${crypto.randomBytes(24).toString('hex')}`
}

export function hashAgentApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex')
}

export function agentApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, 12)
}
