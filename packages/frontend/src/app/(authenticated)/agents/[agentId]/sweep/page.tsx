import SweepClient from './SweepClient'

export default async function SweepPage({
  params,
}: {
  params: Promise<{ agentId: string }>
}) {
  const { agentId } = await params
  return <SweepClient agentId={agentId} />
}
