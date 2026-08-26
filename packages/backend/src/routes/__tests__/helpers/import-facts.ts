/**
 * Structural facts about a TypeScript source file, parsed with the TypeScript
 * parser rather than matched with a regex.
 *
 * **Where this came from and why it is shared (#1993).** #2049 built this
 * extractor inside `non-custody-onchain-gate.contract.test.ts` to carry Red
 * Line #4's structural half — "the payment route imports no off-chain
 * coverage arithmetic, in ANY import shape". #1993 needs the same reading over
 * a WIDER file set (every live payment entry point, plus the route registry
 * and the rail seam) to carry a different claim: nothing routes to the retired
 * Safe/AllowanceModule rail.
 *
 * Two copies of an AST reader drift, and the drift is silent — the failure
 * mode both suites exist to prevent. So the extractor moved here, both suites
 * consume it, and `non-custody-onchain-gate.contract.test.ts`'s
 * extractor-control test proves every bucket is populatable from a fixture.
 *
 * **Reading source, not the module graph, is deliberate.** A `toContain`
 * substring scan over the file text would call a COMMENT a violation, and
 * both consumers deliberately name retired symbols in prose explaining why
 * their gate exists. Comments are not AST nodes, so nothing written in one can
 * reach these buckets, and nothing written in code can hide from them behind
 * formatting or quote style.
 */

import ts from 'typescript'

export type ImportFacts = {
  /**
   * Names bound into the file's module scope by a static import clause: every
   * named specifier (BOTH its original name and its local alias), a default
   * binding, and a namespace binding's local name.
   */
  bindings: Set<string>
  /**
   * Names re-exported by name from another module (`export { x } from '…'`).
   * These bind nothing locally, so the binding rule cannot see them — but they
   * put the symbol back on the file's own public surface.
   */
  reexports: Set<string>
  /**
   * Module specifiers reached by a STATIC form: `import … from '…'`,
   * side-effect `import '…'`, `export … from '…'`, `export * from '…'`.
   */
  staticModuleRefs: Set<string>
  /**
   * Every string literal in the file's CODE. This is the backstop for every
   * runtime shape: `await import('…')`, `createRequire(import.meta.url)('…')`,
   * and whatever is invented next.
   */
  codeStringLiterals: Set<string>
  /**
   * Count of dynamic `import(...)` calls whose specifier is not a literal
   * (a variable, a concatenation, a template with substitutions). No static
   * analysis can resolve one, so its presence IS the finding.
   */
  unresolvableDynamicImports: number
  /**
   * Fastify route-prefix strings this file mounts: the `prefix` property of
   * any `app.register(handler, { prefix: '…' })` call (#1993).
   *
   * Its own bucket rather than a `codeStringLiterals` filter, because the
   * question "is this route MOUNTED" is different from "does this string
   * appear". `index.ts` names `/approvals` in a comment explaining that the
   * queue is gone; that must stay green, while re-adding the registration
   * must not.
   */
  registeredPrefixes: Set<string>
  /**
   * String-literal types appearing as the value of a property named `rail`
   * inside a type alias — i.e. the members of an execution-rail decision union
   * such as `{ rail: 'delegation' } | { rail: 'retired_allowance' }` (#1993).
   *
   * The rail seam's union shape is what makes every call site name the retired
   * branch (the compiler enumerates them). Re-widening the union with a LIVE
   * allowance answer is how the retired rail would grow back at the seam, and
   * no import-shaped rule can see it.
   */
  railDecisionLiterals: Set<string>
}

/**
 * Parse `src` (source TEXT, so a fixture can populate every bucket without a
 * file on disk — that is what makes each rule's positive control possible).
 */
export function parseImportFacts(src: string, fileName = 'source.ts'): ImportFacts {
  const sourceFile = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  )

  const facts: ImportFacts = {
    bindings: new Set<string>(),
    reexports: new Set<string>(),
    staticModuleRefs: new Set<string>(),
    codeStringLiterals: new Set<string>(),
    unresolvableDynamicImports: 0,
    registeredPrefixes: new Set<string>(),
    railDecisionLiterals: new Set<string>(),
  }

  const walk = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) facts.codeStringLiterals.add(node.text)

    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) {
        facts.staticModuleRefs.add(node.moduleSpecifier.text)
      }
      const clause = node.importClause
      if (clause?.name) facts.bindings.add(clause.name.text) // default import
      const named = clause?.namedBindings
      if (named && ts.isNamespaceImport(named)) facts.bindings.add(named.name.text)
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          facts.bindings.add((el.propertyName ?? el.name).text) // original name
          facts.bindings.add(el.name.text) // local alias
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        facts.staticModuleRefs.add(node.moduleSpecifier.text)
        const clause = node.exportClause
        if (clause && ts.isNamedExports(clause)) {
          for (const el of clause.elements) facts.reexports.add((el.propertyName ?? el.name).text)
        }
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0]
      if (!specifier || !ts.isStringLiteralLike(specifier)) facts.unresolvableDynamicImports += 1
    } else if (ts.isCallExpression(node) && isRegisterCall(node.expression)) {
      for (const arg of node.arguments) {
        if (!ts.isObjectLiteralExpression(arg)) continue
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue
          if (propertyName(prop.name) !== 'prefix') continue
          if (ts.isStringLiteralLike(prop.initializer)) {
            facts.registeredPrefixes.add(prop.initializer.text)
          }
        }
      }
    } else if (ts.isPropertySignature(node) && propertyName(node.name) === 'rail' && node.type) {
      collectStringLiteralTypes(node.type, facts.railDecisionLiterals)
    }

    ts.forEachChild(node, walk)
  }
  ts.forEachChild(sourceFile, walk)

  return facts
}

/** `x.register(...)` / `register(...)` — the callee's last name segment. */
function isRegisterCall(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === 'register'
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === 'register'
  return false
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

/** `'a'`, `'a' | 'b'`, and a parenthesized/union nesting of either. */
function collectStringLiteralTypes(type: ts.TypeNode, into: Set<string>): void {
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) {
    into.add(type.literal.text)
    return
  }
  if (ts.isUnionTypeNode(type)) {
    for (const t of type.types) collectStringLiteralTypes(t, into)
    return
  }
  if (ts.isParenthesizedTypeNode(type)) collectStringLiteralTypes(type.type, into)
}

/**
 * Which of `specs` name one of `bannedModules` — agnostic to extension, to how
 * deep the relative prefix is, and to a URL query/hash suffix.
 *
 * The suffix strip is not decoration: Node's ESM loader treats
 * `import('../rails/allowance-module.js?bust=1')` as a real load of that module
 * (the standard cache-busting idiom), so a specifier ending in a query would
 * otherwise slip a rule that only knew about `.js`. Mutation-proven, not
 * reasoned about (#2049).
 *
 * ⚠️ It normalizes an extension and a query/hash suffix, NOT a trailing
 * `/index`, so `…/allowance-module/index.js` would slip. Not expressible
 * today — every banned module is a FILE, so that path resolves to nothing —
 * but if one is ever re-created as a directory, this line is the reminder
 * that the normalization must learn `/index` first.
 */
export function bannedModuleRefs(
  specs: Iterable<string>,
  bannedModules: readonly string[],
): string[] {
  return [...specs].filter((s) => {
    const normalized = s.split(/[?#]/)[0].replace(/\.(m?[jt]s)$/, '')
    return bannedModules.some((b) => normalized === b || normalized.endsWith(`/${b}`))
  })
}
