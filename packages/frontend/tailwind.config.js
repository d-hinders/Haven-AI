/** @type {import('tailwindcss').Config} */
// The frontend consumes the SHARED preset (#3508): the palette, elevation
// scale and radii that lived in this file's `theme.extend` now come from
// `@haven_ai/ui/tailwind.preset` (byte-for-byte the same entries), so the
// frontend and the ops console compile one design system. This file keeps
// only what is frontend-specific — today that is nothing but the content
// globs.
//
// `content` includes the package's SOURCE (the preset's own `content` is
// empty by design — the consuming app declares what it scans): the moved
// primitives' class names live in `packages/ui/src`, and a glob that missed
// them would purge those classes from every build with no error (the shim
// files here re-export, so they name no Tailwind class).
module.exports = {
  presets: [require('@haven_ai/ui/tailwind.preset')],
  content: ['./src/**/*.{ts,tsx}', '../ui/src/**/*.{ts,tsx}'],
}
