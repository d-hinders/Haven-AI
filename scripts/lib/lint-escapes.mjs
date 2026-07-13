// Shared escape-marker semantics for the lint gates (code review 2026-07-13).
//
// Before this, each linter had its own dialect with DIFFERENT placement
// rules: design-lint-disable-line worked only on the offending line, while
// copy-lint-ignore also worked on the line above — a silent trap (a marker
// placed per one tool's rules did nothing under the other's). One rule now:
// a reviewed exception is escaped by its marker on the offending line OR the
// line directly above. (The design-system coupling gate's
// `// design-system-exempt: <reason>` keeps its trailing-comment+reason form
// — it exempts an EXPORT, not a scan line — but is documented alongside
// these in /design-system §Enforcement.)
export function isEscaped(lines, i, marker) {
  return lines[i].includes(marker) || (i > 0 && lines[i - 1].includes(marker))
}
