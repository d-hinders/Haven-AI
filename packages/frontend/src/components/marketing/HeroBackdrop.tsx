export function HeroBackdrop({ variant = 'default' }: { variant?: 'default' | 'soft' }) {
  const indigoOpacity = variant === 'soft' ? 0.28 : 0.32

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden bg-[var(--v2-bg)]">
      <div
        className="v2-mesh-drift absolute -inset-8"
        style={{
          background:
            `radial-gradient(ellipse 54% 62% at 4% 18%, rgba(99,102,241,${indigoOpacity}) 0%, rgba(99,102,241,0) 62%), ` +
            'radial-gradient(ellipse 50% 58% at 96% 18%, rgba(244,114,182,0.28) 0%, rgba(244,114,182,0) 62%), ' +
            'radial-gradient(ellipse 52% 52% at 52% 56%, rgba(56,189,248,0.26) 0%, rgba(56,189,248,0) 64%), ' +
            'radial-gradient(ellipse 34% 36% at 27% 25%, rgba(251,191,36,0.16) 0%, rgba(251,191,36,0) 60%), ' +
            'linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.96) 72%, #ffffff 100%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.28]"
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
