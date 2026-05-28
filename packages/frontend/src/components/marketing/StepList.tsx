type Step = {
  step: string
  title: string
  body: string
}

type Tone = 'light' | 'dark'

export function StepList({ steps, tone = 'light' }: { steps: Step[]; tone?: Tone }) {
  if (tone === 'dark') {
    return (
      <ol className="grid grid-cols-1 md:grid-cols-3 gap-px bg-white/10 rounded-[12px] overflow-hidden border border-white/10 backdrop-blur">
        {steps.map((s) => (
          <li
            key={s.step}
            className="bg-white/[0.04] hover:bg-white/[0.08] transition-colors p-7 md:p-8"
          >
            <div className="text-[12px] font-medium text-fuchsia-200 mb-5 v2-tabular">
              {s.step}
            </div>
            <h3 className="text-[16px] font-semibold tracking-tight text-white mb-2">
              {s.title}
            </h3>
            <p className="text-[14px] leading-relaxed text-white/75">{s.body}</p>
          </li>
        ))}
      </ol>
    )
  }

  return (
    <ol className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[var(--v2-border)] rounded-[10px] overflow-hidden border border-[var(--v2-border)]">
      {steps.map((s) => (
        <li key={s.step} className="bg-white p-7 md:p-8">
          <div className="text-[12px] font-medium text-[var(--v2-brand)] mb-5 v2-tabular">
            {s.step}
          </div>
          <h3 className="text-[16px] font-semibold tracking-tight text-[var(--v2-ink)] mb-2">
            {s.title}
          </h3>
          <p className="text-[14px] leading-relaxed text-[var(--v2-ink-2)]">{s.body}</p>
        </li>
      ))}
    </ol>
  )
}
