import AgentPanel from '@/components/AgentPanel'

export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Agents</h1>
        <p className="text-sm text-zinc-500">
          Manage autonomous agents with spending policies
        </p>
      </div>
      <AgentPanel />
    </div>
  )
}
