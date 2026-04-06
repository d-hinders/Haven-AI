'use client'

import InfoModal, { DiagramBox, Arrow, type InfoPage } from './InfoModal'

const PAGES: InfoPage[] = [
  {
    title: 'Dashboard Overview',
    subtitle: 'Your Safe at a glance',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          The dashboard shows a <span className="text-zinc-200">real-time snapshot</span> of your
          Safe smart account &mdash; portfolio value, token balances, and recent activity.
        </p>

        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">1</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Portfolio value</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                Shows total fiat value (USD or EUR) of all tokens in your Safe. Prices
                are fetched from CoinGecko and update each time you load the page.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">2</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Token balances</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                Individual balances for xDAI (native), USDC.e, and EURe. Each is read
                directly from the Gnosis Chain RPC &mdash; not a database snapshot.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">3</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Recent transactions</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                The last 5 transactions on your Safe, fetched from the Safe Transaction Service.
                Agent-initiated transfers are labelled with the agent name.
              </p>
            </div>
          </div>
        </div>
      </div>
    ),
  },

  {
    title: 'Safe Smart Account',
    subtitle: 'How your funds are held',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          Your funds live in a <span className="text-zinc-200">Safe smart account</span> on Gnosis Chain &mdash; a battle-tested
          multi-signature contract wallet used by DAOs, protocols, and individuals holding billions
          in assets.
        </p>

        <div className="flex flex-col items-center gap-1 py-2">
          <DiagramBox label="Your wallet (EOA)" sub="MetaMask, Rabby, etc." />
          <Arrow />
          <DiagramBox label="Safe smart account" sub="Holds all funds on-chain" accent />
          <Arrow />
          <DiagramBox label="Gnosis Chain" sub="Low-cost EVM network" />
        </div>

        <div className="space-y-3 text-xs text-zinc-500 leading-relaxed">
          <div className="flex gap-2">
            <span className="text-indigo-400 mt-0.5 flex-shrink-0">&#8226;</span>
            <p><span className="text-zinc-300">Non-custodial</span> &mdash; Haven never holds your keys or funds. You control the Safe.</p>
          </div>
          <div className="flex gap-2">
            <span className="text-indigo-400 mt-0.5 flex-shrink-0">&#8226;</span>
            <p><span className="text-zinc-300">Multi-owner</span> &mdash; Add multiple owners and require N-of-M signatures for transactions.</p>
          </div>
          <div className="flex gap-2">
            <span className="text-indigo-400 mt-0.5 flex-shrink-0">&#8226;</span>
            <p><span className="text-zinc-300">Module-extensible</span> &mdash; Safe modules (like the AllowanceModule) add features without changing the core contract.</p>
          </div>
        </div>
      </div>
    ),
  },

  {
    title: 'Sending Transactions',
    subtitle: 'How payments work from your Safe',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          When you send a transaction from the dashboard, Haven constructs a
          Safe-compatible transaction that you sign in your connected wallet.
        </p>

        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">1</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Choose recipient and amount</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                Pick from your contacts or paste an address. Select the token and amount.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">2</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Sign with your wallet</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                Haven builds an EIP-712 typed Safe transaction. You sign it in MetaMask or your
                connected wallet. If your Safe has a threshold &gt; 1, it&apos;s proposed for co-signer approval.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-emerald-400">3</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Transaction executes on-chain</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                For single-owner Safes, the transaction is submitted immediately.
                The transfer shows up in your transaction history within seconds.
              </p>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-zinc-600 bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2 leading-relaxed">
          <span className="text-zinc-400">Gnosis Chain</span> has ~5s block times and
          transaction fees under $0.01, making it ideal for frequent payments.
        </div>
      </div>
    ),
  },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function DashboardInfo({ open, onClose }: Props) {
  return <InfoModal open={open} onClose={onClose} pages={PAGES} />
}
