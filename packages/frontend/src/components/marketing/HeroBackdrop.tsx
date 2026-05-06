export function HeroBackdrop({ variant = 'default' }: { variant?: 'default' | 'soft' }) {
  return (
    <div aria-hidden className="v2-mesh-drift pointer-events-none absolute -inset-16 overflow-hidden">
      <div
        className="absolute -top-32 -left-32 w-[680px] h-[680px] rounded-full blur-3xl"
        style={{
          background:
            variant === 'soft'
              ? 'radial-gradient(circle, rgba(99,102,241,0.55) 0%, transparent 65%)'
              : 'radial-gradient(circle, rgba(99,102,241,0.55) 0%, transparent 60%)',
        }}
      />
      <div
        className="absolute -top-10 right-[-120px] w-[560px] h-[560px] rounded-full blur-3xl"
        style={{
          background: 'radial-gradient(circle, rgba(244,114,182,0.55) 0%, transparent 60%)',
        }}
      />
      <div
        className="absolute top-[140px] left-[38%] w-[460px] h-[460px] rounded-full blur-3xl opacity-90"
        style={{
          background: 'radial-gradient(circle, rgba(56,189,248,0.50) 0%, transparent 60%)',
        }}
      />
      <div
        className="absolute top-[60px] left-[18%] w-[300px] h-[300px] rounded-full blur-3xl opacity-80"
        style={{
          background: 'radial-gradient(circle, rgba(251,191,36,0.30) 0%, transparent 60%)',
        }}
      />
      {/* Fine grid texture for depth */}
      <div
        className="absolute inset-0 opacity-[0.35] mix-blend-multiply"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(26,31,54,0.08) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage:
            'radial-gradient(ellipse 80% 60% at 50% 30%, black 0%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 60% at 50% 30%, black 0%, transparent 75%)',
        }}
      />
    </div>
  )
}
