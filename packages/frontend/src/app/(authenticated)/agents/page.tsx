import AgentPanel from '@/components/AgentPanel'
import { PageHeader } from '@/components/ui/PageHeader'

export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Agents"
        subtitle="Delegation agents use on-chain rules; historical agent records remain readable."
      />

      <AgentPanel />
    </div>
  )
}
