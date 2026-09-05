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

  it('promises no key rotation of EITHER kind', () => {
    // `POST /agents/{id}/rotate-key` was briefly on the allow-list, and while
    // it was, this copy had to disclose it. The owner removed it on
    // 2026-09-05, so the promise is whole again — and the copy names both
    // kinds, because "re-key" alone read as a claim about the delegate key
    // while the API key was still reachable.
    render(<DeviceApprovalClient />)
    expect(screen.getByText(/re-key an\s+agent/i)).toBeInTheDocument()
    expect(screen.getByText(/neither its delegate key nor its API key/i)).toBeInTheDocument()
    expect(screen.queryByText(/new API key/i)).not.toBeInTheDocument()
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

    it('treats a MISSING label as a reason to deny, not a neutral fact', async () => {
      // A real CLI normally sends a name, so its absence is the strongest
      // signal on the screen — it should not read with the same calm weight as
      // a name the reader can recognise (haven-design-reviewer, #2526).
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond({ label: null })
      render(<DeviceApprovalClient />)
      expect(await screen.findByText(/an unnamed program/i)).toBeInTheDocument()
      expect(screen.getByText(/reason to deny/i)).toBeInTheDocument()
    })

    it('lets a long unbroken label break anywhere', async () => {
      // A jsdom test cannot measure layout, so this pins the CONTRACT and says
      // so: `break-words` alone did not break a single unbroken token, and the
      // mobile capture showed the label pushing the banner wider than its card
      // and sliding "if you did not start this, deny it" out of view — with a
      // string the attacker chooses. The rendered proof is the
      // `device-approval-hostile` screenshot scenario; this only fails if
      // somebody reverts the class.
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      const hostile = 'A'.repeat(70)
      respond({ label: hostile })
      render(<DeviceApprovalClient />)
      const label = await screen.findByText(hostile)
      expect(label.className).toContain('[overflow-wrap:anywhere]')
    })

    it('moves focus to the requester panel when the step changes', async () => {
      // The submit button is one node whose label flips Continue -> Approve, so
      // a keyboard or screen-reader user holding focus would be left on a
      // button that silently changed meaning. Focus lands on the panel that
      // names the requester instead, which reads it out before the decision.
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond()
      render(<DeviceApprovalClient />)
      const panel = await screen.findByTestId('device-client-label')
      await waitFor(() => expect(panel).toHaveFocus())
      // Focus is the whole mechanism. It deliberately carries no `aria-live`:
      // focusing a container already announces it, and a live region on the
      // same node would say it twice (haven-design-reviewer, re-review).
      expect(panel).not.toHaveAttribute('aria-live')
      expect(panel).toHaveAttribute('tabindex', '-1')
    })

    it('submits the code the LABEL belongs to, not whatever is in the box', async () => {
      // The race the second review round found. The auto-lookup fires on mount
      // for the code in the link; while it is in flight the outcome is `idle`,
      // so the input's own reset guard does nothing. Someone who distrusts a
      // pasted link and starts typing their own code used to end up with the
      // LINK's label on screen and THEIR code in the box — and Approve
      // submitted the box. The human reviews one grant and authorises another,
      // which is precisely what the review step exists to prevent.
      let release: (v: { client_label: string }) => void = () => {}
      mockPost.mockImplementation(async (path: string) => {
        if (path === '/auth/device/lookup') {
          return new Promise((resolve) => {
            release = resolve as typeof release
          })
        }
        return { status: 'approved' }
      })
      mockSearchParams.get.mockReturnValue('LINK-CODE')
      render(<DeviceApprovalClient />)

      // Retype while the link's lookup is still open.
      const input = screen.getByLabelText(/code shown in the terminal/i)
      await userEvent.clear(input)
      await userEvent.type(input, 'MINE-9999')
      release({ client_label: 'Something the link asked for' })

      // The stale response must not install its label at all.
      await waitFor(() =>
        expect(screen.queryByText('Something the link asked for')).not.toBeInTheDocument(),
      )
      expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument()
      expect(calls('/auth/device/approve')).toHaveLength(0)
    })

    it('approves the code it LOOKED UP when the link padded it with spaces', async () => {
      // The divergence that still exists once the generation guard is in: the
      // auto-lookup trims the code from the link, the input keeps it untrimmed.
      // So `pending.userCode` and the box genuinely differ here, and this is
      // what makes binding the decision to the reviewed grant load-bearing
      // rather than belt-and-braces — submitting the box would send a code
      // that is not the one whose label was shown.
      mockSearchParams.get.mockReturnValue('  ABCD-2345  ')
      respond()
      render(<DeviceApprovalClient />)
      await screen.findByText('Haven CLI on antonio-mbp')
      expect(mockPost).toHaveBeenCalledWith('/auth/device/lookup', { user_code: 'ABCD-2345' })

      await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/auth/device/approve', { user_code: 'ABCD-2345' }),
      )
    })

    it('approves the reviewed code even if the box is edited afterwards', async () => {
      // Belt and braces on the same invariant from the other side: whatever
      // reaches `approve` is the grant that was reviewed. Editing clears the
      // review, so this asserts the binding directly rather than through the UI.
      mockSearchParams.get.mockReturnValue('ABCD-2345')
      respond()
      render(<DeviceApprovalClient />)
      await screen.findByText('Haven CLI on antonio-mbp')
      await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/auth/device/approve', { user_code: 'ABCD-2345' }),
      )
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
