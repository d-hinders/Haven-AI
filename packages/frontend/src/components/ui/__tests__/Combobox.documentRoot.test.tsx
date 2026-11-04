import { fireEvent, within } from '@testing-library/react'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Combobox, type ComboboxGroup } from '../Combobox'
import { Modal } from '../Modal'

// `Combobox.test.tsx` mounts React in a `div`, so the synthetic
// `stopPropagation` stops the event before it reaches `document`. The deployed
// app is not built that way: Next's App Router makes `document` the React root,
// so React's own listener and `Modal`'s share one node and `stopPropagation`
// cannot separate them. The walkthrough on epic #4637 found the first Escape
// closing Send while every case in that file passed.
//
// This file stands alone on purpose. Any earlier render in the same document
// sets React's per-document listener marker, and `createRoot(document)` would
// then register nothing, so this case must be the first React root it sees.

const GROUPS: ComboboxGroup[] = [
  {
    id: 'contacts',
    label: 'Contacts',
    options: [{ id: 'contact:1', title: 'Acme Services', subtitle: 'Saved contact · 0x2c9d…77ab' }],
  },
]

function ModalHarness() {
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Send">
      <Combobox
        label="Recipient"
        query={query}
        onQueryChange={setQuery}
        groups={GROUPS}
        onPick={() => {}}
      />
    </Modal>
  )
}

describe('Combobox — Escape when document is the React root, as under the App Router', () => {
  let root: Root
  let originalHtml: HTMLElement

  // `screen` holds the original `body`, which this root replaces.
  const page = () => within(document.body)

  beforeEach(() => {
    originalHtml = document.documentElement
    root = createRoot(document)
    act(() => {
      root.render(
        <html>
          <head />
          <body>
            <ModalHarness />
          </body>
        </html>,
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    if (!document.documentElement) document.appendChild(originalHtml)
  })

  it('walks the three stages: list, then query, then the dialog', () => {
    const input = page().getByRole('combobox', { name: 'Recipient' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ac' } })
    expect(page().getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(page().queryByRole('listbox')).not.toBeInTheDocument()
    expect(input).toHaveValue('ac')
    expect(page().getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    expect(page().getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(page().queryByRole('dialog')).not.toBeInTheDocument()
  })
})
