import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import WeeklyFeedbackTab from '../WeeklyFeedbackTab'

describe('WeeklyFeedbackTab', () => {
  it('reports successful saves', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<WeeklyFeedbackTab initialValue="week" days={[]} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: '保存反馈' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('week'))
    expect(screen.getByText('反馈已保存')).toBeInTheDocument()
  })

  it('keeps editing and shows save failures', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('MySQL unavailable'))
    render(<WeeklyFeedbackTab initialValue="" days={[]} onSave={onSave} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new feedback' } })
    fireEvent.click(screen.getByRole('button', { name: '保存反馈' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('MySQL unavailable')
    expect(screen.getByRole('textbox')).toHaveValue('new feedback')
  })
})
