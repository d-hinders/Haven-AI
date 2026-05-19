'use client'

import InfoModal, { InfoNote, InfoStep, type InfoPage } from './InfoModal'

const PAGES: InfoPage[] = [
  {
    title: 'Contacts',
    subtitle: 'Your address book for Haven',
    content: (
      <div className="space-y-5">
        <p className="text-sm leading-relaxed text-[var(--v2-ink-2)]">
          Contacts let you{' '}
          <span className="font-medium text-[var(--v2-ink)]">label recipient addresses</span> with
          human-readable names. Once saved, contact names can replace raw addresses throughout Haven.
        </p>

        <div className="space-y-3">
          <InfoStep number={1} title="Save recipient addresses with names">
            Add a contact by pasting a wallet address and giving it a name. Each address can only be saved once
            per Haven account. The payment network is confirmed when you send.
          </InfoStep>

          <InfoStep number={2} title="Names appear everywhere">
            Transaction history, Send, and other views can show the contact name with the raw{' '}
            <code className="rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-[12px] text-[var(--v2-ink)]">
              0x…
            </code>{' '}
            address kept subordinate.
          </InfoStep>

          <InfoStep number={3} title="Quick select when sending">
            When sending a payment, choose from saved recipients or paste a wallet address directly.
          </InfoStep>
        </div>

        <InfoNote label="Privacy:">
          Contacts are stored in Haven&apos;s database linked to your account. They are not published on-chain
          and are not visible to anyone else.
        </InfoNote>
      </div>
    ),
  },
]

interface Props {
  open: boolean
  onClose: () => void
}

export default function ContactsInfo({ open, onClose }: Props) {
  return <InfoModal open={open} onClose={onClose} pages={PAGES} />
}
