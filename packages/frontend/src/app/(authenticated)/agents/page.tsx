import AgentPanel from '@/components/AgentPanel'

// #4209: the page header (title, Connect agent and the ⋯ menu) renders inside
// `AgentPanel`, beside the state it reads.
export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <AgentPanel />
    </div>
  )
}
