import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as sdk from './index.js'

type ClientShape = {
  publicMethods: string[]
  publicMembers: string[]
  privateMethods: string[]
  localImports: string[]
}

type ClientBoundary = {
  publicMethods: readonly string[]
  publicMembers: readonly string[]
  privateOwnership: Readonly<Record<string, readonly string[]>>
  privateCeilings: Readonly<Record<string, number>>
  privateTotalCeiling: number
  localImports: readonly string[]
}

const boundary: ClientBoundary = {
  publicMethods: [
    'authorizeX402',
    'completeX402MerchantCall',
    'createIntent',
    'createX402Intent',
    'discoverTools',
    'ensureFundingConfirmed',
    'executeTool',
    'fetch',
    'getAgent',
    'getAgentSummary',
    'getAllowances',
    'getCatalogEntry',
    'getCatalogSubmissionStatus',
    'getPayment',
    'getPaymentStatus',
    'getPaymentStatusWithPostPurchaseAllowance',
    'getPostPurchaseAllowanceSummary',
    'getReceipt',
    'getResumeState',
    'getX402MerchantCallContext',
    'listReceipts',
    'pay',
    'payX402Quote',
    'prepareSweep',
    'prepareX402Erc7710',
    'quoteMcpX402',
    'quoteX402',
    'reportX402MerchantOutcome',
    'resumeAuthorizedX402',
    'resumeX402Payment',
    'settleX402Erc7710',
    'sign',
    'submitCatalogEntry',
    'submitSignature',
    'submitSweep',
    'submitX402Erc7710',
    'sweepDelegate',
    'waitForConfirmation',
    'withRequestContext',
  ],
  publicMembers: [
    "async authorizeX402(paymentRequired: X402PaymentRequired, options: X402AuthorizationOptions = {}): Promise<X402Receipt>",
    "async completeX402MerchantCall(input: { url: string; init?: RequestInit; paymentId: string; paymentHeader: string; mcpTransport?: X402McpTransport; noFundingLeg?: boolean; }): Promise<{ status: number; ok: boolean; body: unknown; settlementTxHash?: string; }>",
    "async createIntent(request: PaymentRequest): Promise<PaymentIntent>",
    "async createX402Intent(paymentRequired: X402PaymentRequired, options: X402AuthorizationOptions = {}): Promise<X402Intent>",
    "async discoverTools(options: { category?: string; search?: string; rail?: 'x402' | 'mpp'; verified?: 'any' | 'verified' | 'operator'; } = {}): Promise<HavenCatalogEntry[]>",
    "async ensureFundingConfirmed(paymentId: string, fundingTxHash?: string): Promise<void>",
    "async executeTool(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>>",
    "async fetch(url: string, init?: RequestInit, options: X402AuthorizationOptions = {}): Promise<Response>",
    "async getAgent(): Promise<HavenAgent>",
    "async getAgentSummary(): Promise<HavenAgentSummary>",
    "async getAllowances(): Promise<HavenAllowanceSummary>",
    "async getCatalogEntry(id: string): Promise<HavenCatalogEntry>",
    "async getCatalogSubmissionStatus(id: string): Promise<{ id: string; status: 'submitted' | 'ownership_verified' | 'verified_payable' | 'failed' | 'delisted'; instructions?: { expires_at: string; well_known: { url: string; content: string; instruction: string; }; dns_txt: { name: string; value: string; instruction: string; }; } | null; }>",
    "async getPayment(paymentId: string): Promise<PaymentResult>",
    "async getPaymentStatus(paymentId: string): Promise<PaymentStatusResult>",
    "async getPaymentStatusWithPostPurchaseAllowance(paymentId: string): Promise<PaymentStatusResult & { allowance?: PostPurchaseAllowanceSummary | null; warnings?: AgentPaymentWarning[]; }>",
    "async getPostPurchaseAllowanceSummary(paymentId: string): Promise<{ allowance: PostPurchaseAllowanceSummary | null; warnings: AgentPaymentWarning[]; payment: PaymentStatusResult | null; }>",
    "async getReceipt(paymentId: string): Promise<{ receipt: PaymentReceipt; verification: ReceiptVerification; }>",
    "async getResumeState(paymentId: string): Promise<PaymentResumeState>",
    "async getX402MerchantCallContext(paymentId: string): Promise<X402MerchantCallContext>",
    "async listReceipts(options: { limit?: number; } = {}): Promise<HavenPaymentReceipt[]>",
    "async pay(request: PaymentRequest): Promise<PaymentResult>",
    "async payX402Quote(quote: X402Quote, options: X402AuthorizationOptions = {}): Promise<Response>",
    "async prepareSweep(): Promise<SweepPrepareResponse>",
    "async prepareX402Erc7710(paymentRequired: X402PaymentRequired, options: { resourceUrl?: string; delegationRail?: boolean; mcpCallContext?: X402McpCallContext; idempotencyKey?: string; } = {}): Promise<{ paymentId: string; signData: SignData; settlement: Omit<X402Erc7710Settlement, 'paymentHeader'>; }>",
    "async quoteMcpX402(url: string, init?: RequestInit, options: X402AuthorizationOptions = {}): Promise<X402Quote>",
    "async quoteX402(url: string, init?: RequestInit, options: X402AuthorizationOptions = {}): Promise<X402Quote>",
    "async resumeAuthorizedX402(input: ResumeAuthorizedX402Input): Promise<X402Receipt>",
    "async resumeX402Payment(input: ResumeX402PaymentInput | X402ResumeState): Promise<Response>",
    "async reportX402MerchantOutcome(input: { paymentId: string; outcome: X402MerchantOutcome; merchantStatus: number; merchantBody?: string; }): Promise<X402MerchantOutcomeReport>",
    "async settleX402Erc7710(paymentRequired: X402PaymentRequired, options: { resourceUrl?: string; } = {}): Promise<X402Erc7710Settlement>",
    "async submitCatalogEntry(resourceUrl: string, options: { website?: string; } = {}): Promise<HavenCatalogSubmission>",
    "async submitSignature(paymentId: string, signature: string): Promise<{ status: string; txHash?: string; }>",
    "async submitSweep(authorization: SweepAuthorization, signature: string): Promise<SweepSubmitResponse>",
    "async submitX402Erc7710(paymentId: string, signature: string): Promise<string>",
    "async sweepDelegate(): Promise<SweepResult>",
    "async waitForConfirmation(paymentId: string): Promise<PaymentResult>",
    "constructor(config: HavenClientConfig)",
    "readonly delegateAddress: string | undefined",
    "sign(hash: string): string",
    "withRequestContext<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T>",
  ],
  privateOwnership: {
    'haven-http-status': [
      'get',
      'post',
      'throwIfNonSignableAuthorizationState',
    ],
    'local-signing': ['signForData'],
  },
  // These are ratchets, not targets. When an extraction removes ownership
  // from HavenClient, lower the matching ceiling in the same change. Never
  // raise one to accommodate a new responsibility on the facade.
  privateCeilings: {
    'haven-http-status': 3,
    'local-signing': 1,
  },
  privateTotalCeiling: 4,
  localImports: [
    './account-reads.js',
    './delegate-sweep.js',
    './haven-api-transport.js',
    './mcp-merchant-transport.js',
    './merchant-completion.js',
    './payment-mappers.js',
    './payment-state.js',
    './receipt.js',
    './signer.js',
    './sweep.js',
    './tool-adapter.js',
    './types.js',
    './x402-erc7710.js',
    './x402-funding-leg.js',
    './x402-protocol.js',
    './x402.js',
  ],
}

const printer = ts.createPrinter({ removeComments: true })

function printNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, sourceFile)
    .replace(/\s+/g, ' ')
    .trim()
}

function memberName(member: ts.NamedDeclaration, sourceFile: ts.SourceFile): string {
  if (!member.name || !ts.isIdentifier(member.name)) {
    throw new Error(
      `HavenClient has an unsupported computed member: ${member.name?.getText(sourceFile) ?? '<unnamed>'}`,
    )
  }
  return member.name.text
}

function parameterContract(parameter: ts.ParameterDeclaration, sourceFile: ts.SourceFile): string {
  return [
    parameter.dotDotDotToken ? '...' : '',
    printNode(parameter.name, sourceFile),
    parameter.questionToken ? '?' : '',
    parameter.type ? `: ${printNode(parameter.type, sourceFile)}` : '',
    parameter.initializer ? ` = ${printNode(parameter.initializer, sourceFile)}` : '',
  ].join('')
}

function publicMemberContract(
  member: ts.ClassElement,
  sourceFile: ts.SourceFile,
): string | undefined {
  if (ts.isConstructorDeclaration(member)) {
    return `constructor(${member.parameters.map((parameter) => parameterContract(parameter, sourceFile)).join(', ')})`
  }
  if (ts.isMethodDeclaration(member)) {
    const staticModifier = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    ) ? 'static ' : ''
    const asyncModifier = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    ) ? 'async ' : ''
    const typeParameters = member.typeParameters?.length
      ? `<${member.typeParameters.map((parameter) => printNode(parameter, sourceFile)).join(', ')}>`
      : ''
    const parameters = member.parameters
      .map((parameter) => parameterContract(parameter, sourceFile))
      .join(', ')
    const returnType = member.type ? `: ${printNode(member.type, sourceFile)}` : ''
    return `${staticModifier}${asyncModifier}${memberName(member, sourceFile)}${typeParameters}(${parameters})${returnType}`
  }
  if (ts.isPropertyDeclaration(member)) {
    const staticModifier = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    ) ? 'static ' : ''
    const readonlyModifier = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) ? 'readonly ' : ''
    const optional = member.questionToken ? '?' : ''
    const type = member.type ? `: ${printNode(member.type, sourceFile)}` : ': <inferred>'
    return `${staticModifier}${readonlyModifier}${memberName(member, sourceFile)}${optional}${type}`
  }
  if (ts.isGetAccessorDeclaration(member)) {
    const staticModifier = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    ) ? 'static ' : ''
    const returnType = member.type ? `: ${printNode(member.type, sourceFile)}` : ': <inferred>'
    return `${staticModifier}get ${memberName(member, sourceFile)}()${returnType}`
  }
  if (ts.isSetAccessorDeclaration(member)) {
    const staticModifier = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
    ) ? 'static ' : ''
    return `${staticModifier}set ${memberName(member, sourceFile)}(${member.parameters
      .map((parameter) => parameterContract(parameter, sourceFile))
      .join(', ')})`
  }
  return undefined
}

function analyzeClientSource(source: string): ClientShape {
  const sourceFile = ts.createSourceFile(
    'client.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const clients = sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) && statement.name?.text === 'HavenClient',
  )
  if (clients.length !== 1) {
    throw new Error(`Expected exactly one HavenClient class, found ${clients.length}`)
  }
  const client = clients[0]
  const exported = client.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  if (!exported) throw new Error('HavenClient must remain exported')

  const publicMethods: string[] = []
  const publicMembers: string[] = []
  const privateMethods: string[] = []
  for (const member of client.members) {
    const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined
    const isPrivate = modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword,
    )
    const isProtected = modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    )
    if (isProtected) {
      throw new Error(`HavenClient must not declare protected member ${memberName(member as ts.NamedDeclaration, sourceFile)}`)
    }
    const callableProperty = ts.isPropertyDeclaration(member) && (
      (member.initializer != null && ts.isArrowFunction(member.initializer)) ||
      (member.initializer != null && ts.isFunctionExpression(member.initializer)) ||
      (member.type != null && ts.isFunctionTypeNode(member.type))
    )
    const owned = ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member) ||
      callableProperty
    if (owned && !ts.isConstructorDeclaration(member)) {
      const name = memberName(member as ts.NamedDeclaration, sourceFile)
      ;(isPrivate ? privateMethods : publicMethods).push(name)
    }
    if (!isPrivate) {
      const contract = publicMemberContract(member, sourceFile)
      if (contract) publicMembers.push(contract)
    }
  }

  const localImports = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .map((declaration) => declaration.moduleSpecifier)
    .filter(ts.isStringLiteral)
    .map((specifier) => specifier.text)
    .filter((specifier) => specifier.startsWith('.'))

  return {
    publicMethods: [...new Set(publicMethods)].sort(),
    publicMembers: [...new Set(publicMembers)].sort(),
    privateMethods: [...new Set(privateMethods)].sort(),
    localImports: [...new Set(localImports)].sort(),
  }
}

function interfaceContracts(source: string, interfaceName: string): string[] {
  const sourceFile = ts.createSourceFile(
    'types.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const declarations = sourceFile.statements.filter(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName,
  )
  if (declarations.length !== 1) {
    throw new Error(`Expected exactly one ${interfaceName} interface, found ${declarations.length}`)
  }
  return declarations[0].members.map((member) => {
    if (!ts.isPropertySignature(member) || !member.name || !ts.isIdentifier(member.name)) {
      throw new Error(`${interfaceName} must contain only named property signatures`)
    }
    const readonlyModifier = member.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
    ) ? 'readonly ' : ''
    const optional = member.questionToken ? '?' : ''
    const type = member.type ? printNode(member.type, sourceFile) : '<inferred>'
    return `${readonlyModifier}${member.name.text}${optional}: ${type}`
  }).sort()
}

function typeOnlyExportNames(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  return sourceFile.statements
    .filter(ts.isExportDeclaration)
    .flatMap((declaration) => {
      if (!declaration.exportClause || !ts.isNamedExports(declaration.exportClause)) return []
      return declaration.exportClause.elements
        .filter((specifier) => declaration.isTypeOnly || specifier.isTypeOnly)
        .map((specifier) => specifier.name.text)
    })
    .sort()
}

function validateBoundary(shape: ClientShape, contract: ClientBoundary): void {
  expect(shape.publicMethods, 'public HavenClient method surface changed').toEqual(
    [...contract.publicMethods].sort(),
  )
  expect(shape.publicMembers, 'public HavenClient declaration contract changed').toEqual(
    [...contract.publicMembers].sort(),
  )
  expect(shape.localImports, 'HavenClient local dependency fan-in changed').toEqual(
    [...contract.localImports].sort(),
  )

  const ownership = Object.entries(contract.privateOwnership)
  const ownedMethods = ownership.flatMap(([, methods]) => methods)
  expect(new Set(ownedMethods).size, 'a private method has more than one owner').toBe(
    ownedMethods.length,
  )
  expect([...ownedMethods].sort(), 'private HavenClient ownership manifest changed').toEqual(
    shape.privateMethods,
  )
  expect(Object.keys(contract.privateCeilings).sort(), 'every ownership bucket needs a ratchet').toEqual(
    ownership.map(([owner]) => owner).sort(),
  )

  for (const [owner, methods] of ownership) {
    expect(
      methods.length,
      `${owner} grew; extract the responsibility instead of raising its ceiling`,
    ).toBe(contract.privateCeilings[owner])
  }
  expect(
    ownedMethods.length,
    'HavenClient private responsibility total grew; extract instead of raising the ceiling',
  ).toBe(contract.privateTotalCeiling)
}

describe('HavenClient structural boundary', () => {
  it('pins the package runtime export surface', () => {
    expect(Object.keys(sdk).sort()).toEqual([
      'AGENT_PAYMENT_FAILURE_CODE_VALUES',
      'AGENT_PAYMENT_NEXT_ACTION_VALUES',
      'AGENT_PAYMENT_PHASE_VALUES',
      'AGENT_PAYMENT_RAIL_VALUES',
      'AgentPaymentFailureCode',
      'AgentPaymentFailureCodeDescriptions',
      'AgentPaymentFailureCodeSchema',
      'AgentPaymentNextAction',
      'AgentPaymentNextActionDescriptions',
      'AgentPaymentNextActionSchema',
      'AgentPaymentPhase',
      'AgentPaymentPhaseDescriptions',
      'AgentPaymentPhaseSchema',
      'AgentPaymentRail',
      'AgentPaymentRailDescriptions',
      'AgentPaymentRailSchema',
      'AgentPaymentWarningCode',
      // #1756: the ONE confirmation deadline the payment poller and the
      // delegate sweep share. Public so a consumer reading `unconfirmed` can
      // see how long the SDK waited before saying so.
      'DEFAULT_CONFIRMATION_TIMEOUT_MS',
      'DISCOVERY_MAX_BYTES',
      'ERC7710_ASSET_TRANSFER_METHOD',
      'HAVEN_MINIMUM_NODE_VERSION',
      'HAVEN_SKILL_BODY_MD',
      'HAVEN_SKILL_MD',
      'HavenApiError',
      'HavenClient',
      'HavenError',
      'HavenPaymentStateError',
      'HavenSigningError',
      'HavenTimeoutError',
      'HavenUnsupportedSignerVersionError',
      'MERCHANT_DISCOVERY_PATHS',
      'MerchantTimeoutError',
      'RECEIPT_VERSION',
      'SIGNER_UPDATE_FALLBACK',
      'SKILL_FOLDER_NAME',
      'SWEEP_BASE_CHAIN_ID',
      'SWEEP_BASE_SEPOLIA_CHAIN_ID',
      'SWEEP_BASE_SEPOLIA_USDC_ADDRESS',
      'SWEEP_BASE_USDC_ADDRESS',
      'SignerRefusalCode',
      'TRANSFER_WITH_AUTHORIZATION_TYPES',
      'X402AlreadySettledError',
      'X402PaymentHeaderValidationError',
      'X402UnexpectedStatusError',
      'X402_LEGACY_PAYMENT_HEADER_NAME',
      'X402_MAX_AUTHORIZATION_WINDOW_SECONDS',
      'X402_PAYMENT_HEADER_NAME',
      'X402_PAYMENT_HEADER_NAMES_SENT',
      'X402_PAYMENT_REQUIRED_HEADER_NAME',
      'X402_PAYMENT_RESPONSE_HEADER_NAME',
      'X402_SETTLEMENT_FORWARD_MARGIN_SECONDS',
      'addressFromKey',
      'buildSweepAuthorizationMessage',
      'buildSweepTypedData',
      'buildX402ExpectedMessage',
      'compareNodeVersions',
      'composeDescription',
      'decodeBase64Json',
      'decodeBase64Utf8',
      'discoverMerchantMcpUrl',
      'encodeBase64Json',
      'encodeBase64Utf8',
      'encodePaymentProof',
      'havenTools',
      'isErc7710Option',
      'isSupportedNodeVersion',
      'isSweepableChain',
      'normalizePaymentRequired',
      'parsePaymentRequired',
      'parsePaymentRequiredResponse',
      'resolveTokenFromAddress',
      'sameUrl',
      'selectErc7710PaymentOption',
      'selectPaymentOption',
      'selectStandardPaymentOption',
      'selectX402SettlementScheme',
      'signHash',
      'signUserOpTypedDataForDelegation',
      'sweepUsdcAddress',
      'sweepUsdcDomain',
      'toStandardPaymentRequirements',
      'toolDescriptions',
      'unsupportedNodeVersionMessage',
      'validateStandardX402PaymentHeader',
      'verifyPaymentReceipt',
      'verifySignature',
      'x402AssetTransferMethod',
      'x402AuthorizationAmount',
      'x402FacilitatorAddresses',
      // #2361: the shared v2 payment envelope (resource/extensions echoes) —
      // exported so the edge signer builds the same envelope as the SDK's
      // own funding leg instead of a drifting copy.
      'x402V2PaymentEnvelope',
    ])
  })

  it('pins the public constructor option names from the package type contract', () => {
    const source = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
    expect(interfaceContracts(source, 'HavenClientConfig')).toEqual([
      'apiKey: string',
      'baseUrl?: string',
      'chainRpcs?: Record<number, string>',
      'confirmationTimeout?: number',
      'defaultHeaders?: Record<string, string>',
      'delegateKey?: string',
      'merchantTimeout?: number',
      'pollingInterval?: number',
      'requestTimeout?: number',
      'x402Wallet?: string',
    ])
  })

  it('pins type-only exports that are invisible at runtime', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(typeOnlyExportNames(source)).toEqual([
      'AgentNextStep',
      'AgentPaymentEnumSchema',
      'AgentPaymentSummary',
      'AgentPaymentWarning',
      'AgentPurchaseSummary',
      'CatalogSubmissionAccepted',
      'ClaudeTool',
      'HavenAgent',
      'HavenAgentAllowanceSummary',
      'HavenAgentReadiness',
      'HavenAgentSummary',
      'HavenAllowance',
      'HavenAllowanceSummary',
      'HavenCatalogEntry',
      'HavenCatalogSubmission',
      'HavenClientConfig',
      'HavenPaymentReceipt',
      'MachinePaymentRail',
      'OpenAITool',
      'PaymentFee',
      'PaymentIntent',
      'PaymentNextAction',
      'PaymentPhase',
      'PaymentReceipt',
      'PaymentRequest',
      'PaymentResult',
      'PaymentResumeState',
      'PaymentStatus',
      'PaymentStatusResult',
      'PostPurchaseAllowanceSummary',
      'ReceiptVerification',
      'ResumeAuthorizedX402Input',
      'ResumeX402PaymentInput',
      'SharedToolKey',
      'SignData',
      'SweepAuthorization',
      'SweepConfirmation', // #1756
      'SweepEip712Domain',
      'SweepEntry',
      'SweepExpectedAuth',
      'SweepPreparation',
      'SweepPrepareResponse',
      'SweepResult',
      'SweepSubmitResponse',
      'SweepSubmitResult',
      'SweepTypedData',
      'ToolDescription',
      'UnsupportedNodeVersionMessageOptions',
      'X402AuthorizationOptions',
      'X402Erc7710Settlement',
      'X402ExpectedAuth',
      'X402ExpectedContext',
      'X402Intent',
      'X402McpCallContext',
      'X402McpTransport',
      'X402MerchantCallContext',
      'X402MerchantOutcome', // #2292
      'X402MerchantOutcomeReport', // #2292
      'X402PaymentHeaderContext',
      'X402PaymentOption',
      'X402PaymentRequired',
      'X402Quote',
      'X402Receipt',
      'X402RequestSnapshot',
      'X402ResumeState',
      'X402SchemeSelection',
    ])
  })

  it('pins its public facade, private ownership, and local dependency fan-in', () => {
    const source = readFileSync(new URL('./client.ts', import.meta.url), 'utf8')
    validateBoundary(analyzeClientSource(source), boundary)
  })

  it('parses async, generic, and multiline methods without reading comments or strings', () => {
    const shape = analyzeClientSource(`
      export class HavenClient {
        public async multiline<T>(
          value: T,
        ): Promise<T> { return value }
        private helper() { return 'notAMethod()' }
        // public commentedOut() {}
      }
    `)
    expect(shape).toMatchObject({ publicMethods: ['multiline'], privateMethods: ['helper'] })
  })

  it('refuses a missing or ambiguous class instead of passing vacuously', () => {
    expect(() => analyzeClientSource('export class SomethingElse {}')).toThrow(
      'Expected exactly one HavenClient class, found 0',
    )
    expect(() => analyzeClientSource('class HavenClient {}\nclass HavenClient {}')).toThrow(
      'Expected exactly one HavenClient class, found 2',
    )
  })

  it('counts callable properties and accessors as owned members', () => {
    const shape = analyzeClientSource(`
      export class HavenClient {
        private retry = async (): Promise<void> => {}
        get state(): string { return 'ready' }
      }
    `)
    expect(shape.privateMethods).toEqual(['retry'])
    expect(shape.publicMethods).toEqual(['state'])
    expect(shape.publicMembers).toEqual(['get state(): string'])
  })

  it('refuses protected facade members instead of treating them as public', () => {
    expect(() => analyzeClientSource(`
      export class HavenClient {
        protected pay(): void {}
      }
    `)).toThrow('HavenClient must not declare protected member pay')
  })

  it('detects public, ownership, ceiling, import, and stale-manifest mutations', () => {
    const base: ClientShape = {
      publicMethods: ['pay'],
      publicMembers: ['pay(): void'],
      privateMethods: ['request'],
      localImports: ['./types.js'],
    }
    const small: ClientBoundary = {
      publicMethods: ['pay'],
      publicMembers: ['pay(): void'],
      privateOwnership: { transport: ['request'] },
      privateCeilings: { transport: 1 },
      privateTotalCeiling: 1,
      localImports: ['./types.js'],
    }

    expect(() => validateBoundary(base, small)).not.toThrow()
    expect(() => validateBoundary({ ...base, publicMethods: ['pay', 'send'] }, small)).toThrow()
    expect(() => validateBoundary({ ...base, privateMethods: ['request', 'retry'] }, small)).toThrow()
    expect(() => validateBoundary(base, {
      ...small,
      privateOwnership: { transport: ['request'], retry: ['request'] },
      privateCeilings: { transport: 1, retry: 1 },
    })).toThrow()
    expect(() => validateBoundary(base, { ...small, privateCeilings: { transport: 0 } })).toThrow()
    expect(() => validateBoundary({ ...base, localImports: ['./new-module.js', './types.js'] }, small)).toThrow()
    expect(() => validateBoundary({ ...base, privateMethods: [] }, small)).toThrow()
  })
})
