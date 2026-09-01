import AgentPanel from '@/components/AgentPanel'
import { PageHeader } from '@/components/ui/PageHeader'

export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Agents"
        subtitle="Connect delegation agents, set their rules, and review historical agent records."
      />

      <AgentPanel />
    </div>
  )
}
