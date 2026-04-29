import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import RegisterPage from '../RegisterPage'

const authStoreMock = vi.hoisted(() => ({
  registerSuccess: vi.fn(),
}))

vi.mock('../../store/authStore', () => ({
  useAuthStore: () => ({
    isAuthenticated: false,
    registerSuccess: authStoreMock.registerSuccess,
  }),
}))

function renderPage() {
  return render(
    <MemoryRouter>
      <RegisterPage />
    </MemoryRouter>,
  )
}

function fillRegisterForm(password: string) {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'runner@example.com' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: password } })
  fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'INVITE123' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  authStoreMock.registerSuccess.mockReset()
})

describe('RegisterPage', () => {
  it('validates password rules while the user types', () => {
    renderPage()
    const passwordInput = screen.getByLabelText('密码')

    expect(screen.queryByLabelText('密码规则')).not.toBeInTheDocument()

    fireEvent.change(passwordInput, { target: { value: 'abc' } })

    expect(screen.getByLabelText('密码规则')).toBeInTheDocument()
    expect(screen.getByText('至少 8 个字符')).toBeInTheDocument()
    expect(screen.getByText('包含至少一个大写字母')).toBeInTheDocument()
    expect(passwordInput).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(passwordInput, { target: { value: 'Abcdef1!' } })

    expect(passwordInput).not.toHaveAttribute('aria-invalid')
  })

  it('does not submit when the password fails client-side rules', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    fillRegisterForm('abc')

    fireEvent.click(screen.getByRole('button', { name: '创建账号' }))

    expect(await screen.findByText('密码不符合规则：至少 8 个字符')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows server password validation errors instead of a generic missing-fields message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Password must contain at least one special character' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    fillRegisterForm('Abcdef1!')

    fireEvent.click(screen.getByRole('button', { name: '创建账号' }))

    expect(await screen.findByText('密码必须包含至少一个特殊字符')).toBeInTheDocument()
  })
})
