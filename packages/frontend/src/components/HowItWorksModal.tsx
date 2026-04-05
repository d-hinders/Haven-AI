'use client'

import { useState } from 'react'

// ── Page content ───────────────────────────────────────────────────

interface Page {
  title: string
  subtitle: string
  content: React.ReactNode
}

function DiagramBox({
  label,
  sub,
  accent = false,
  className = '',
}: {
  label: string
  sub?: string
  accent?: boolean
  className?: string
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-center ${
        accent
          ? 'border-indigo-500/30 bg-indigo-500/[0.06]'
          : 'border-white/[0.08] bg-white/[0.03]'
      } ${className}`}
    >
      <p className={`text-xs font-medium ${accent ? 'text-indigo-300' : 'text-zinc-300'}`}>
        {label}
      </p>
      {sub && <p className="text-[10px] text-zinc-600 mt-0.5">{sub}</p>}
    </div>
  )
}

function Arrow({ direction = 'down' }: { direction?: 'down' | 'right' }) {
  if (direction === 'right') {
    return (
      <div className="flex items-center justify-center px-1">
        <svg width="20" height="12" viewBox="0 0 20 12" fill="none" className="text-zinc-700">
          <path d="M0 6h16M12 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center py-1">
      <svg width="12" height="20" viewBox="0 0 12 20" fill="none" className="text-zinc-700">
        <path d="M6 0v16M1 12l5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-black/40 border border-white/[0.06] rounded-lg px-4 py-3 text-[11px] font-mono text-zinc-400 overflow-x-auto leading-relaxed">
      {children}
    </pre>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-[10px] font-medium uppercase tracking-wider text-indigo-400 bg-indigo-500/10 rounded px-1.5 py-0.5">
      {children}
    </span>
  )
}

const PAGES: Page[] = [
  // ── Page 1: Overview ──────────────────────────────────
  {
    title: 'Architecture Overview',
    subtitle: 'How agents spend money safely',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          Haven uses a <span className="text-zinc-200">non-custodial, policy-first</span> model.
          Agents can spend from your Safe within strict on-chain limits &mdash; without Haven
          or the agent ever having full access to your funds.
        </p>

        {/* Architecture diagram */}
        <div className="flex flex-col items-center gap-1 py-2">
          <DiagramBox label="Your Safe" sub="Holds funds on Gnosis Chain" />
          <Arrow />
          <DiagramBox label="AllowanceModule" sub="On-chain spending limits" accent />
          <Arrow />
          <div className="flex items-center gap-1">
            <DiagramBox label="Haven API" sub="Policy + audit layer" accent />
            <Arrow direction="right" />
            <DiagramBox label="Agent (EOA)" sub="Delegate key" />
          </div>
        </div>

        <div className="space-y-3 text-xs text-zinc-500 leading-relaxed">
          <div className="flex gap-2">
            <span className="text-indigo-400 mt-0.5 flex-shrink-0">1.</span>
            <p>Your <span className="text-zinc-300">Safe</span> holds all funds. It&apos;s a smart contract wallet with multi-owner security.</p>
          </div>
          <div className="flex gap-2">
            <span className="text-indigo-400 mt-0.5 flex-shrink-0">2.</span>
            <p>The <span className="text-zinc-300">AllowanceModule</span> is a Safe module that enforces per-token spending limits for delegate addresses.</p>
          </div>
          <div className="flex gap-2">
            <span className="text-indigo-400 mt-0.5 flex-shrink-0">3.</span>
            <p>An <span className="text-zinc-300">Agent</span> is an external EOA with constrained authority &mdash; it can spend only what you allow, on the tokens you choose, with automatic reset periods.</p>
          </div>
        </div>
      </div>
    ),
  },

  // ── Page 2: Setup flow ────────────────────────────────
  {
    title: 'Agent Setup',
    subtitle: 'What happens when you create an agent',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          Creating an agent executes a <span className="text-zinc-200">single batched Safe transaction</span> that
          configures everything on-chain in one wallet signature.
        </p>

        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">1</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Enable AllowanceModule</p>
              <p className="text-[11px] text-zinc-600 mt-0.5">
                If this is your first agent, the module is enabled on your Safe via{' '}
                <code className="text-[10px] bg-white/[0.04] px-1 rounded">enableModule()</code>.
                This is a one-time operation.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">2</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Register delegate</p>
              <p className="text-[11px] text-zinc-600 mt-0.5">
                Your agent&apos;s EOA public address is added as a delegate via{' '}
                <code className="text-[10px] bg-white/[0.04] px-1 rounded">addDelegate()</code>.
                This authorises the address to request allowance transfers.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">3</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Set allowances</p>
              <p className="text-[11px] text-zinc-600 mt-0.5">
                Per-token limits are configured via{' '}
                <code className="text-[10px] bg-white/[0.04] px-1 rounded">setAllowance(delegate, token, amount, resetTime)</code>.
                Each token gets an independent limit with an optional reset period.
              </p>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-zinc-600 bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2">
          <span className="text-zinc-400">Batching:</span> All operations are packed into a single{' '}
          <code className="text-[10px] bg-white/[0.04] px-1 rounded">MultiSendCallOnly</code> transaction.
          The Safe executes it via <code className="text-[10px] bg-white/[0.04] px-1 rounded">DELEGATECALL</code>,
          so you only sign once in your wallet.
        </div>
      </div>
    ),
  },

  // ── Page 3: Key management ────────────────────────────
  {
    title: 'Key Management',
    subtitle: 'Who holds what — and why',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          Haven is <span className="text-zinc-200">fully non-custodial</span>. At no point does Haven hold any private key
          that can move your funds.
        </p>

        <div className="space-y-3">
          {/* Safe owner key */}
          <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-1.5">
              <Label>You hold</Label>
              <span className="text-xs text-zinc-200 font-medium">Safe owner key</span>
            </div>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Your connected wallet (MetaMask, etc.) is an owner of the Safe.
              It signs setup transactions (create agent, revoke, change limits).
              This key has full control over the Safe.
            </p>
          </div>

          {/* Delegate key */}
          <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-1.5">
              <Label>You hold</Label>
              <span className="text-xs text-zinc-200 font-medium">Agent delegate key (EOA)</span>
            </div>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              A separate EOA wallet you create outside Haven. You paste the <span className="text-zinc-400">public address</span> into
              Haven during agent setup, and give the <span className="text-zinc-400">private key</span> to your agent
              (via env vars, config file, etc.). Haven only ever sees the public address.
            </p>
          </div>

          {/* Haven holds */}
          <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-1.5">
              <Label>Haven holds</Label>
              <span className="text-xs text-zinc-200 font-medium">API key + metadata</span>
            </div>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Haven stores the agent&apos;s API key (for authentication), name, description, and
              a record of the configured allowances. No private keys. If Haven is compromised,
              attackers cannot move funds.
            </p>
          </div>
        </div>

        <div className="text-[11px] text-amber-400/70 bg-amber-400/5 border border-amber-400/10 rounded-lg px-3 py-2 leading-relaxed">
          <span className="font-medium text-amber-400">Security note:</span> The delegate key can only spend within its
          on-chain allowance. Even if the delegate key is compromised, the attacker is limited to the
          configured allowance amount &mdash; they cannot access the full Safe balance.
        </div>
      </div>
    ),
  },

  // ── Page 4: Payment flow ──────────────────────────────
  {
    title: 'Payment Flow',
    subtitle: 'How an agent spends money',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          When an agent needs to pay for something, the transaction flows through the
          AllowanceModule &mdash; either directly or via the Haven API.
        </p>

        {/* Flow diagram */}
        <div className="space-y-0.5">
          <div className="flex items-start gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[9px] font-bold text-indigo-400">1</span>
            </div>
            <div>
              <p className="text-xs text-zinc-300">Agent sends payment intent</p>
              <p className="text-[10px] text-zinc-600 mt-0.5">
                <code className="bg-white/[0.04] px-1 rounded">POST /payments</code> with token, amount, and recipient
              </p>
            </div>
          </div>
          <div className="pl-5 flex items-center"><Arrow /></div>
          <div className="flex items-start gap-3 p-2.5 rounded-lg bg-indigo-500/[0.04] border border-indigo-500/10">
            <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[9px] font-bold text-indigo-400">2</span>
            </div>
            <div>
              <p className="text-xs text-zinc-300">Haven validates and constructs tx</p>
              <p className="text-[10px] text-zinc-600 mt-0.5">
                Checks API key, evaluates policies, queries on-chain allowance remaining,
                builds <code className="bg-white/[0.04] px-1 rounded">executeAllowanceTransfer</code> calldata
              </p>
            </div>
          </div>
          <div className="pl-5 flex items-center"><Arrow /></div>
          <div className="flex items-start gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-5 h-5 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[9px] font-bold text-indigo-400">3</span>
            </div>
            <div>
              <p className="text-xs text-zinc-300">Agent signs with delegate key</p>
              <p className="text-[10px] text-zinc-600 mt-0.5">
                The agent signs the transfer hash with its EOA private key. Haven never sees this key.
              </p>
            </div>
          </div>
          <div className="pl-5 flex items-center"><Arrow /></div>
          <div className="flex items-start gap-3 p-2.5 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[9px] font-bold text-emerald-400">4</span>
            </div>
            <div>
              <p className="text-xs text-zinc-300">AllowanceModule executes</p>
              <p className="text-[10px] text-zinc-600 mt-0.5">
                The module verifies the signature, checks the spending limit, and transfers tokens
                from the Safe to the recipient. The <code className="bg-white/[0.04] px-1 rounded">spent</code> counter increments on-chain.
              </p>
            </div>
          </div>
        </div>

        <CodeBlock>{`// AllowanceModule.executeAllowanceTransfer()
executeAllowanceTransfer(
  safe,           // Safe address
  token,          // ERC-20 or address(0) for native
  to,             // Payment recipient
  amount,         // Transfer amount
  paymentToken,   // Gas refund token (or 0x0)
  payment,        // Gas refund amount (or 0)
  delegate,       // Agent EOA address
  signature       // Agent's ECDSA signature
)`}</CodeBlock>
      </div>
    ),
  },

  // ── Page 5: On-chain enforcement ──────────────────────
  {
    title: 'On-Chain Enforcement',
    subtitle: 'How limits are enforced at the contract level',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          The AllowanceModule is an{' '}
          <span className="text-zinc-200">audited Safe module</span>{' '}
          deployed at a canonical address across chains. It enforces limits in the EVM &mdash;
          no off-chain system can bypass them.
        </p>

        <div className="space-y-3">
          <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <p className="text-xs text-zinc-200 font-medium mb-1">Per-token allowances</p>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Each delegate + token pair has an independent allowance.
              An agent with 100 USDC.e and 50 xDAI can&apos;t use its xDAI limit to spend more USDC.e.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <p className="text-xs text-zinc-200 font-medium mb-1">Automatic resets</p>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              Allowances can have a reset period (daily, weekly, monthly).
              After the period elapses, the <code className="text-[10px] bg-white/[0.04] px-1 rounded">spent</code> counter
              resets to 0 on the next transfer, restoring the full allowance. No transaction needed.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]">
            <p className="text-xs text-zinc-200 font-medium mb-1">Instant revocation</p>
            <p className="text-[11px] text-zinc-600 leading-relaxed">
              The Safe owner can call <code className="text-[10px] bg-white/[0.04] px-1 rounded">removeDelegate()</code> at
              any time. This immediately removes all allowances and prevents the delegate
              from executing any further transfers.
            </p>
          </div>
        </div>

        <CodeBlock>{`// On-chain allowance state per delegate + token
struct Allowance {
  uint96 amount;        // Total allowance (e.g. 100e6 for 100 USDC.e)
  uint96 spent;         // Amount spent in current period
  uint16 resetTimeMin;  // Reset period (0 = one-time, 1440 = daily)
  uint32 lastResetMin;  // Timestamp of last reset (minutes)
  uint16 nonce;         // Increments on each allowance change
}`}</CodeBlock>

        <div className="text-[11px] text-zinc-600 leading-relaxed">
          <span className="text-zinc-400">Contract address:</span>{' '}
          <code className="text-[10px] bg-white/[0.04] px-1 rounded break-all">
            0xCFbFaC74C26F8647cBDb8c5caf80BB5b32E43134
          </code>{' '}
          (canonical across Gnosis, Ethereum, Polygon, etc.)
        </div>
      </div>
    ),
  },

  // ── Page 6: Defense in depth ──────────────────────────
  {
    title: 'Defense in Depth',
    subtitle: 'Multiple independent security layers',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          Haven&apos;s security model uses <span className="text-zinc-200">layered defenses</span>.
          Every layer is independent &mdash; compromising one does not compromise the others.
        </p>

        <div className="space-y-2">
          {[
            {
              layer: 'Layer 1',
              name: 'Safe smart account',
              desc: 'Multi-owner, threshold signatures. Only owners can modify modules, delegates, and allowances. Funds are held here.',
              color: 'text-emerald-400 bg-emerald-500/10',
            },
            {
              layer: 'Layer 2',
              name: 'AllowanceModule (on-chain)',
              desc: 'Hard enforcement of per-token, per-delegate limits. Enforced in the EVM — cannot be bypassed by any off-chain system.',
              color: 'text-indigo-400 bg-indigo-500/10',
            },
            {
              layer: 'Layer 3',
              name: 'Haven policy engine (off-chain)',
              desc: 'Additional soft policies: recipient allowlists, category restrictions, approval thresholds. Full audit trail of every intent.',
              color: 'text-violet-400 bg-violet-500/10',
            },
            {
              layer: 'Layer 4',
              name: 'Credential scoping',
              desc: 'API keys are independently revocable and time-limited. Revoking an API key immediately blocks the agent from Haven\'s API.',
              color: 'text-amber-400 bg-amber-500/10',
            },
          ].map((l) => (
            <div
              key={l.layer}
              className="flex items-start gap-3 p-3 rounded-lg border border-white/[0.06] bg-white/[0.02]"
            >
              <span
                className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0 mt-0.5 ${l.color}`}
              >
                {l.layer}
              </span>
              <div>
                <p className="text-xs text-zinc-200 font-medium">{l.name}</p>
                <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">{l.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="text-[11px] text-zinc-500 leading-relaxed bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2">
          <span className="text-zinc-300 font-medium">Worst-case scenario:</span> If Haven&apos;s servers are fully compromised,
          the attacker still cannot move funds beyond each agent&apos;s on-chain allowance. The Safe owner
          can revoke all delegates immediately from Safe&#123;Wallet&#125; without needing Haven at all.
        </div>
      </div>
    ),
  },
]

// ── Modal component ────────────────────────────────────────────────

interface Props {
  open: boolean
  onClose: () => void
}

export default function HowItWorksModal({ open, onClose }: Props) {
  const [page, setPage] = useState(0)

  if (!open) return null

  const current = PAGES[page]
  const isFirst = page === 0
  const isLast = page === PAGES.length - 1

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-[#0e0e0e] border border-white/[0.08] rounded-2xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/[0.06] flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-zinc-200">{current.title}</h2>
            <p className="text-xs text-zinc-600 mt-0.5">{current.subtitle}</p>
          </div>
          <button
            onClick={() => { setPage(0); onClose() }}
            className="text-zinc-700 hover:text-zinc-400 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Page dots */}
        <div className="flex items-center justify-center gap-1.5 px-6 py-3 border-b border-white/[0.04] flex-shrink-0">
          {PAGES.map((_, i) => (
            <button
              key={i}
              onClick={() => setPage(i)}
              className={`h-1.5 rounded-full transition-all duration-200 ${
                i === page
                  ? 'w-6 bg-indigo-500'
                  : 'w-1.5 bg-white/[0.1] hover:bg-white/[0.2]'
              }`}
            />
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {current.content}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/[0.06] flex-shrink-0">
          <button
            onClick={() => setPage((p) => p - 1)}
            disabled={isFirst}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-0 disabled:cursor-default transition-colors flex items-center gap-1"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Previous
          </button>

          <span className="text-[10px] text-zinc-700">
            {page + 1} / {PAGES.length}
          </span>

          {isLast ? (
            <button
              onClick={() => { setPage(0); onClose() }}
              className="text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Done
            </button>
          ) : (
            <button
              onClick={() => setPage((p) => p + 1)}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors flex items-center gap-1"
            >
              Next
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
