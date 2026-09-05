import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DeviceApprovalClient from '../DeviceApprovalClient'

/**
 * The device-approval screen (#2526).
 *
 * The screen where a human grants a session to something they cannot see. What
 * it must get right is the sentence, not the layout, so that is what these
 * assert: the scope in both directions, and that the failure copy does not
 * leak what the API deliberately refuses to distinguish.
 *
 * The heaviest group is `the requester is named before the decision`. The
 * screen originally captured `client_label` server-side and never rendered it,
 * which two reviewers caught: the attack this flow must survive is a stranger
 * getting a signed-in victim to open `/device?code=<the stranger's code>`, and
 * with no label on the page there was nothing for the victim to recognise as
 * wrong. Those tests are the regression net for that, so they assert ORDER —
 * that the label is on screen while `approve` has not been called — not merely
 * that the text appears somewhere.
 */

const { mockPost, mockSearchParams } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockSearchParams: { get: vi.fn() },
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => mockSearchParams }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { post: (...a: unknown[]) => mockPost(...a), get: vi.fn() } }
})

/** Route the two POSTs this screen makes, so a test can assert on each. */
function respond({ label = 'Haven CLI on antonio-mbp' }: { label?: string | null } = {}) {
  mockPost.mockImplementation(async (path: string) => {
    if (path === '/auth/device/lookup') return { client_label: label }
    return { status: 'approved' }
  })
}

const calls = (path: string) => mockPost.mock.calls.filter(([p]) => p === path)

beforeEach(() => {
  vi.clearAllMocks()
  mockSearchParams.get.mockReturnValue(null)
})

describe('device approval screen', () => {
  it('prefills the code from the link the agent pasted', () => {
    mockSearchParams.get.mockReturnValue('ABCD-2345')
    respond()
    render(<DeviceApprovalClient />)
    expect(screen.getByLabelText(/code shown in the terminal/i)).toHaveValue('ABCD-2345')
  })

  it('says what the session CAN and CANNOT do, in both directions', () => {
    // A human deciding needs both halves. Only listing what it can do reads as
    // reassurance; only listing what it cannot reads as a warning.
    render(<DeviceApprovalClient />)
    expect(screen.getByText(/create and manage agents/i)).toBeInTheDocument()
    for (const excluded of [/sign anything/i, /approve a budget/i, /change your signers/i]) {
      expect(screen.getByText(excluded)).toBeInTheDocument()
    }
  })

  it('names issuing a new agent API key as something it CAN do', () => {
    // `POST /agents/{id}/rotate-key` is on the owner-CLI allow-list, so the
    // copy has to own it. It previously said "it cannot re-key an agent",
    // which was true of the delegate key and read as a promise about this.
    render(<DeviceApprovalClient />)
    expect(screen.getByText(/new API key/i)).toBeInTheDocument()
    expect(screen.getByText(/stops the old one working/i)).toBeInTheDocument()
  })

  describe('the requester is named before the decision', () => {
    it('looks the code up and shows the label, without approving anything', async () => {
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond({ label: 'Haven CLI on antonio-mbp' })
      render(<DeviceApprovalClient />)

      expect(await screen.findByText('Haven CLI on antonio-mbp')).toBeInTheDocument()
      expect(calls('/auth/device/lookup')).toHaveLength(1)
      // The load-bearing half: nothing has been granted at this point.
      expect(calls('/auth/device/approve')).toHaveLength(0)
    })

    it('offers no Approve button until the code has been looked up', async () => {
      // So there is no path to a grant that skips seeing who is asking.
      respond()
      render(<DeviceApprovalClient />)
      expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^deny$/i })).not.toBeInTheDocument()

      await userEvent.type(screen.getByLabelText(/code shown in the terminal/i), 'ABCD-2345')
      await userEvent.click(screen.getByRole('button', { name: /^continue$/i }))
      expect(await screen.findByRole('button', { name: /^approve$/i })).toBeInTheDocument()
    })

    it('renders an attacker-chosen label as TEXT, never as markup', async () => {
      const nasty = '<img src=x onerror="alert(1)">Haven'
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond({ label: nasty })
      const { container } = render(<DeviceApprovalClient />)

      // The exact string is on screen, and no element was created from it.
      expect(await screen.findByText(nasty)).toBeInTheDocument()
      expect(container.querySelector('img')).toBeNull()
    })

    it('tells the reader the label is the requester\'s own claim', async () => {
      // A label rendered without that framing is Haven appearing to vouch for
      // text a stranger wrote.
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond()
      render(<DeviceApprovalClient />)
      expect(await screen.findByText(/the request says it is from/i)).toBeInTheDocument()
      expect(screen.getByText(/did not start this from your own terminal/i)).toBeInTheDocument()
    })

    it('says so plainly when the client sent no label', async () => {
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond({ label: null })
      render(<DeviceApprovalClient />)
      expect(await screen.findByText(/an unnamed program/i)).toBeInTheDocument()
    })

    it('drops the reviewed label when the code is edited', async () => {
      // Otherwise one code's label sits next to a different code, which is the
      // exact mismatch this step exists to prevent.
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond()
      render(<DeviceApprovalClient />)
      expect(await screen.findByText('Haven CLI on antonio-mbp')).toBeInTheDocument()

      await userEvent.clear(screen.getByLabelText(/code shown in the terminal/i))
      await waitFor(() => expect(screen.queryByText('Haven CLI on antonio-mbp')).not.toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument()
    })
  })

  it('approves with the typed code', async () => {
    respond()
    render(<DeviceApprovalClient />)
    await userEvent.type(screen.getByLabelText(/code shown in the terminal/i), 'ABCD-2345')
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^approve$/i }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/auth/device/approve', { user_code: 'ABCD-2345' }),
    )
    expect(await screen.findByText(/CLI access approved/i)).toBeInTheDocument()
  })

  it('denies without granting anything', async () => {
    respond()
    render(<DeviceApprovalClient />)
    await userEvent.type(screen.getByLabelText(/code shown in the terminal/i), 'ABCD-2345')
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^deny$/i }))
    await waitFor(() =>
      expect(mockPost).toHaveBeenCalledWith('/auth/device/approve', { user_code: 'ABCD-2345', deny: true }),
    )
    expect(await screen.findByText(/nothing was granted/i)).toBeInTheDocument()
  })

  it('does NOT tell the user which of the failure cases it was', async () => {
    // The backend answers 404 for a wrong, expired or already-decided code
    // alike, so codes cannot be enumerated by a signed-in caller. Copy that
    // distinguished them would leak exactly what the API refused to.
    const { ApiRequestError } = await import('@/lib/api')
    mockPost.mockRejectedValue(new ApiRequestError('nope', 404))
    render(<DeviceApprovalClient />)
    await userEvent.type(screen.getByLabelText(/code shown in the terminal/i), 'ABCD-2345')
    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/expired, already been used, or been typed wrong/i)
    // Positive control: it says something, and that something names all three
    // possibilities rather than choosing one.
    for (const leaked of [/^that code has expired$/i, /^already used$/i, /^no such code$/i]) {
      expect(alert.textContent ?? '').not.toMatch(leaked)
    }
  })

  it('cannot submit an empty code', () => {
    render(<DeviceApprovalClient />)
    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled()
  })
})
