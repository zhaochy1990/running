import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import ProfilePage from '../ProfilePage'

const apiMock = vi.hoisted(() => ({
  getMyProfile: vi.fn(),
  patchMyProfile: vi.fn(),
  deleteMyAccount: vi.fn(),
  refresh: vi.fn(),
  clearSession: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('../../api', () => ({
  getMyProfile: apiMock.getMyProfile,
  patchMyProfile: apiMock.patchMyProfile,
  deleteMyAccount: apiMock.deleteMyAccount,
}))

vi.mock('../../UserContextValue', () => ({
  useUser: () => ({ refresh: apiMock.refresh }),
}))

vi.mock('../../store/authStore', () => ({
  useAuthStore: (selector: (state: { clearSession: () => void }) => unknown) =>
    selector({ clearSession: apiMock.clearSession }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => apiMock.navigate,
  }
})

function profileResponse() {
  return {
    id: 'user-1',
    display_name: 'Runner',
    profile: {},
    onboarding: {
      coros_ready: true,
      profile_ready: true,
      completed_at: null,
    },
  }
}

function renderPage() {
  return render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('ProfilePage account deletion', () => {
  it('requires explicit confirmation before deleting the account', async () => {
    apiMock.getMyProfile.mockResolvedValue(profileResponse())
    apiMock.deleteMyAccount.mockResolvedValue({ ok: true, status: 204, data: {} })

    renderPage()

    await screen.findByText('危险区：注销账号')
    const button = screen.getByRole('button', { name: '永久注销账号' })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('删除账号'), { target: { value: '删除' } })
    expect(button).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText('删除账号'), { target: { value: '删除账号' } })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    await waitFor(() => expect(apiMock.deleteMyAccount).toHaveBeenCalledTimes(1))
    expect(apiMock.clearSession).toHaveBeenCalledTimes(1)
    expect(apiMock.navigate).toHaveBeenCalledWith('/login', { replace: true })
  })

  it('shows a team ownership hint when account deletion is blocked', async () => {
    apiMock.getMyProfile.mockResolvedValue(profileResponse())
    apiMock.deleteMyAccount.mockResolvedValue({
      ok: false,
      status: 409,
      data: { detail: 'user owns teams' },
    })

    renderPage()

    await screen.findByText('危险区：注销账号')
    fireEvent.change(screen.getByPlaceholderText('删除账号'), { target: { value: '删除账号' } })
    fireEvent.click(screen.getByRole('button', { name: '永久注销账号' }))

    expect(
      await screen.findByText('注销失败：你仍然拥有团队。请先到团队页面转让队长或解散团队，然后再注销账号。'),
    ).toBeInTheDocument()
    expect(apiMock.clearSession).not.toHaveBeenCalled()
  })
})
