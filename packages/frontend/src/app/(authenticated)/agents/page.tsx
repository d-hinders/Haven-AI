import AgentPanel from '@/components/AgentPanel'
import { PageHeader } from '@/components/ui/PageHeader'

export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Agents"
        subtitle="Connect agents to Haven, set their rules, and control what they can spend."
      />

      <AgentPanel />
    </div>
  )
}
