export default function AgentsPage() {
  return (
    <div className="max-w-5xl">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight mb-1">Agents</h1>
        <p className="text-sm text-zinc-500">
          Manage autonomous agents with spending policies
        </p>
      </div>

      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] p-16 text-center">
        <div className="w-14 h-14 rounded-xl bg-violet-500/10 flex items-center justify-center mb-5">
          <svg
            className="w-7 h-7 text-violet-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5"
            />
          </svg>
        </div>
        <h2 className="text-lg font-semibold mb-2">Coming Soon</h2>
        <p className="text-sm text-zinc-500 max-w-md leading-relaxed">
          Create AI agents with spending policies to autonomously manage
          payments within your defined guardrails. Set daily limits, approve
          recipients, and maintain full control.
        </p>
      </div>
    </div>
  )
}
