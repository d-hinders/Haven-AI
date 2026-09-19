/*
 * The hero mesh backdrop, shared by all five marketing routes.
 *
 * Every layer below used to be hard-coded for a light page while the ink that
 * renders on top rides theme tokens — a dark-scheme visitor got near-white
 * headline ink over an always-white wash (#3139). The classification follows
 * the #2929 ground/accent split:
 *
 *   - The white wash is GROUND: the hero ink sits on it, so it reads the
 *     `--v2-marketing-canvas-wash` token, redeclared per theme in globals.css
 *     (dark stops mirror the #2929 hero-wash ground and hold AA under the
 *     theme ink on every mesh composite).
 *   - The four colour tints are ACCENTS, the class `--v2-brand-gradient`
 *     belongs to: saturated fills that read on either ground, carrying no
 *     text, so they stay fixed in both themes.
 *   - The dot grid is a texture painted in the ground's own ink, so it reads
 *     the `--v2-marketing-dot` token (light: the page ink at low alpha; dark:
 *     a light dot at low alpha) rather than assuming a white page underneath.
 */
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
            'var(--v2-marketing-canvas-wash)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.28]"
        style={{
          backgroundImage:
            'radial-gradient(circle, var(--v2-marketing-dot) 1px, transparent 1px)',
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
