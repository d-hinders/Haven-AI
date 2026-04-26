'use client'

import { useState } from 'react'
import AgentPanel from '@/components/AgentPanel'
import SelfSignAgentPanel from '@/components/SelfSignAgentPanel'

type Tab = 'api-key' | 'self-sign'

export default function AgentsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('api-key')

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Agents</h1>
        <p className="text-sm text-zinc-500">
          Manage autonomous agents with spending policies
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        <button
          onClick={() => setActiveTab('api-key')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'api-key'
              ? 'border-white text-white'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          API Key Agents
        </button>
        <button
          onClick={() => setActiveTab('self-sign')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'self-sign'
              ? 'border-white text-white'
              : 'border-transparent text-zinc-500 hover:text-zinc-300'
          }`}
        >
          Agents SelfSign
        </button>
      </div>

      {activeTab === 'api-key' ? <AgentPanel /> : <SelfSignAgentPanel />}
    </div>
  )
}
