'use client'

import { ArrowDown, ArrowUp, Bot, Check, Circle, EllipsisVertical, Info, TriangleAlert, X } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input, MaxButton, PasteButton } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Checkbox } from '@/components/ui/Checkbox'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { Table } from '@/components/ui/Table'
import { SidePanel } from '@/components/ui/SidePanel'
import { StepProgress } from '@/components/ui/StepProgress'
import { CodeBlock } from '@/components/ui/CodeBlock'
import ConfirmDialog from '@/components/ConfirmDialog'
import ComingSoonModal from '@/components/ComingSoonModal'
import InfoModal, { type InfoPage } from '@/components/InfoModal'
import { PageHeader } from '@/components/ui/PageHeader'
import { Row } from '@/components/ui/Row'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/Toast'
import DashboardOnboardingGuide from '@/components/DashboardOnboardingGuide'
import {
  AgentBudgetCard,
  Address,
  AgentRulesSummary,
  Amount,
  ApprovalRequiredBanner,
  CredentialHandoffCard,
  DirectionMark,
  ExternalDetailsLink,
  RiskExplainer,
  TransactionActivityRow,
  TransactionMovement,
  WalletIdentityBlock,
} from '@/components/haven'

const sampleAddress = '0x8f4F0f6d712C5c5C9Bb02F4a5B5c0D7F462A6f4C'

const modalInfoPages: InfoPage[] = [
  {
    title: 'Modal patterns',
    subtitle: 'Consistent dialog behavior',
    content: (
      <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
        Dialogs keep their title and actions available while long content scrolls within the panel.
      </p>
    ),
  },
  {
    title: 'Paged explainers',
    subtitle: 'Guide one idea at a time',
    content: (
      <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
        Use the page controls for short, optional explainers. They stay accessible by keyboard and reset when the dialog closes.
      </p>
    ),
  },
]

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-[var(--v2-ink)]">{title}</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--v2-ink-2)]">{description}</p>
      </div>
      {children}
    </section>
  )
}

function LoadingCard() {
  return (
    <div role="status" aria-busy="true" aria-live="polite">
      <Card hover={false} className="p-5">
        <Skeleton variant="text" className="h-4 w-28" />
        <Skeleton className="mt-5 h-8 w-40" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-12 rounded-[10px] bg-[var(--v2-surface)]" />
          <Skeleton className="h-12 rounded-[10px] bg-[var(--v2-surface)]" />
        </div>
        <span className="sr-only">Loading example content</span>
      </Card>
    </div>
  )
}

function MovementExample({ from, to }: { from: string; to: string }) {
  return <TransactionMovement from={from} to={to} />
}

/** Generic placeholder icon for demos — the shared Icon convention. */
function DotIcon() {
  return <Icon icon={Circle} className="h-full w-full" />
}

export default function DesignSystemPage() {
  const [modalOpen, setModalOpen] = useState(false)
  const [infoModalOpen, setInfoModalOpen] = useState(false)
  const [comingSoonOpen, setComingSoonOpen] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [checkboxOn, setCheckboxOn] = useState(true)
  const [sampleAmount, setSampleAmount] = useState('')
  const { toast } = useToast()

  return (
    <div className="mx-auto max-w-6xl space-y-10">
      <PageHeader
        eyebrow="Internal reference"
        title="Haven design system"
        subtitle="The source of truth for Haven UI. Compose what's here before inventing new visual treatments — and add a new entry here in the same PR if you do."
        actions={
          <Button variant="ghost" size="sm" onClick={() => toast.info('Use shared primitives before adding a new pattern.')}>
            Show toast
          </Button>
        }
      />

      <Section
        title="How to use this page"
        description="Treat this as the contract for what a Haven screen looks and feels like. The workflow keeps the design language tight as the product grows."
      >
        <Card hover={false} className="p-5">
          <ol className="space-y-3 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            <li>
              <span className="font-medium text-[var(--v2-ink)]">1. Look here first.</span> Before building a
              new screen or polishing an existing one, scan this page for the primitive, pattern, or domain
              component that fits. Most needs are covered.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">2. Compose, don&apos;t reinvent.</span> Build
              your surface from <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">@/components/ui</code>
              {' '}and <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">@/components/haven</code>{' '}
              exports. If you find yourself duplicating markup that already exists, refactor toward the
              shared primitive.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">3. Add new entries in the same PR.</span> If
              the system genuinely lacks what you need — a new colour token, a new primitive, a new pattern
              — add it here alongside the implementation. Reviewers gate this: a PR that introduces a new
              UI shape without updating this page should be sent back.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">4. Mind the copy conventions.</span> See the
              Copy section near the bottom for the user-facing language rules (we say <em>account</em>, not
              <em> Safe</em>; sentence case for modal titles, etc.).
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">5. CI enforces this.</span> The design-lint
              gate (<code className="rounded bg-[var(--v2-surface)] px-1 text-xs">npm run design:lint -w packages/frontend</code>)
              {' '}fails a PR across two rule families. <em>Token rules</em> catch a bypassed token: raw Tailwind
              palette classes, hardcoded hex colours, or new{' '}
              <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">text-[10px]</code>/<code className="rounded bg-[var(--v2-surface)] px-1 text-xs">text-[11px]</code>. {/* prose mention, not a use — design-lint-disable-line */}
              {' '}<em>Structural rules</em> catch a re-hand-rolled component: a hand-rolled grey header band
              (use <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">Card.Header</code>), a raw table
              element (use the <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">Table</code> primitive),
              an inline SVG element (use <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">Icon</code>{' '}
              + a lucide glyph), or a hand-rolled address slice (use{' '}
              <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">&lt;Address&gt;</code>) — each exempts
              its own primitive's home file. Marketing/landing surfaces (brand, marketing, the landing page,
              protocols, investor-briefing, how-it-works) are intentionally bespoke and exempt; the
              product app and this page stay fully gated. Existing debt lives in a shrink-only baseline
              (<code className="rounded bg-[var(--v2-surface)] px-1 text-xs">design-lint-baseline.json</code>) —
              counts may only go down. Route colours through{' '}
              <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">var(--v2-…)</code> tokens and reach
              for the shared primitive instead.
            </li>
          </ol>
        </Card>
      </Section>

      <Section
        title="Colour tokens"
        description="Semantic colours, defined in `globals.css` as CSS custom properties. Always reference via `var(--v2-…)` — never hardcode hex. Each base colour ships a `-soft` variant for fills."
      >
        <Card hover={false} className="p-5">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                name: '--v2-brand',
                soft: '--v2-brand-soft',
                use: 'Primary actions, links, brand identity.',
                swatch: 'border-[var(--v2-brand)]/30 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]',
              },
              {
                name: '--v2-success',
                soft: '--v2-success-soft',
                use: 'Incoming payments, completed states, positive money movement.',
                swatch: 'border-[var(--v2-success)]/30 bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
              },
              {
                name: '--v2-debit',
                soft: '--v2-debit-soft',
                use: 'Outgoing payments, sent money. Sibling to success — never use for warnings.',
                swatch: 'border-[var(--v2-debit)]/30 bg-[var(--v2-debit-soft)] text-[var(--v2-debit)]',
              },
              {
                name: '--v2-warning',
                soft: '--v2-warning-soft',
                use: 'Needs attention, paused states, soft caution. Not for irreversible actions.',
                swatch: 'border-[var(--v2-warning)]/30 bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]',
              },
              {
                name: '--v2-danger',
                soft: '--v2-danger-soft',
                use: 'Errors, failures, destructive confirmations (revoke / delete).',
                swatch: 'border-[var(--v2-danger)]/30 bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]',
              },
              {
                name: '--v2-ink / -2 / -3',
                soft: '—',
                use: 'Text hierarchy. -ink is primary, -ink-2 secondary, -ink-3 quietest.',
                swatch: 'border-[var(--v2-border)] bg-white text-[var(--v2-ink)]',
              },
            ].map((token) => (
              <div
                key={token.name}
                className="flex gap-3 rounded-[10px] border border-[var(--v2-border)] bg-white p-3"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[10px] border ${token.swatch}`}
                >
                  <Icon icon={Circle} className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <p className="font-mono text-xs font-medium text-[var(--v2-ink)]">{token.name}</p>
                  <p className="font-mono text-xs text-[var(--v2-ink-3)]">{token.soft}</p>
                  <p className="mt-1 text-xs leading-snug text-[var(--v2-ink-2)]">{token.use}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            <span className="font-medium text-[var(--v2-ink-2)]">Money colour rule:</span>{' '}
            <span className="text-[var(--v2-success)]">incoming = success green</span>,{' '}
            <span className="text-[var(--v2-debit)]">outgoing = debit sky</span>,{' '}
            <span className="text-[var(--v2-danger)]">failed = danger red</span>. The direction icon carries
            the colour. Outgoing amount text stays neutral ink so the row reads calm — only the icon
            carries the signal.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            <span className="font-medium text-[var(--v2-ink-2)]">Contrast guarantee:</span> every ink and
            semantic text token meets WCAG AA (≥4.5:1) on white, its own soft fill, and the tinted
            surfaces. Guarded by <code className="rounded bg-[var(--v2-surface)] px-1">token-contrast.test.ts</code> —
            change a token and the test tells you if it still clears the bar.
          </p>
          <div className="mt-4 border-t border-[var(--v2-border)] pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">
              Chain identity
            </p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
              <code className="rounded bg-[var(--v2-surface)] px-1">--v2-chain-*</code> tells networks
              apart (Base, Gnosis, testnet) in <code className="rounded bg-[var(--v2-surface)] px-1">NetworkPill</code>{' '}
              and <code className="rounded bg-[var(--v2-surface)] px-1">NetworkSwitcher</code>. These are{' '}
              <span className="font-medium text-[var(--v2-ink)]">identity</span> colours, deliberately outside the
              semantic rules — never reuse a chain colour for success/warning meaning, and never route money
              tone through them.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-4">
              {[
                { label: 'Base', dot: 'var(--v2-chain-base)' },
                { label: 'Gnosis', dot: 'var(--v2-chain-gnosis)' },
                { label: 'Testnet', dot: 'var(--v2-chain-testnet)' },
              ].map((chain) => (
                <span key={chain.label} className="inline-flex items-center gap-1.5 text-xs text-[var(--v2-ink-2)]">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: chain.dot }}
                  />
                  {chain.label}
                </span>
              ))}
            </div>
          </div>
        </Card>
      </Section>

      <Section
        title="Typography"
        description="The type ramp lives in globals.css as v2-text-* utility classes (size + leading + weight + tracking in one class). Rule: page and section headings go through the ramp; within components, body copy uses Tailwind's text-sm and metadata uses text-xs — those two map to the ramp's body and meta steps. Ad-hoc pixel sizes (text-[Npx]) are off-system; the design-lint gate blocks new ones."
      >
        <Card hover={false} className="space-y-4 p-5">
          {[
            { cls: 'v2-text-display', label: 'v2-text-display · 40/48 — hero numbers (dashboard balance)' },
            { cls: 'v2-text-h1', label: 'v2-text-h1 · 28/34 — page titles (PageHeader)' },
            { cls: 'v2-text-h2', label: 'v2-text-h2 · 20/28 — section titles' },
            { cls: 'v2-text-h3', label: 'v2-text-h3 · 16/24 — card titles' },
            { cls: 'v2-text-body', label: 'v2-text-body · 14/22 — body copy (= text-sm)' },
            { cls: 'v2-text-meta', label: 'v2-text-meta · 12/18 — metadata, captions (= text-xs)' },
          ].map((t) => (
            <div key={t.cls} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <span className={`${t.cls} text-[var(--v2-ink)]`}>Pay 50 USDC</span>
              <span className="text-xs text-[var(--v2-ink-3)]">{t.label}</span>
            </div>
          ))}
        </Card>
      </Section>

      <Section
        title="Spacing & radius"
        description="The implicit scale, made explicit. Radius: cards and inner tiles are 10px (rounded-[10px]); marketing heroes 24px; buttons, inputs and selects rounded-md; badges/pills rounded-full. Card padding: p-5 default, p-6 for page-level section cards (Card.Header uses px-5 py-4 / spacious px-6 py-5). Vertical rhythm: space-y-10 between page sections, gap-4/gap-5 inside grids, mt-2 title→body, mt-4/mt-5 body→action."
      >
        <Card hover={false} className="p-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-5 text-center">
              <p className="text-sm font-medium text-[var(--v2-ink)]">rounded-[10px]</p>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">cards, tiles, tables</p>
            </div>
            <div className="rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] p-5 text-center">
              <p className="text-sm font-medium text-[var(--v2-ink)]">rounded-md</p>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">buttons, inputs, selects</p>
            </div>
            <div className="rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface)] p-5 text-center">
              <p className="text-sm font-medium text-[var(--v2-ink)]">rounded-full</p>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">badges, pills, icon halos</p>
            </div>
          </div>
        </Card>
      </Section>

      <Section
        title="Icons"
        description="One icon family, one weight. Every UI icon is a lucide-react glyph rendered through the shared `Icon` wrapper (`@/components/ui/Icon`) — stroke 1.5, decorative by default (`aria-hidden`), sized via className. Never inline a raw SVG element; the only exemptions are brand marks in `components/brand` and marketing pages."
      >
        <Card hover={false} className="p-5">
          <div className="flex flex-wrap items-center gap-5">
            {[
              { icon: Bot, name: 'Bot' },
              { icon: ArrowDown, name: 'ArrowDown' },
              { icon: ArrowUp, name: 'ArrowUp' },
              { icon: Check, name: 'Check' },
              { icon: X, name: 'X' },
              { icon: Info, name: 'Info' },
              { icon: TriangleAlert, name: 'TriangleAlert' },
              { icon: EllipsisVertical, name: 'EllipsisVertical' },
            ].map((entry) => (
              <div key={entry.name} className="flex flex-col items-center gap-1.5">
                <span className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)]">
                  <Icon icon={entry.icon} className="h-4 w-4" />
                </span>
                <p className="font-mono text-xs text-[var(--v2-ink-3)]">{entry.name}</p>
              </div>
            ))}
          </div>
          <ul className="mt-4 space-y-1.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
            <li>
              <span className="font-medium text-[var(--v2-ink)]">Usage:</span>{' '}
              <code className="rounded bg-[var(--v2-surface)] px-1">{'<Icon icon={Check} className="h-4 w-4" />'}</code>{' '}
              — size with className (or the numeric <code className="rounded bg-[var(--v2-surface)] px-1">size</code> prop
              where a pixel value is passed through), colour with a text token on the icon or its parent.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">Stroke:</span> 1.5 everywhere. Overriding{' '}
              <code className="rounded bg-[var(--v2-surface)] px-1">strokeWidth</code> requires a comment at the call
              site explaining why (e.g. a large empty-state hero that reads too heavy at 1.5).
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">Accessibility:</span> icons are decorative by default.
              Pass <code className="rounded bg-[var(--v2-surface)] px-1">label</code> only when the icon is the sole
              carrier of meaning and the surrounding control has no <code className="rounded bg-[var(--v2-surface)] px-1">aria-label</code>.
            </li>
            <li>
              <span className="font-medium text-[var(--v2-ink)]">Adding a glyph:</span> pick the closest lucide icon —
              do not draw a custom SVG. If a concept genuinely has no lucide glyph, raise it in the PR rather than
              inlining markup.
            </li>
          </ul>
        </Card>
      </Section>

      <Section
        title="Primitives"
        description="Core controls use the v2 token system from globals.css and the shared UI components."
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <Card hover={false} className="p-5">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Buttons and badges</h3>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button>Primary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="tertiary">Tertiary</Button>
              <Button variant="danger">Danger</Button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button size="sm" variant="ghost">Small</Button>
              <Button size="md" variant="ghost">Medium</Button>
              <Button size="lg" variant="ghost">Large</Button>
            </div>
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--v2-ink-2)]">
              Sizes paint at 36 / 40 / 44px. Small and medium carry an invisible
              44px-tall tap target that reaches past their painted edge, so a compact
              button in a row list stays comfortable to hit on a phone without
              loosening the layout around it. The target grows vertically only —
              widening it would let a button steal taps from its neighbour in a tight
              toolbar.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <StatusBadge tone="success">Received</StatusBadge>
              <StatusBadge tone="warning">Needs approval</StatusBadge>
              <StatusBadge tone="danger">Failed</StatusBadge>
              <StatusBadge tone="brand">Connected</StatusBadge>
              <StatusBadge>Draft</StatusBadge>
            </div>
          </Card>

          <Card hover={false} className="p-5">
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Inputs, feedback, and modal</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-[var(--v2-ink-3)]">
                Amount
                <Input
                  className="mt-1 v2-tabular"
                  placeholder="0.00"
                  value={sampleAmount}
                  onChange={(event) => setSampleAmount(event.target.value)}
                  rightAction={<MaxButton onClick={() => setSampleAmount('250.00')} />}
                  helperText="Use Max when the full balance should be sent."
                />
              </label>
              <label className="block text-xs font-medium text-[var(--v2-ink-3)]">
                Recipient address
                <Input
                  className="mt-1 font-mono"
                  defaultValue=""
                  placeholder="0x..."
                  rightAction={<PasteButton onPaste={() => toast.success('Address pasted')} />}
                  invalid
                  helperText="Paste a valid wallet address."
                />
              </label>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Tooltip label={sampleAddress} mono>
                <button
                  type="button"
                  className="rounded font-mono text-xs text-[var(--v2-ink-2)] underline decoration-[var(--v2-border-strong)] underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
                >
                  0x8f4F...a6f4
                </button>
              </Tooltip>
              <Button variant="ghost" size="sm" onClick={() => setModalOpen(true)}>
                Open modal
              </Button>
              <Button size="sm" onClick={() => toast.success('Address copied')}>
                Copy feedback
              </Button>
            </div>
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <Card hover={false} className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Flat (default)</p>
            <p className="mt-2 text-sm font-semibold text-[var(--v2-ink)]">Standard card</p>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              The default. One page can have many flat cards. Hover lift on interactive variants.
            </p>
          </Card>

          <Card hover={false} elevation="anchor" className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--v2-brand)]">Anchor</p>
            <p className="mt-2 text-sm font-semibold text-[var(--v2-ink)]">Secondary focal point</p>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
              Use for the second-most-important surface on a page (pending approvals, agent status). Cooler off-white background, brand-tinted hairline.
            </p>
          </Card>

          <Card hover={false} elevation="raised" className="p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Raised</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
              $4,280.35
            </p>
            <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
              The single page hero (balance, total). Hover lift suppressed — it's already prominent.
            </p>
          </Card>
        </div>
      </Section>

      <Section
        title="Surface hierarchy — no nested filled cards"
        description="One tinted surface per surface tier. Don't reach for a grey inner wrapper to 'group' siblings inside a Card — use Card.Section (white-on-white hairline) or Card.Section divided (row list). Tinted surfaces are reserved for callouts, table headers, anchor cards, chips, code blocks, and overlay surfaces."
      >
        <div className="grid gap-5 lg:grid-cols-2">
          {/* ❌ Anti-pattern */}
          <div>
            <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--v2-danger)]">
              <span aria-hidden="true">❌</span> Avoid — grey card inside white card
            </p>
            <Card hover={false} className="p-5">
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Agent access</h3>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                Connected agents can request payments from this wallet.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {[
                  { name: 'Research assistant', budget: '250 USDC per day' },
                  { name: 'Travel planner', budget: '0.10 ETH per day' },
                ].map((agent) => (
                  <div
                    key={agent.name}
                    className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3"
                  >
                    <p className="text-sm font-medium text-[var(--v2-ink)]">{agent.name}</p>
                    <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{agent.budget}</p>
                  </div>
                ))}
              </div>
            </Card>
            <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
              Two competing surface tiers, repeated boilerplate, and the inner tiles fight the card's lift. Replace with a row list.
            </p>
          </div>

          {/* ✅ Recommended */}
          <div>
            <p className="mb-2 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--v2-success)]">
              <span aria-hidden="true">✅</span> Use — Card.Section divided + Row
            </p>
            <Card hover={false}>
              <div className="px-5 pt-5">
                <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Agent access</h3>
                <p className="mt-1 pb-5 text-xs text-[var(--v2-ink-3)]">
                  Connected agents can request payments from this wallet.
                </p>
              </div>
              <Card.Section divided>
                <Row
                  title="Research assistant"
                  subtitle="250 USDC per day"
                  trailing={<StatusBadge tone="brand">Connected</StatusBadge>}
                  href="#"
                />
                <Row
                  title="Travel planner"
                  subtitle="0.10 ETH per day"
                  trailing={<StatusBadge tone="warning">Paused</StatusBadge>}
                  href="#"
                />
              </Card.Section>
            </Card>
            <p className="mt-2 text-xs text-[var(--v2-ink-3)]">
              One surface tier. Dividers do the grouping work, chips and pills stay tinted as inline tokens.
            </p>
          </div>
        </div>
      </Section>

      <Section
        title="Layering — the z-index scale"
        description="Every stacking layer has a named token in globals.css. Reach for a token, never a fresh number: two independently chosen values (a z-[100] top bar over a z-[60] navigation toggle) left the mobile sidebar toggle painted and hit-tested under the top bar on every authenticated route, and a third ad-hoc number is how that recurs. Tiers are spaced by 10 so a genuinely new layer lands between two without renumbering."
      >
        {/* `collapseBelowMd={false}` + `overflow-x-auto`: Table.Head hides the
            header below md on the assumption that mobile rows carry their own
            labels. These rows are a bare token, a bare integer and a
            description — nothing self-labelling — so at 390px the table would
            otherwise open on "--v2-z-content / 10 / …" with no way to tell
            which column is which. This is exactly the case the primitive's own
            docstring names, and it is paired with the horizontal scroll that
            docstring asks for. */}
        <Card hover={false} className="overflow-hidden">
          <div className="overflow-x-auto">
          <Table className="min-w-[560px]">
            <Table.Head collapseBelowMd={false}>
              <tr>
                <Table.HeaderCell align="left">Token</Table.HeaderCell>
                <Table.HeaderCell align="left">Value</Table.HeaderCell>
                <Table.HeaderCell align="left">What lives here</Table.HeaderCell>
              </tr>
            </Table.Head>
            <Table.Body>
              {[
                ['--v2-z-content', '10', 'In-flow overlaps: badges, gradient washes'],
                ['--v2-z-sticky', '20', 'Sticky table headers'],
                ['--v2-z-chrome', '100', 'TopBar — the app shell’s own bar'],
                ['--v2-z-chrome-popover', '110', 'Popovers anchored in the chrome (notifications, wallet, user menu)'],
                ['--v2-z-nav-scrim', '130', 'Mobile drawer scrim'],
                ['--v2-z-nav-drawer', '140', 'Mobile drawer itself'],
                ['--v2-z-nav-toggle', '150', 'The Open / Close sidebar toggle'],
                ['--v2-z-modal', '200', 'Modal, SidePanel'],
                ['--v2-z-tooltip', '210', 'Tooltip'],
                ['--v2-z-panel', '250', 'AgentPanel'],
                ['--v2-z-toast', '9999', 'Toast, and the skip-to-content link'],
              ].map(([token, value, what]) => (
                <tr key={token}>
                  <td className="px-4 py-2.5 align-top">
                    <code className="rounded bg-[var(--v2-surface)] px-1 text-xs text-[var(--v2-ink)]">{token}</code>
                  </td>
                  <td className="px-4 py-2.5 align-top text-sm text-[var(--v2-ink-2)] v2-tabular">{value}</td>
                  <td className="px-4 py-2.5 align-top text-sm text-[var(--v2-ink-2)]">{what}</td>
                </tr>
              ))}
            </Table.Body>
          </Table>
          </div>
        </Card>
        <Card hover={false} className="p-5">
          <h3 className="text-sm font-semibold text-[var(--v2-ink)]">
            The rule the numbers encode
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            The mobile navigation overlay outranks the app chrome it slides over, and modals
            outrank the navigation. That direction is not arbitrary. The drawer is{' '}
            <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">inset-y-0</code>, so its
            own logo band shares the top 56px with the bar; its scrim exists to dim everything
            behind it, and “everything” includes the bar. Let the bar win and the drawer is
            decapitated, the scrim dims all but the top strip, and the toggle — which sits inside
            that strip by design, in the gap the bar reserves for it — cannot be tapped at all.
            Modals sit above both, because a dialog opened from a nav link has to cover the drawer.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-[var(--v2-ink-2)]">
            Adding a layer means picking the tier it belongs to, not picking a number. If none of
            the tiers fits, add one to the scale here first — a raw{' '}
            <code className="rounded bg-[var(--v2-surface)] px-1 text-xs">z-[…]</code> in a shell
            component is the failure this table exists to prevent.
          </p>
        </Card>
      </Section>

      <Section
        title="Card.Header — the titled grey band"
        description="Give a Card a titled header with Card.Header — never hand-roll the border-b + bg-surface band. Slots: `title` (heading level via `as`, default h3), optional `description`, optional right-aligned `actions`. Pass `children` instead for bespoke content (badges, balances). Padding: default (px-5 py-4), `spacious` (px-6 py-5) for page-level section cards, `none` when the caller owns padding. Parent Card needs `overflow-hidden` (or add `rounded-t-[10px]` via className)."
      >
        <Card hover={false} className="max-w-xl overflow-hidden">
          <Card.Header
            title="Connected agents"
            description="Agents that can request payments from this account."
            actions={<Button variant="ghost" size="sm">View all</Button>}
          />
          <Card.Section divided>
            <Row title="Research assistant" subtitle="250 USDC per day" trailing={<StatusBadge tone="brand">Connected</StatusBadge>} />
            <Row title="Travel planner" subtitle="0.10 ETH per day" trailing={<StatusBadge tone="warning">Paused</StatusBadge>} />
          </Card.Section>
        </Card>
      </Section>

      <Section
        title="Amount & Address — the two core display objects"
        description="Render money through <Amount> and on-chain addresses through <Address> — never hand-roll signs, tone classes, or slice(0, 6) truncation. Amount encodes the calm-money rule structurally: neutral ink by default, success only for incoming, danger only for failed; callers pass facts (direction, failed), never colours. Address applies the one truncation rule (0x1234…abcd), monospace, the full value in a tooltip, and optional copy / explorer-link affordances."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <Card hover={false} className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">Amount</p>
            <div className="mt-3 space-y-2 text-sm">
              <p><Amount value="250.00" symbol="USDC" /> <span className="text-xs text-[var(--v2-ink-3)]">— signless figure (budgets, balances)</span></p>
              <p><Amount value="12.00" symbol="USDC" direction="in" /> <span className="text-xs text-[var(--v2-ink-3)]">— incoming: the quiet success green</span></p>
              <p><Amount value="12.00" symbol="USDC" direction="out" /> <span className="text-xs text-[var(--v2-ink-3)]">— outgoing stays neutral; direction colour lives in DirectionMark</span></p>
              <p><Amount value="80.00" symbol="USDC" direction="out" failed /> <span className="text-xs text-[var(--v2-ink-3)]">— failed: the only red money gets</span></p>
              <p><Amount value="320.00" symbol="USDC" direction="out" size="lg" /> <span className="text-xs text-[var(--v2-ink-3)]">— size=&quot;lg&quot; for detail-panel headlines</span></p>
            </div>
          </Card>
          <Card hover={false} className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">Address</p>
            <div className="mt-3 space-y-2 text-sm text-[var(--v2-ink-2)]">
              <p><Address value={sampleAddress} /> <span className="text-xs text-[var(--v2-ink-3)]">— hover for the full address</span></p>
              <p><Address value={sampleAddress} copy /> <span className="text-xs text-[var(--v2-ink-3)]">— with check-pop copy</span></p>
              <p><Address value={sampleAddress} href="https://basescan.org" /> <span className="text-xs text-[var(--v2-ink-3)]">— explorer link with ↗</span></p>
              <p className="break-all text-xs"><Address value={sampleAddress} truncate={false} /> <span className="text-[var(--v2-ink-3)]">— full form for receive surfaces</span></p>
            </div>
          </Card>
        </div>
      </Section>

      <Section
        title="Card.Section — nested content without grey-on-white"
        description="When you need to group content inside a card, use Card.Section instead of a grey inner wrapper. Renders a hairline top border that bleeds to the card's edges — the canonical way to subsection a card. Pass `divided` for a row list (auto row dividers, no horizontal padding so child rows own theirs)."
      >
        <Card hover={false} className="p-5">
          <div>
            <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Operating wallet</h3>
            <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Base · 0x8f4F…6f4C</p>
          </div>
          <Card.Section className="mt-5 pt-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Holdings</p>
            <dl className="mt-2 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-[var(--v2-ink-2)]">USDC</dt>
              <dd className="text-right v2-tabular text-[var(--v2-ink)]">4,280.35</dd>
              <dt className="text-[var(--v2-ink-2)]">ETH</dt>
              <dd className="text-right v2-tabular text-[var(--v2-ink)]">0.482</dd>
            </dl>
          </Card.Section>
          <Card.Section className="mt-5 pt-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--v2-ink-3)]">Approvers</p>
            <p className="mt-2 text-sm text-[var(--v2-ink-2)]">2 of 3 approvers required</p>
          </Card.Section>
        </Card>
        <p className="text-xs text-[var(--v2-ink-3)]">
          Reserve <code className="font-mono">inset</code> only for code blocks or quote-style content — the default hairline style is the standard. Use <code className="font-mono">divided</code> for any in-card list of rows.
        </p>
      </Section>

      <Section
        title="Row — the canonical list item"
        description="One primitive for every list row in the app. Slots: leading icon (with optional tinted circle), title, subtitle, trailing. Hover and focus styles are baked in for interactive variants. Density toggles between comfortable lists and compact panels."
      >
        <Card hover={false} className="overflow-hidden">
          <Row
            leading={<DotIcon />}
            leadingTone="brand"
            title="Operating wallet"
            subtitle="Base · 0x8f4F…6f4C"
            trailing={<StatusBadge tone="brand">Default</StatusBadge>}
            href="#"
          />
          <Row
            leading={<DotIcon />}
            leadingTone="success"
            title="Trip wallet"
            subtitle="Base · 0x31bc…8d04"
            trailing={<span className="v2-tabular text-sm font-semibold text-[var(--v2-ink)]">75.00 USDC</span>}
            href="#"
          />
          <Row
            leading={<DotIcon />}
            leadingTone="warning"
            title="Research assistant"
            subtitle="Needs approval · 2 pending"
            trailing={<StatusBadge tone="warning">Review</StatusBadge>}
            accent
            href="#"
          />
        </Card>
        <Card hover={false} className="overflow-hidden">
          <Row
            density="compact"
            leading={<DotIcon />}
            title="Compact row"
            subtitle="Tighter padding for dense panels"
            trailing={<span className="text-xs text-[var(--v2-ink-3)]">12m ago</span>}
          />
          <Row
            density="compact"
            leading={<DotIcon />}
            title="Static row"
            subtitle="No href / onClick — renders as a div, no hover"
          />
        </Card>
      </Section>

      <Section
        title="Dropdown menu (kebab)"
        description="Overflow menu used for account-, agent-, or row-level settings that shouldn't compete with the page's primary CTAs. The trigger is usually a `⋮` icon button (10×10 / h-10 to match Button md). Items support a `tone='danger'` for destructive actions and a `<DropdownMenuSeparator />` between groups."
      >
        <Card hover={false} className="p-5">
          <div className="flex flex-wrap items-center gap-6">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account options"
                className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-[var(--v2-border)] bg-white text-[var(--v2-ink-2)] transition-colors hover:border-[var(--v2-border-strong)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
              >
                <Icon icon={EllipsisVertical} className="h-4 w-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => toast.info('Edit agent')}>Edit agent</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => toast.info('Update budget')}>Update budget</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => toast.info('Payment credentials')}>
                  Payment credentials
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem tone="danger" onSelect={() => toast.error('Remove (demo only)')}>
                  Remove agent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <p className="max-w-md text-xs leading-relaxed text-[var(--v2-ink-3)]">
              Used on `/agents/[id]` and `/accounts/[id]` page headers. Click-outside + Escape dismiss,
              arrow-key roving focus, ARIA roles wired. Use sparingly — visible CTAs are still preferred
              when there are only one or two actions.
            </p>
          </div>
        </Card>
      </Section>

      <Section
        title="Select"
        description="The styled native <select>. Same height, radius, border and focus ring as Input so mixed form rows align. Passes through all native select attributes."
      >
        <Card hover={false} className="max-w-sm p-5">
          <div className="space-y-3">
            <Select defaultValue="week" aria-label="Budget period">
              <option value="day">per day</option>
              <option value="week">per week</option>
              <option value="month">per month</option>
            </Select>
            <Select disabled defaultValue="usdc" aria-label="Token (disabled)">
              <option value="usdc">USDC</option>
            </Select>
          </div>
        </Card>
      </Section>

      <Section
        title="Textarea"
        description="The multi-line half of the Input family — same radius, surface, padding, focus ring and invalid/disabled treatment, so a description field under a name field belongs to the same form. resize-none by default. Reach for it instead of a raw <textarea>."
      >
        <Card hover={false} className="max-w-sm p-5">
          <div className="space-y-3">
            <Textarea rows={2} placeholder="What does this agent do?" aria-label="Description" />
            <Textarea
              rows={2}
              invalid
              defaultValue="Too long…"
              helperText="Keep it under 200 characters."
              aria-label="Description (invalid)"
            />
            <Textarea rows={2} disabled defaultValue="Read-only" aria-label="Description (disabled)" />
          </div>
        </Card>
      </Section>

      <Section
        title="Checkbox"
        description="The styled native checkbox with its label row built in — every use in Haven is a box plus an explanation, so the flex row is part of the primitive. Native + accent-color on purpose: keyboard behaviour, focus ring and screen-reader semantics come from the platform. Wrapping <label> makes the text a click target with no id/htmlFor wiring."
      >
        <Card hover={false} className="max-w-sm p-5">
          <div className="space-y-3 text-xs leading-relaxed text-[var(--v2-ink-2)]">
            <Checkbox
              checked={checkboxOn}
              onChange={(event) => setCheckboxOn(event.target.checked)}
              label="Issue an Agent Passport — a signed, revocable record that this agent was issued by Haven."
            />
            <Checkbox
              defaultChecked={false}
              label="With helper text"
              helperText="A second line for the consequence, not the choice."
            />
            <Checkbox disabled label="Disabled — the label dims with the box." />
          </div>
        </Card>
      </Section>

      <Section
        title="SidePanel"
        description="Right-hand detail drawer — used for transaction details. Title + optional subtitle header, Escape/backdrop dismiss, focus trapped while open. Reach for it when a Row click needs more detail than a modal question."
      >
        <Card hover={false} className="p-5">
          <Button variant="ghost" onClick={() => setPanelOpen(true)}>Open side panel</Button>
        </Card>
      </Section>

      <Section
        title="StepProgress"
        description="Thin step indicator for multi-step flows (connect agent, onboarding). 0-indexed currentStep; pass totalSteps as currentStep to render everything completed."
      >
        <Card hover={false} className="max-w-sm space-y-4 p-5">
          <StepProgress totalSteps={3} currentStep={0} />
          <StepProgress totalSteps={3} currentStep={1} />
          <StepProgress totalSteps={3} currentStep={3} />
        </Card>
      </Section>

      <Section
        title="ConfirmDialog"
        description="Styled replacement for window.confirm. Defaults to tone danger (destructive actions: revoke, delete, disconnect); tone primary for consequential-but-safe confirmations. Supports confirmDisabled while the action runs and confirmButtonWrapper for guards like network switching."
      >
        <Card hover={false} className="p-5">
          <Button variant="ghost" onClick={() => setConfirmOpen(true)}>Open confirm dialog</Button>
        </Card>
      </Section>

      <Section
        title="Toast"
        description="Transient feedback via useToast() — success for completed user actions, error for failures the user must know about, info for neutral notices. One line, no actions inside the toast; anything requiring a decision belongs in a dialog. Toaster mounts once in the app shell."
      >
        <Card hover={false} className="p-5">
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" size="sm" onClick={() => toast.success('Budget set — it refills itself every period.')}>toast.success</Button>
            <Button variant="ghost" size="sm" onClick={() => toast.error('Could not stop the budget. Try again.')}>toast.error</Button>
            <Button variant="ghost" size="sm" onClick={() => toast.info('Agent reconnected.')}>toast.info</Button>
          </div>
        </Card>
      </Section>

      <Section
        title="CodeBlock"
        description="Dark monospace block for terminal commands and credential snippets. Optional filename header row with a check-pop copy button; onCopy fires only when the clipboard write succeeded (used for handoff telemetry)."
      >
        <div className="max-w-xl">
          <CodeBlock filename="Terminal" onCopy={() => toast.success('Command copied')}>
            npx @haven_ai/connect@alpha
          </CodeBlock>
        </div>
      </Section>

      <Section
        title="Direction marks (in / out / pending)"
        description="One shared `<DirectionMark>` for every transaction row in the app. Incoming uses success green, outgoing uses debit sky, pending uses neutral grey. Density `compact` (32px) for dashboard rows, `comfortable` (36px, default) for the dedicated transactions table."
      >
        <Card hover={false} className="p-5">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="in" />
              <p className="text-xs text-[var(--v2-ink-3)]">in · comfortable</p>
            </div>
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="out" />
              <p className="text-xs text-[var(--v2-ink-3)]">out · comfortable</p>
            </div>
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="neutral" />
              <p className="text-xs text-[var(--v2-ink-3)]">pending · comfortable</p>
            </div>
            <div className="ml-4 flex flex-col items-center gap-1">
              <DirectionMark direction="in" density="compact" />
              <p className="text-xs text-[var(--v2-ink-3)]">in · compact</p>
            </div>
            <div className="flex flex-col items-center gap-1">
              <DirectionMark direction="out" density="compact" />
              <p className="text-xs text-[var(--v2-ink-3)]">out · compact</p>
            </div>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            Don&apos;t reinline this markup. If you need a new direction state, add it to{' '}
            <code className="rounded bg-[var(--v2-surface)] px-1">DirectionMark</code> and document it here.
          </p>
        </Card>
      </Section>

      <Section
        title="Empty states"
        description="One component, three sizes — never hand-roll a dashed tile. `default` for page/section-level empties (icon halo, roomy). `compact` for in-card previews and side columns. `inline` for a one-line placeholder inside dense content (title only). Pick a tone that matches the meaning (brand for default, warning for attention, success after a completed flow). Dashed borders on non-empty content (draft forms, status callouts) are a different pattern and stay hand-rolled."
      >
        <div className="grid gap-5 lg:grid-cols-3">
          <EmptyState
            icon={<DotIcon />}
            tone="brand"
            title="No agents yet"
            body="Create an agent to give it a budget and rules. Haven asks for approval when it tries to spend more."
            action={<Button size="sm">Create agent</Button>}
          />
          <EmptyState
            icon={<DotIcon />}
            tone="warning"
            title="One agent needs attention"
            body="A scheduled payment is above its remaining budget. Approve or reject it before it expires."
            action={<Button size="sm" variant="ghost">Open approvals</Button>}
          />
          <EmptyState
            icon={<DotIcon />}
            tone="success"
            title="You're all caught up"
            body="No pending approvals. Agents will keep working within their budgets."
          />
        </div>
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">size=&quot;compact&quot; — in-card previews</p>
            <EmptyState
              size="compact"
              title="Activity preview unavailable"
              body="Haven could not refresh recent payments right now."
              action={<Button variant="ghost" size="sm">Try again</Button>}
            />
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--v2-ink-3)]">size=&quot;inline&quot; — dense content</p>
            <EmptyState size="inline" title="No budget set yet" />
          </div>
        </div>
      </Section>

      <Section
        title="First-run setup"
        description="A three-step checklist anchors a new user. Each step's status is computed independently from real state — agents and funds can be completed in any order. The active step gets the primary CTA; later steps lock until their prerequisite lands. When all three are done, the guide collapses to a Setup complete banner."
      >
        <div className="max-w-3xl space-y-4">
          {/* Active: fund step open, agent + payment steps still pending. */}
          <DashboardOnboardingGuide
            hasFunds={false}
            hasAgents={false}
            hasFirstAgentPayment={false}
            onReceiveFunds={() => undefined}
            onAddAgent={() => undefined}
            onShowAgentUsage={() => undefined}
            onDismiss={() => undefined}
            onDismissComplete={() => undefined}
            inProgressDismissed={false}
            completeDismissed={false}
          />
          {/* All three done — the celebration banner. */}
          <DashboardOnboardingGuide
            hasFunds
            hasAgents
            hasFirstAgentPayment
            onReceiveFunds={() => undefined}
            onAddAgent={() => undefined}
            onShowAgentUsage={() => undefined}
            onDismiss={() => undefined}
            onDismissComplete={() => undefined}
            inProgressDismissed={false}
            completeDismissed={false}
          />
        </div>
      </Section>

      <Section
        title="Agent budget flow"
        description="These examples anchor the first Haven-domain component layer. They explain what the agent can spend without exposing implementation details."
      >
        <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
          <AgentBudgetCard
            agentName="Research assistant"
            walletName="Operating wallet"
            budgets={[{ tokenSymbol: 'USDC', amount: '250', period: 'per day' }]}
            status="Ready to review"
          >
            <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
              Requests above the remaining daily budget will wait for your approval.
            </p>
          </AgentBudgetCard>

          <AgentBudgetCard
            agentName="Travel planner"
            walletName="Trip wallet"
            budgets={[
              { tokenSymbol: 'USDC', amount: '1', period: 'per day' },
              { tokenSymbol: 'ETH', amount: '1', period: 'per day' },
            ]}
            status="Budget draft"
            onRemoveBudget={() => {}}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
          <AgentRulesSummary
            items={[
              {
                label: 'Agent name',
                value: 'Research assistant',
                helper: 'This agent can request payments using its Haven credential.',
              },
              {
                label: 'Spend from',
                value: 'Operating wallet',
                helper: 'Payments come from this Haven wallet only.',
              },
              {
                label: 'Budget',
                value: '250 USDC per day',
                helper: 'Haven asks for approval when a request is above the remaining budget.',
              },
            ]}
          />
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <ApprovalRequiredBanner tone="neutral">
            Agents can still initiate payments above the remaining budget, but you approve them manually before any money moves.
          </ApprovalRequiredBanner>
          <RiskExplainer
            items={[
              'The agent can make payments automatically while it stays within the budget.',
              'You can pause or revoke the agent from its detail page.',
              'Haven asks for approval before requests above the remaining budget are paid.',
            ]}
          />
        </div>
      </Section>

      <Section
        title="Credential handoff"
        description="Use an action-required card for post-setup credentials. The full credential file should be the default because it includes the context an agent needs."
      >
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <CredentialHandoffCard
            title="Save the credential file"
            description="Download or copy this file before closing. Your agent needs it to make payments within the rules you set."
            primaryAction={<Button className="w-full">Download file</Button>}
            secondaryAction={<Button className="w-full" variant="ghost">Copy file</Button>}
            note="This credential is shown once. Haven cannot show it again after the window closes."
          />
          <AgentBudgetCard
            agentName="Research assistant"
            walletName="Operating wallet"
            budgets={[{ tokenSymbol: 'USDC', amount: '250', period: 'per day' }]}
            status="Connected"
            statusTone="success"
            density="compact"
          />
        </div>
      </Section>

      <Section
        title="Approvals and pending actions"
        description="Approval requests lead with the money, show who asked, and make the wallet-to-recipient path readable before the user approves or rejects."
      >
        <div className="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <Card hover={false} className="overflow-hidden border-[var(--v2-warning)]/25">
            <Card.Header>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="warning">Needs approval</StatusBadge>
                  <StatusBadge>x402 payment</StatusBadge>
                </div>
                <span className="text-xs text-[var(--v2-ink-3)]">Expires in 1 hour</span>
              </div>
            </Card.Header>
            <div className="space-y-5 p-5">
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.9fr)]">
                <div>
                  <p className="text-xs font-medium text-[var(--v2-ink-3)]">Payment request</p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                    48.00 USDC
                  </p>
                  <p className="mt-3 text-sm leading-relaxed text-[var(--v2-ink-2)]">
                    Research assistant asked to send this payment. Nothing moves until you approve it.
                  </p>
                </div>
                <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                  <TransactionMovement from="Operating wallet" to="api.vendor.com" />
                  <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div>
                      <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Agent</dt>
                      <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Research assistant</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Network</dt>
                      <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Base</dd>
                    </div>
                  </dl>
                </div>
              </div>
              <ApprovalRequiredBanner title="Approval required" tone="neutral" density="compact">
                This payment is above the remaining agent budget.
              </ApprovalRequiredBanner>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" size="sm">Reject</Button>
                <Button size="sm">Approve payment</Button>
              </div>
            </div>
          </Card>

          <div className="space-y-4">
            <ApprovalRequiredBanner title="Approved, not sent yet" tone="neutral" density="compact">
              This request was approved but still needs to be completed before the payment is sent.
            </ApprovalRequiredBanner>
            <EmptyState
              title="No payments need approval"
              body="When an agent asks to spend above its budget, the request will appear here before any money moves."
            />
          </div>
        </div>
      </Section>

      <Section
        title="Manual payment review"
        description="Manual sends use the same money-first review structure as approvals: amount first, then the wallet-to-recipient path and approval context."
      >
        <Card hover={false} className="max-w-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-[var(--v2-ink-3)]">You are sending</p>
              <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--v2-ink)] v2-tabular">
                125.00 USDC
              </p>
            </div>
            <StatusBadge>Ready to send</StatusBadge>
          </div>
          <div className="mt-5 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <TransactionMovement from="Operating wallet" to="Acme Services" />
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Haven wallet</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Operating wallet</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Recipient</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Acme Services</dd>
                <dd className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">0x7a58...91c2</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Network</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Base</dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-[var(--v2-ink-3)]">Approve with</dt>
                <dd className="mt-1 text-sm font-medium text-[var(--v2-ink)]">Device approval</dd>
              </div>
            </dl>
          </div>
          <p className="mt-3 text-xs text-[var(--v2-ink-3)]">
            Network fees are paid by Haven (ETH).
          </p>
          <div className="mt-5 flex gap-3">
            <Button variant="ghost" className="flex-1">Back</Button>
            <Button className="flex-1">Approve and send</Button>
          </div>
        </Card>
      </Section>

      <Section
        title="Contacts and recipients"
        description="Recipient surfaces show names first, keep wallet addresses subordinate, and preserve direct address entry for one-off payments."
      >
        <Card hover={false} className="max-w-xl overflow-hidden p-0">
          <Card.Header
            title="Saved recipients"
            description="Use names for people and services you pay often. Confirm the network in Send."
            actions={
              <Button size="sm" className="flex-shrink-0 whitespace-nowrap">
                Add contact
              </Button>
            }
          />
          {[
            ['Acme Services', '0x7a58...91c2'],
            ['Research API', '0x31bc...8d04'],
          ].map(([name, address]) => (
            <div key={name} className="flex items-center gap-3 border-b border-[var(--v2-border)] px-5 py-3 last:border-b-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--v2-brand)]/20 bg-[var(--v2-brand-soft)]">
                <span className="text-xs font-semibold text-[var(--v2-brand)]">{name.slice(0, 2).toUpperCase()}</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{name}</p>
                <p className="mt-0.5 font-mono text-xs text-[var(--v2-ink-3)]">{address}</p>
              </div>
              <StatusBadge tone="neutral">Recipient</StatusBadge>
            </div>
          ))}
        </Card>
      </Section>

      <Section
        title="Receive funds"
        description="Manual funding surfaces must make the Haven wallet, network, supported tokens, and copy action obvious before the user sends anything on-chain."
      >
        <Card hover={false} className="max-w-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--v2-ink)]">Operating wallet</p>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">Base</p>
            </div>
            <StatusBadge>On-chain receive</StatusBadge>
          </div>
          <div className="mt-5 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Haven wallet address</p>
            <p className="mt-2 break-all font-mono text-sm text-[var(--v2-ink)]">{sampleAddress}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm">Copy address</Button>
              <Button variant="ghost" size="sm">Show QR code</Button>
              <Button variant="ghost" size="sm" href="#" target="_blank" rel="noopener noreferrer">
                View on explorer
              </Button>
            </div>
          </div>
          <div className="mt-4 rounded-[10px] border border-[var(--v2-border)] bg-white p-4">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">Supported on Base</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {['ETH', 'USDC'].map((token) => (
                <span
                  key={token}
                  className="rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface)] px-2.5 py-1 text-xs font-medium text-[var(--v2-ink-2)]"
                >
                  {token}
                </span>
              ))}
            </div>
          </div>
          <div className="mt-4 rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <p className="text-sm font-semibold text-[var(--v2-ink)]">Before you send</p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--v2-ink-2)]">
              Use the Base network, send only supported tokens, and wait for the on-chain transfer to confirm.
            </p>
          </div>
        </Card>
      </Section>

      <Section
        title="Wallet and activity"
        description="Wallet identity and activity rows should make account context readable without making raw addresses the primary object."
      >
        <div className="grid gap-5 lg:grid-cols-[360px_1fr]">
          <WalletIdentityBlock
            name="Operating wallet"
            network="Base"
            address={sampleAddress}
            balance="$4,280.35 available"
          />

          <Card hover={false} className="overflow-hidden">
            <Card.Header title="Recent agent activity" />
            <TransactionActivityRow
              direction="out"
              title="x402 payment"
              description={<MovementExample from="Research assistant" to="API provider" />}
              value="12.00"
              asset="USDC"
              status="Sent"
              statusTone="neutral"
            />
            <TransactionActivityRow
              direction="out"
              title="Approval request"
              description={<MovementExample from="Research assistant" to="Cloud vendor" />}
              value="320.00"
              asset="USDC"
              status="Needs approval"
              statusTone="warning"
            />
            <TransactionActivityRow
              direction="out"
              title="Payment rejected"
              description={<MovementExample from="Research assistant" to="Unknown vendor" />}
              value="80.00"
              asset="USDC"
              failed
              status="Failed"
              statusTone="danger"
            />
          </Card>
        </div>
      </Section>

      <Section
        title="Transaction history"
        description="Tables render through the Table primitive: Table.Head (collapses below md, optional sticky), Table.HeaderCell (srLabel for icon columns, hideBelowMd for the responsive-collapse pattern), Table.SortableHeaderCell (aria-sort + focus-ring button + chevron), Table.Body (one row-border rule). Cell content stays plain <td>. Compact TransactionActivityRow remains for dashboard, account, and agent previews."
      >
        <Card hover={false} className="overflow-hidden">
          <Table>
            <Table.Head>
              <tr>
                <Table.HeaderCell srLabel="Direction" className="w-10" />
                <Table.HeaderCell align="left">Activity</Table.HeaderCell>
                <Table.HeaderCell align="left" hideBelowMd>Initiator</Table.HeaderCell>
                <Table.HeaderCell align="left" hideBelowMd>From / To</Table.HeaderCell>
                <Table.SortableHeaderCell label="Date" direction="desc" onSort={() => toast.info('Sorts the loaded set')} hideBelowMd />
                <Table.SortableHeaderCell label="Amount" direction={null} onSort={() => toast.info('Sorts the loaded set')} align="right" />
                <Table.HeaderCell srLabel="External details" className="w-8" />
              </tr>
            </Table.Head>
            <Table.Body>
              {[
                {
                  title: 'Received payment',
                  from: 'Acme Operations',
                  to: 'Operating wallet',
                  initiator: 'You',
                  date: '12m ago',
                  value: '500.00',
                  direction: 'in' as const,
                  failed: false,
                },
                {
                  title: 'x402 payment by Research assistant',
                  from: 'Operating wallet',
                  to: 'API provider',
                  initiator: 'Research assistant',
                  date: '1h ago',
                  value: '12.00',
                  direction: 'out' as const,
                  failed: false,
                },
                {
                  title: 'Failed payment by Research assistant',
                  from: 'Operating wallet',
                  to: 'unknown.vendor',
                  initiator: 'Research assistant',
                  date: '2h ago',
                  value: '25.00',
                  direction: 'out' as const,
                  failed: true,
                },
              ].map((row) => (
                <tr key={row.title}>
                  {/* Narrow gutters below md mirror TransactionsTable (#1772).
                      Without them this showcase rendered 375px wide inside a
                      343px Card at 393px — clipped by the Card's
                      `overflow-hidden`, i.e. the very defect the table below
                      is meant to document the correct shape of. */}
                  <td className="px-2 py-4 align-middle md:px-4">
                    <DirectionMark direction={row.direction} />
                  </td>
                  {/* `max-w-0` BELOW md ONLY. Unconditional, it squashed the
                      Activity column on DESKTOP too — the visual-regression
                      gate caught "Recei…" / "x402 …" / "Faile…" at 1280px.
                      TransactionsTable survives it unconditionally because
                      every other column there carries an explicit `w-[…]`, so
                      the leftover flows to Activity; this showcase sizes its
                      columns purely from content, so capping one collapses it.
                      Do not drop the `md:` here. */}
                  <td className="max-w-0 px-4 py-4 align-middle md:max-w-none">
                    {/* `truncate` + `flex-wrap` mirror TransactionsTable
                        exactly (#1772). Without `truncate` the `max-w-0`
                        above word-wraps instead of ellipsising, so the
                        showcase would teach a shape the real component does
                        not have. */}
                    {/* `md:flex-nowrap` for the same reason as `md:max-w-none`
                        above: this showcase's desktop titles WRAP to two
                        lines, so a wrapping flex row pushed the Failed badge
                        onto a third and grew the page by 12px. The visual
                        gate measured it — 17746 -> 17758 — after the first
                        attempt at this fix. Desktop must not move at all. */}
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-nowrap">
                      {/* Ellipsise below md, wrap normally at md and up — the
                          `md:` half restores this showcase's original desktop
                          rendering byte for byte, so only the mobile baseline
                          moves. */}
                      <p
                        className="truncate text-sm font-semibold text-[var(--v2-ink)] md:overflow-visible md:whitespace-normal md:text-clip"
                        title={row.title}
                      >
                        {row.title}
                      </p>
                      {row.failed ? <StatusBadge tone="danger">Failed</StatusBadge> : null}
                    </div>
                    <div className="mt-1 md:hidden">
                      <TransactionMovement from={row.from} to={row.to} />
                    </div>
                  </td>
                  <td className="hidden px-4 py-4 align-middle text-sm text-[var(--v2-ink-2)] md:table-cell">
                    {row.initiator}
                  </td>
                  <td className="hidden px-4 py-4 align-middle md:table-cell">
                    <TransactionMovement from={row.from} to={row.to} />
                  </td>
                  <td className="hidden px-4 py-4 align-middle text-sm text-[var(--v2-ink-3)] md:table-cell">
                    {row.date}
                  </td>
                  <td className="px-2 py-4 align-middle text-right md:px-4">
                    <p>
                      <Amount value={row.value} symbol="USDC" direction={row.direction} failed={row.failed} />
                    </p>
                    <p className="mt-1 text-xs text-[var(--v2-ink-3)] md:hidden">{row.date}</p>
                  </td>
                  <td className="px-2 py-4 align-middle text-right md:px-4">
                    <ExternalDetailsLink href="#" />
                  </td>
                </tr>
              ))}
            </Table.Body>
          </Table>
        </Card>
      </Section>

      <Section
        title="Card with action footer (manage pattern)"
        description="When a card has both content and contextual actions, use `AgentRulesSummary`'s `footer` slot (or any card with a `border-t` action row) instead of a separate aside card. Keeps related actions adjacent to the data they affect and avoids empty right-rail real estate."
      >
        <AgentRulesSummary
          title="Agent budget"
          description="What this agent can spend, where the money comes from, and how you stay in control."
          items={[
            {
              label: 'Agent name',
              value: 'Research assistant',
              helper: 'Connected via Haven credential.',
            },
            {
              label: 'Spend from',
              value: 'Operating wallet on Base',
              helper: 'Payments come from this Haven account only.',
            },
            {
              label: 'Budget',
              value: '250 USDC per day',
              helper: 'Payments within budget can run automatically. Larger payments need your manual approval.',
            },
          ]}
          footer={
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-[var(--v2-ink-3)]">
                Pause the agent or revoke its budget if you need to stop access.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" size="sm">
                  Update budget
                </Button>
                <Button variant="ghost" size="sm">
                  Pause agent
                </Button>
                <Button variant="danger" size="sm">
                  Revoke agent budget
                </Button>
              </div>
            </div>
          }
        />
      </Section>

      <Section
        title="Wallet-gate captions"
        description="When an action is gated on a connected / correctly-networked wallet, render a quiet info-icon caption above the (disabled) primary button — NEVER a yellow alert block beside or instead of the button. The yellow background reads as interactive. Helpers live in `OnchainActionGate` / `NetworkGate` and apply everywhere automatically."
      >
        <Card hover={false} className="p-5">
          <div className="space-y-4">
            <div>
              <p
                role="status"
                className="mb-2 flex items-start gap-2 text-xs text-[var(--v2-ink-3)]"
              >
                <Icon icon={Info} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>Connect a wallet to update this agent budget.</span>
              </p>
              <div className="flex gap-3">
                <Button variant="ghost" className="flex-1">Back</Button>
                <Button disabled className="flex-1">Update budget</Button>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
              <span className="font-medium text-[var(--v2-ink-2)]">Pattern:</span> caption above, disabled
              primary button below. For a network-mismatch the same caption sits above a ghost{' '}
              <code className="rounded bg-[var(--v2-surface)] px-1">Switch wallet to {'{chain}'}</code>{' '}
              button (white background, brand focus ring) instead of the primary action.
            </p>
          </div>
        </Card>
      </Section>

      <Section
        title="Copy conventions"
        description="The words we use are part of the design system. Follow these rules so the product reads as one voice."
      >
        <Card hover={false} className="p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Account, not Safe</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Users see <span className="font-medium">account</span>. The Safe contract abstraction stays
                in code (<code className="text-xs">safeId</code>,{' '}
                <code className="text-xs">UserSafe</code>, etc.). The word <em>Safe</em> should not
                appear in any rendered string.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Sentence case</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Modal titles, section headings, button labels — all sentence case. <em>"Edit agent"</em>,
                not <em>"Edit Agent"</em>. <em>"Update budget"</em>, not <em>"Update Budget"</em>.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Money is calm</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Amount text stays neutral ink — even for outgoing payments. The direction icon carries the
                colour signal (green / sky / red). Don&apos;t tint amounts unless they failed.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Action verbs match the noun</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Pause the <em>agent</em>, not <em>requests</em>. Revoke the <em>budget</em>, not{' '}
                <em>access</em>. The label should describe the user&apos;s mental model, not the
                implementation detail.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Confirm destructive actions</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Anything that can&apos;t be reversed (revoke, remove account, remove token budget, delete
                agent) opens a <code className="text-xs">ConfirmDialog</code> with a clear destructive
                button label. Reversible actions (pause / resume) don&apos;t need confirmation.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Quiet for hints, loud for failures</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Wallet gates, summary captions, "loaded results" — caption-grey. Errors and failed states
                — danger red. Don&apos;t mix the two.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="ghost" size="sm" onClick={() => setInfoModalOpen(true)}>
              Open paged explainer
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setComingSoonOpen(true)}>
              Open compact dialog
            </Button>
          </div>
        </Card>
      </Section>

      <Section
        title="Info modals (InfoStep + InfoNote)"
        description="Multi-step explainer modals (Contacts info, Using your agent) use the paged InfoModal primitive. Inside each page, compose with `InfoStep` for numbered explanations and `InfoNote` for footnotes / tinted asides — both export from `@/components/InfoModal`."
      >
        <Card hover={false} className="p-5">
          <p className="text-xs leading-relaxed text-[var(--v2-ink-3)]">
            Open <code className="rounded bg-[var(--v2-surface)] px-1">UsingYourAgentInfo</code> or{' '}
            <code className="rounded bg-[var(--v2-surface)] px-1">ContactsInfo</code> from the dashboard to
            see them in flight. Helpers in <code className="rounded bg-[var(--v2-surface)] px-1">InfoModal.tsx</code>:
          </p>
          <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">
            <li>
              <code className="rounded bg-[var(--v2-surface)] px-1">&lt;InfoStep number={1} title="..."&gt;</code>{' '}
              — numbered brand-soft circle + 14px title + 13px body. Use 1–3 per page.
            </li>
            <li>
              <code className="rounded bg-[var(--v2-surface)] px-1">&lt;InfoNote label="..."&gt;</code>{' '}
              — tinted footnote box for caveats / "where do I find this?" asides.
            </li>
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-[var(--v2-ink-3)]">
            <span className="font-medium text-[var(--v2-ink-2)]">Don&apos;t inline 11px helper text</span> —
            grep the codebase: if you see <code className="text-xs">text-[10px]</code> or{' '}{/* literal examples shown to the reader — design-lint-disable-line */}
            <code className="text-xs">text-[11px]</code>{/* design-lint-disable-line */} inside a modal, it&apos;s probably a missed
            migration. Bump to <code className="text-xs">text-xs</code> or compose with the helpers.
          </p>
        </Card>
      </Section>

      <Section
        title="Modal"
        description="Use the shared Modal for every dialog shell. It keeps focus, Escape, focus return, backdrop treatment, and short-viewport scrolling consistent while callers compose the content."
      >
        <Card hover={false} className="p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Widths</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Choose <code className="rounded bg-[var(--v2-surface)] px-1">sm</code>,{' '}
                <code className="rounded bg-[var(--v2-surface)] px-1">md</code>,{' '}
                <code className="rounded bg-[var(--v2-surface)] px-1">lg</code>, or{' '}
                <code className="rounded bg-[var(--v2-surface)] px-1">xl</code> for the content, not the page.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Header</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Dialog panels are white with a compact <code className="rounded bg-[var(--v2-surface)] px-1">text-sm</code>{' '}
                title. Add a subtitle, close button, or header accessory when the flow needs them.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Long content</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                The panel caps at the viewport and only its body scrolls, keeping the header and actions available.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-[var(--v2-ink)]">Close behavior</h3>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Backdrop, Escape, and the optional close button dismiss ordinary dialogs. Disable only the affordances an active execution step must protect.
              </p>
            </div>
          </div>
        </Card>
      </Section>

      <Section
        title="States"
        description="Important Haven screens need stable loading, empty, and error states because AI-generated UX often only covers the happy path."
      >
        <div className="grid gap-5 lg:grid-cols-3">
          <LoadingCard />
          <EmptyState
            title="No agent budgets yet"
            body="Create a budget to let an agent make payments within rules you control."
            action={<Button size="sm">Create agent budget</Button>}
          />
          <EmptyState
            title="We could not load this wallet"
            body="Check your network connection, then try again. Existing agent budgets are unchanged."
            action={<Button size="sm" variant="ghost">Try again</Button>}
          />
        </div>
      </Section>

      <Section
        title="Mobile density"
        description="Cards should stack cleanly and keep the money and approval boundary visible on narrow screens."
      >
        <div className="max-w-sm rounded-[14px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
          <div className="space-y-3">
            <AgentBudgetCard
              agentName="Travel planner"
              walletName="Trip wallet"
              budgets={[{ tokenSymbol: 'USDC', amount: '75', period: 'total budget' }]}
              status="Connected"
              statusTone="success"
            />
            <ApprovalRequiredBanner title="You stay in control" tone="neutral">
              Anything above 75 USDC waits for your manual approval before it is paid.
            </ApprovalRequiredBanner>
          </div>
        </div>
      </Section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Confirm agent budget"
        subtitle="Review the agent budget before connecting this agent."
        showCloseButton
        width="lg"
        headerAccessory={<StepProgress totalSteps={4} currentStep={2} />}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModalOpen(false)}>Save budget</Button>
          </>
        }
      >
        Confirm the agent budget before connecting your agent. Requests above the remaining
        budget will wait for approval.
      </Modal>

      <InfoModal
        open={infoModalOpen}
        onClose={() => setInfoModalOpen(false)}
        pages={modalInfoPages}
      />

      <ComingSoonModal
        open={comingSoonOpen}
        onClose={() => setComingSoonOpen(false)}
      />

      <SidePanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        title="x402 payment"
        subtitle="Operating wallet · just now"
      >
        <p className="text-sm text-[var(--v2-ink-2)]">
          Detail content goes here — the transactions route uses this panel for per-transaction
          breakdowns (amount, movement, initiator, receipts).
        </p>
      </SidePanel>

      {confirmOpen ? (
        <ConfirmDialog
          open
          title="Stop this budget?"
          body="The agent will no longer be able to pay from this budget. You can set a new one at any time."
          confirmLabel="Stop budget"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => setConfirmOpen(false)}
        />
      ) : null}
    </div>
  )
}
