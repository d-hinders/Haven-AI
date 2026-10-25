/**
 * Comment stripping for source-scan guards (#4411).
 *
 * The guard tests that scan a source file for a call (or a forbidden string)
 * used to strip comments with two regexes — block comments first, then line
 * comments. That pair has a blind window: neither regex knows what a string
 * or a line comment is, so a `/*` inside a `//` comment (or inside a string)
 * opens a fake block that runs to the next real end-of-comment, swallowing
 * every line in between — real code included. A guard can then pass while the code it
 * checks has changed (found by haven-reviewer on PR #4410: a line comment
 * naming `/accounting/connections/*` in `index.ts` swallowed ~35 lines, and a
 * bare `runCatalogIngestTick()` hidden in that window passed the wiring test).
 *
 * So the stripping is TypeScript's own: parse and re-emit with comments
 * removed. Only the parser knows where a comment starts — this handles
 * strings, template literals (including nested `${...}`), regex literals and
 * both comment forms, which no regex pair can.
 *
 * Contract: comments are gone, everything else — string contents included —
 * is preserved. The result is for TEXT scanning (regex guards), not for
 * execution or import.
 *
 * Note for `packages/core` consumers: this module is re-emitted into
 * `dist/` with a bare `import 'typescript'`, so the workspace's hoisted
 * devDependency satisfies it. `@haven_ai/core` is private and
 * workspace-only (never packed), so typescript stays a devDependency and
 * tsup keeps it external rather than bundling the compiler into `dist/`.
 */
import ts from 'typescript'

export function stripComments(source: string, fileName = 'source.ts'): string {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      removeComments: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      // Keep import statements VERBATIM, including imports whose bindings are
      // unused: the default transpile elision would silently delete an unused
      // `import { createWalletClient } from 'viem'` and the "imports nothing
      // that can sign" guards would never see it. Type-only imports are still
      // erased — a type cannot sign at runtime.
      verbatimModuleSyntax: true,
      // `.tsx` scans (the ops cards, the frontend colour guards) must keep
      // their JSX verbatim: the scans match on attribute text such as
      // `padding="none"` inside the tags. Without `jsx: Preserve` the
      // compiler would refuse or rewrite the elements.
      ...(fileName.endsWith('.tsx') ? { jsx: ts.JsxEmit.Preserve } : {}),
    },
  }).outputText
}
