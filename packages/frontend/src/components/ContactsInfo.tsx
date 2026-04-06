'use client'

import InfoModal, { type InfoPage } from './InfoModal'

const PAGES: InfoPage[] = [
  {
    title: 'Contacts',
    subtitle: 'Your address book for the Safe',
    content: (
      <div className="space-y-5">
        <p className="text-sm text-zinc-400 leading-relaxed">
          Contacts let you <span className="text-zinc-200">label Ethereum addresses</span> with human-readable
          names. Once saved, contact names replace raw addresses throughout Haven.
        </p>

        <div className="space-y-3">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">1</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Save addresses with names</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                Add a contact by pasting an Ethereum address and giving it a name.
                Each address can only be saved once per account.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">2</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Names appear everywhere</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                Transaction history, the send modal, and other views will show
                the contact name instead of the raw <code className="text-[10px] bg-white/[0.04] px-1 rounded">0x...</code> address.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]">
            <div className="w-6 h-6 rounded-full bg-indigo-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-bold text-indigo-400">3</span>
            </div>
            <div>
              <p className="text-xs text-zinc-200 font-medium">Quick select when sending</p>
              <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                When sending a payment, start typing a contact name in the recipient field.
                Haven will auto-complete the address for you.
              </p>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-zinc-600 bg-white/[0.02] border border-white/[0.06] rounded-lg px-3 py-2 leading-relaxed">
          <span className="text-zinc-400">Privacy:</span> Contacts are stored in Haven&apos;s database linked to your
          account. They are not published on-chain and are not visible to anyone else.
        </div>
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
