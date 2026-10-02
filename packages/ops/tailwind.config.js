/** @type {import('tailwindcss').Config} */
// The ops console consumes the SHARED preset (#3508), exactly as the frontend
// does: palette, elevation and radii come from `@haven_ai/ui/tailwind.preset`.
// This file keeps only what is ops-specific — today that is nothing but the
// content globs, which must include the shared primitives' SOURCE (the
// preset's own `content` is empty by design — the consuming app declares
// what it scans).
module.exports = {
  presets: [require('@haven_ai/ui/tailwind.preset')],
  content: ['./src/**/*.{ts,tsx}', '../ui/src/**/*.{ts,tsx}'],
}
