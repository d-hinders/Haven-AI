import AgentPanel from '@/components/AgentPanel'

export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--v2-ink)] mb-1">Agents</h1>
        <p className="text-sm text-[var(--v2-ink-2)]">
          Connect agents to Haven, set their rules, and control what they can spend.
        </p>
      </div>

      <AgentPanel />
    </div>
  )
}
