import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import LoginModal from '../LoginModal'

const mocks = vi.hoisted(() => ({ login: vi.fn(), navigate: vi.fn() }))

vi.mock('../../../store/authStore', () => ({
  useAuthStore: () => ({ login: mocks.login }),
}))
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => mocks.navigate }
})

function renderModal() {
  return render(
    <MemoryRouter>
      <LoginModal onClose={vi.fn()} />
    </MemoryRouter>,
  )
}

afterEach(() => { mocks.login.mockReset(); mocks.navigate.mockReset() })

describe('LoginModal', () => {
  it('submits credentials and navigates home on success', async () => {
    mocks.login.mockResolvedValue(undefined)
    renderModal()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'runner@example.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret123' } })
    fireEvent.click(screen.getByRole('button', { name: /^登录$/ }))
    await waitFor(() => expect(mocks.login).toHaveBeenCalledWith('runner@example.com', 'secret123'))
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/'))
  })

  it('shows a credential error on 401', async () => {
    mocks.login.mockRejectedValue({ status: 401 })
    renderModal()
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'x@y.com' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: /^登录$/ }))
    expect(await screen.findByText('邮箱或密码错误')).toBeInTheDocument()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('does not render OAuth or forgot-password entries', () => {
    renderModal()
    expect(screen.queryByText(/Google 继续/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Strava 继续/)).not.toBeInTheDocument()
    expect(screen.queryByText('忘记密码?')).not.toBeInTheDocument()
  })
})
