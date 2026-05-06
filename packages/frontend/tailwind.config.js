/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--v2-bg)',
        surface: 'var(--v2-surface)',
        'surface-2': 'var(--v2-surface-2)',
        'surface-code': 'var(--v2-surface-code)',
        ink: {
          DEFAULT: 'var(--v2-ink)',
          2: 'var(--v2-ink-2)',
          3: 'var(--v2-ink-3)',
        },
        border: {
          DEFAULT: 'var(--v2-border)',
          strong: 'var(--v2-border-strong)',
        },
        brand: {
          DEFAULT: 'var(--v2-brand)',
          strong: 'var(--v2-brand-strong)',
          soft: 'var(--v2-brand-soft)',
        },
        success: {
          DEFAULT: 'var(--v2-success)',
          soft: 'var(--v2-success-soft)',
        },
        warning: {
          DEFAULT: 'var(--v2-warning)',
          soft: 'var(--v2-warning-soft)',
        },
        danger: {
          DEFAULT: 'var(--v2-danger)',
          soft: 'var(--v2-danger-soft)',
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
