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

beforeEach(() => {
  vi.clearAllMocks()
  mockSearchParams.get.mockReturnValue(null)
})

describe('device approval screen', () => {
  it('prefills the code from the link the agent pasted', () => {
    mockSearchParams.get.mockReturnValue('ABCD-2345')
    render(<DeviceApprovalClient />)
    expect(screen.getByLabelText(/code shown in the terminal/i)).toHaveValue('ABCD-2345')
  })

  it('says what the session CAN and CANNOT do, in both directions', () => {
    // A human deciding needs both halves. Only listing what it can do reads as
    // reassurance; only listing what it cannot reads as a warning.
    render(<DeviceApprovalClient />)
    expect(screen.getByText(/create and manage agents/i)).toBeInTheDocument()
    expect(screen.getByText(/cannot/i)).toBeInTheDocument()
    for (const excluded of [/sign anything/i, /approve a budget/i, /change your signers/i, /re-key/i]) {
      expect(screen.getByText(excluded)).toBeInTheDocument()
    }
  })

  it('approves with the typed code', async () => {
    mockPost.mockResolvedValue({ status: 'approved' })
    render(<DeviceApprovalClient />)
    await userEvent.type(screen.getByLabelText(/code shown in the terminal/i), 'ABCD-2345')
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(mockPost).toHaveBeenCalledWith('/auth/device/approve', { user_code: 'ABCD-2345' }))
    expect(await screen.findByText(/CLI access approved/i)).toBeInTheDocument()
  })

  it('denies without granting anything', async () => {
    mockPost.mockResolvedValue({ status: 'denied' })
    render(<DeviceApprovalClient />)
    await userEvent.type(screen.getByLabelText(/code shown in the terminal/i), 'ABCD-2345')
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }))
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
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }))
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
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^deny$/i })).toBeDisabled()
  })
})
