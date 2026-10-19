import AgentPanel from '@/components/AgentPanel'
import { PageHeader } from '@/components/ui/PageHeader'

export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Agents"
        subtitle="Agents pay for things up to a budget you set. You approve each budget yourself, and anything over it is refused on-chain."
      />

      <AgentPanel />
    </div>
  )
}
