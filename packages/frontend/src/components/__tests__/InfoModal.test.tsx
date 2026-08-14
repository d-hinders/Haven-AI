import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import InfoModal, { type InfoPage } from '../InfoModal'

const pages: InfoPage[] = [
  { title: 'First page', subtitle: 'Start here', content: <p>First content</p> },
  { title: 'Second page', subtitle: 'Continue here', content: <p>Second content</p> },
]

function ReopenableInfoModal() {
  const [open, setOpen] = useState(true)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open info</button>
      <InfoModal open={open} onClose={() => setOpen(false)} pages={pages} />
    </>
  )
}

describe('InfoModal', () => {
  it('keeps paged content and resets to the first page after closing', () => {
    render(<ReopenableInfoModal />)

    expect(screen.getByRole('heading', { name: 'First page' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('heading', { name: 'Second page' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open info' }))
    expect(screen.getByRole('heading', { name: 'First page' })).toBeInTheDocument()
  })
})
