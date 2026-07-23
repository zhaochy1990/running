import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { CoachPlanAppliedBanner } from '../CoachPlanAppliedBanner'

function renderAt(state: unknown) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/plan', state }]}>
      <CoachPlanAppliedBanner />
    </MemoryRouter>,
  )
}

describe('CoachPlanAppliedBanner', () => {
  it('shows the success banner when location state carries the applied flag', () => {
    renderAt({ coachPlanApplied: true })
    expect(screen.getByRole('status')).toHaveTextContent('计划已更新')
  })

  it('renders nothing without the flag', () => {
    renderAt(null)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('can be dismissed', async () => {
    renderAt({ coachPlanApplied: true })
    fireEvent.click(screen.getByRole('button', { name: '知道了，关闭计划更新提示' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })
})
