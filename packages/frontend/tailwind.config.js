/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Every entry reads the CHANNEL form of its token (`--v2-<name>-rgb`,
        // declared next to the hex in globals.css) through Tailwind's
        // `<alpha-value>` placeholder. That is what makes an opacity modifier
        // compile: `ring-brand/30` becomes `rgb(var(--v2-brand-rgb) / 0.3)`,
        // while the solid `bg-brand` becomes `rgb(var(--v2-brand-rgb) / 1)`
        // — the same colour it rendered before.
        //
        // Do NOT write `var(--v2-<name>)` here (#1708). A bare `var()` colour
        // has no channels for Tailwind to re-compose, so the opacity variant
        // of the utility is dropped from the output with no error, no warning
        // and no visible class — the failure mode that left 68 focus rings
        // rendering Tailwind's default blue-500/50 instead of brand indigo.
        bg: 'rgb(var(--v2-bg-rgb) / <alpha-value>)',
        surface: 'rgb(var(--v2-surface-rgb) / <alpha-value>)',
        'surface-2': 'rgb(var(--v2-surface-2-rgb) / <alpha-value>)',
        'surface-code': 'rgb(var(--v2-surface-code-rgb) / <alpha-value>)',
        ink: {
          DEFAULT: 'rgb(var(--v2-ink-rgb) / <alpha-value>)',
          2: 'rgb(var(--v2-ink-2-rgb) / <alpha-value>)',
          3: 'rgb(var(--v2-ink-3-rgb) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--v2-border-rgb) / <alpha-value>)',
          strong: 'rgb(var(--v2-border-strong-rgb) / <alpha-value>)',
        },
        brand: {
          DEFAULT: 'rgb(var(--v2-brand-rgb) / <alpha-value>)',
          strong: 'rgb(var(--v2-brand-strong-rgb) / <alpha-value>)',
          soft: 'rgb(var(--v2-brand-soft-rgb) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--v2-success-rgb) / <alpha-value>)',
          soft: 'rgb(var(--v2-success-soft-rgb) / <alpha-value>)',
        },
        // Sibling of success on the cool side — the outgoing/debit hue. Added
        // to the theme (it was tokens-only before) so slice #1709 can rewrite
        // `border-[var(--v2-debit)]/N` without touching this file.
        debit: {
          DEFAULT: 'rgb(var(--v2-debit-rgb) / <alpha-value>)',
          soft: 'rgb(var(--v2-debit-soft-rgb) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--v2-warning-rgb) / <alpha-value>)',
          soft: 'rgb(var(--v2-warning-soft-rgb) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--v2-danger-rgb) / <alpha-value>)',
          soft: 'rgb(var(--v2-danger-soft-rgb) / <alpha-value>)',
        },
      },
      boxShadow: {
        card: 'var(--v2-shadow-card)',
        button: 'var(--v2-shadow-button)',
        modal: 'var(--v2-shadow-modal)',
      },
      borderRadius: {
        card: '10px',
        modal: '14px',
      },
    },
  },
  plugins: [],
}
