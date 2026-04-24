'use client'

import { useState, useEffect } from 'react'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { useSelfSignAgents, type SelfSignAgent } from '@/hooks/useSelfSignAgents'
import { truncate } from '@/lib/format'

// ── Icons ──────────────────────────────────────────────────────────

function KeyIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="M21 2l-9.6 9.6M15.5 7.5L19 11l3-3-3.5-3.5" />
    </svg>
  )
}

function PlusIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function TrashIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
    </svg>
  )
}

function CopyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  )
}

function ShieldIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

// ── Create Modal ───────────────────────────────────────────────────

function CreateSelfSignModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (data: { name: string; description?: string; delegate_address: string }) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mode, setMode] = useState<'generate' | 'existing'>('generate')
  const [delegateAddress, setDelegateAddress] = useState('')
  const [generatedKey, setGeneratedKey] = useState<{ privateKey: string; address: string } | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isValidAddress = /^0x[0-9a-fA-F]{40}$/.test(delegateAddress)
  const effectiveAddress = mode === 'generate' ? (generatedKey?.address ?? '') : delegateAddress
  const canSubmit = name.trim() && (mode === 'generate' ? !!generatedKey : isValidAddress)

  function handleGenerate() {
    const pk = generatePrivateKey()
    const account = privateKeyToAccount(pk)
    setGeneratedKey({ privateKey: pk, address: account.address })
    setKeyCopied(false)
  }

  function copyKey() {
    if (!generatedKey) return
    navigator.clipboard.writeText(generatedKey.privateKey)
    setKeyCopied(true)
    setTimeout(() => setKeyCopied(false), 2000)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setLoading(true)
    setError(null)
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        delegate_address: effectiveAddress,
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create agent')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center gap-2 mb-5">
          <ShieldIcon size={18} />
          <h2 className="text-base font-semibold">New Self-Sign Agent</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Name</label>
            <input
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
              placeholder="My signing agent"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Description (optional)</label>
            <input
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-500"
              placeholder="What does this agent do?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Mode toggle */}
          <div>
            <label className="block text-xs text-zinc-400 mb-2">Delegate Wallet</label>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden text-sm">
              <button
                type="button"
                onClick={() => { setMode('generate'); setGeneratedKey(null) }}
                className={`flex-1 px-3 py-2 transition-colors ${mode === 'generate' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Generate new wallet
              </button>
              <button
                type="button"
                onClick={() => setMode('existing')}
                className={`flex-1 px-3 py-2 transition-colors ${mode === 'existing' ? 'bg-zinc-700 text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                Use existing address
              </button>
            </div>
          </div>

          {mode === 'generate' ? (
            <div className="space-y-2">
              {!generatedKey ? (
                <button
                  type="button"
                  onClick={handleGenerate}
                  className="w-full px-4 py-2 text-sm border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors text-zinc-300"
                >
                  Generate keypair
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="bg-zinc-800/60 rounded-lg p-3 border border-zinc-700">
                    <p className="text-xs text-zinc-500 mb-1">Address</p>
                    <p className="font-mono text-xs text-zinc-200 break-all">{generatedKey.address}</p>
                  </div>
                  <div className="bg-amber-900/20 rounded-lg p-3 border border-amber-700/40">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-xs text-amber-400 font-medium">⚠ Private key — save this now</p>
                      <button type="button" onClick={copyKey} className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1">
                        <CopyIcon size={11} />
                        {keyCopied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>
                    <p className="font-mono text-xs text-amber-200/80 break-all">{generatedKey.privateKey}</p>
                    <p className="text-xs text-zinc-500 mt-2">This key will not be shown again. Store it securely.</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    className="text-xs text-zinc-500 hover:text-zinc-300 underline"
                  >
                    Regenerate
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <input
                className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-zinc-500 ${
                  delegateAddress && !isValidAddress ? 'border-red-500' : 'border-zinc-700'
                }`}
                placeholder="0x..."
                value={delegateAddress}
                onChange={(e) => setDelegateAddress(e.target.value)}
              />
              {delegateAddress && !isValidAddress && (
                <p className="text-red-400 text-xs mt-1">Invalid Ethereum address</p>
              )}
              <p className="text-zinc-500 text-xs mt-1">
                The Ethereum address whose private key will sign requests.
              </p>
            </div>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm border border-zinc-700 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !canSubmit}
              className="flex-1 px-4 py-2 text-sm bg-white text-black rounded-lg font-medium hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating…' : 'Create Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Agent Card ─────────────────────────────────────────────────────

function AgentCard({
  agent,
  onRevoke,
  onDelete,
}: {
  agent: SelfSignAgent
  onRevoke: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const isActive = agent.status === 'active'

  function copyAddress() {
    navigator.clipboard.writeText(agent.delegate_address)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`border rounded-xl p-4 space-y-3 ${isActive ? 'border-zinc-700 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/40 opacity-60'}`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${isActive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
          <span className="font-medium text-sm truncate">{agent.name}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 flex-shrink-0">
            self-sign
          </span>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          {isActive && (
            <button
              onClick={onRevoke}
              className="text-xs px-2 py-1 rounded border border-zinc-700 text-zinc-400 hover:text-amber-400 hover:border-amber-400/40 transition-colors"
            >
              Revoke
            </button>
          )}
          <button
            onClick={onDelete}
            className="p-1.5 rounded border border-zinc-700 text-zinc-500 hover:text-red-400 hover:border-red-400/40 transition-colors"
          >
            <TrashIcon />
          </button>
        </div>
      </div>

      {/* Delegate Address */}
      <div className="bg-zinc-800/60 rounded-lg px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs text-zinc-500 mb-0.5">Delegate Address</p>
            <p className="font-mono text-xs text-zinc-300">{agent.delegate_address}</p>
          </div>
          <button
            onClick={copyAddress}
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 transition-colors flex-shrink-0"
            title="Copy address"
          >
            {copied ? (
              <span className="text-emerald-400 text-xs">✓</span>
            ) : (
              <CopyIcon />
            )}
          </button>
        </div>
      </div>

      {/* Auth info */}
      <div className="flex items-center gap-1.5 text-xs text-zinc-500">
        <ShieldIcon size={12} />
        <span>Authenticates via EIP-191 personal_sign — no API key stored</span>
      </div>

      {/* Allowances */}
      {agent.allowances.length > 0 && (
        <div>
          <p className="text-xs text-zinc-500 mb-1.5">Spending limits</p>
          <div className="space-y-1">
            {agent.allowances.map((a) => (
              <div key={a.token_address} className="flex items-center justify-between bg-zinc-800/40 rounded-lg px-3 py-1.5 text-xs">
                <span className="text-zinc-300 font-medium">{a.token_symbol}</span>
                <span className="text-zinc-400 font-mono">
                  {a.allowance_amount}
                  {a.reset_period_min > 0 && (
                    <span className="text-zinc-600"> / {a.reset_period_min}m</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Description */}
      {agent.description && (
        <p className="text-xs text-zinc-500 italic">{agent.description}</p>
      )}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────

export default function SelfSignAgentPanel() {
  const {
    agents,
    loading,
    error,
    fetchAgents,
    createAgent,
    revokeAgent,
    deleteAgent,
  } = useSelfSignAgents()

  const [showCreate, setShowCreate] = useState(false)

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  async function handleCreate(data: {
    name: string
    description?: string
    delegate_address: string
  }) {
    await createAgent(data)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldIcon size={16} />
            <h2 className="text-sm font-semibold">Self-Sign Agents</h2>
          </div>
          <p className="text-xs text-zinc-500 max-w-md">
            Agents that authenticate by signing requests with their Ethereum private key.
            No API key is stored — identity is proven cryptographically.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white text-black rounded-lg font-medium hover:bg-zinc-200 transition-colors"
        >
          <PlusIcon />
          New Agent
        </button>
      </div>

      {/* How it works */}
      <div className="border border-zinc-800 rounded-xl p-4 bg-zinc-900/40">
        <p className="text-xs font-medium text-zinc-400 mb-2 flex items-center gap-1.5">
          <KeyIcon size={13} />
          How self-sign authentication works
        </p>
        <ol className="text-xs text-zinc-500 space-y-1 list-decimal list-inside">
          <li>Register the agent's Ethereum address here</li>
          <li>The agent signs each API request with that wallet's private key</li>
          <li>Backend recovers the signer address from the EIP-191 signature</li>
          <li>If it matches the registered address → request is authorized</li>
        </ol>
        <div className="mt-3 pt-3 border-t border-zinc-800">
          <p className="text-xs text-zinc-600 font-mono">
            Headers required per request:
          </p>
          <div className="mt-1 space-y-0.5 font-mono text-xs text-zinc-500">
            <p>X-Agent-Address: 0x...</p>
            <p>X-Agent-Signature: 0x... (EIP-191)</p>
            <p>X-Agent-Timestamp: 1714000000 (Unix seconds)</p>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {/* Agent list */}
      {loading ? (
        <div className="text-sm text-zinc-500 py-8 text-center">Loading agents…</div>
      ) : agents.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-zinc-800 rounded-xl">
          <ShieldIcon size={24} />
          <p className="mt-3 text-sm text-zinc-500">No self-sign agents yet</p>
          <p className="text-xs text-zinc-600 mt-1">
            Create one to let an Ethereum wallet authenticate without an API key
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onRevoke={() => revokeAgent(agent.id)}
              onDelete={() => deleteAgent(agent.id)}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateSelfSignModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  )
}
