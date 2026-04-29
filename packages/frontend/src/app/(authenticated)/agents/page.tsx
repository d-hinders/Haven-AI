import AgentPanel from '@/components/AgentPanel'

export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Agenter Allowance Model</h1>
        <p className="text-sm text-zinc-500">
          Give your agents payment capabilities. Each agent below is a set of credentials and on-chain spending limits you hand off to your real agent.
        </p>
      </div>

      <AgentPanel />
    </div>
  )
}
