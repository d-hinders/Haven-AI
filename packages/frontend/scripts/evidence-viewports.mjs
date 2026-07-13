// The evidence viewports — SINGLE source for both the screenshot script
// (#896 reviewer evidence) and the visual-regression spec (#897 pixel gate),
// so reviewers approve layouts at exactly the widths CI renders.
// Dependency-free on purpose: the spec imports this at collection time.
export const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
]
