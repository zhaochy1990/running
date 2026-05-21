import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BodyCompositionEntryModal from '../BodyCompositionEntryModal'
import * as api from '../../api'

function renderModal(overrides: Partial<Parameters<typeof BodyCompositionEntryModal>[0]> = {}) {
  const props = {
    user: 'testuser',
    existingDates: new Set<string>(),
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  }
  render(<BodyCompositionEntryModal {...props} />)
  return props
}

describe('BodyCompositionEntryModal', () => {
  it('blocks submit and shows error when required metrics are missing', async () => {
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({} as never)
    renderModal()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/weight_kg 必填/)).toBeInTheDocument()
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('blocks submit when only some rows are filled (count mismatch)', async () => {
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({} as never)
    renderModal()

    // Fill required metrics
    fireEvent.change(screen.getByLabelText(/体重/), { target: { value: '71.6' } })
    fireEvent.change(screen.getByLabelText(/体脂率/), { target: { value: '22.9' } })
    fireEvent.change(screen.getByLabelText(/骨骼肌量/), { target: { value: '31.1' } })
    fireEvent.change(screen.getByLabelText(/脂肪量/), { target: { value: '16.4' } })
    fireEvent.change(screen.getByLabelText(/内脏脂肪等级/), { target: { value: '5' } })

    // Open segments and fully fill only 2 of 5 rows
    fireEvent.click(screen.getByText(/节段数据/))
    fireEvent.change(screen.getByLabelText('左臂 lean_mass_kg'), { target: { value: '2.5' } })
    fireEvent.change(screen.getByLabelText('左臂 fat_mass_kg'), { target: { value: '1.0' } })
    fireEvent.change(screen.getByLabelText('右臂 lean_mass_kg'), { target: { value: '2.6' } })
    fireEvent.change(screen.getByLabelText('右臂 fat_mass_kg'), { target: { value: '1.0' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/节段数据必须 5 个都填/)).toBeInTheDocument()
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('blocks submit when a row has lean but not fat (partial row)', async () => {
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({} as never)
    renderModal()

    fireEvent.change(screen.getByLabelText(/体重/), { target: { value: '71.6' } })
    fireEvent.change(screen.getByLabelText(/体脂率/), { target: { value: '22.9' } })
    fireEvent.change(screen.getByLabelText(/骨骼肌量/), { target: { value: '31.1' } })
    fireEvent.change(screen.getByLabelText(/脂肪量/), { target: { value: '16.4' } })
    fireEvent.change(screen.getByLabelText(/内脏脂肪等级/), { target: { value: '5' } })

    // Fill lean but not fat — earlier code would crash on submit
    fireEvent.click(screen.getByText(/节段数据/))
    fireEvent.change(screen.getByLabelText('左臂 lean_mass_kg'), { target: { value: '2.5' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText(/节段每行的肌肉量和脂肪量必须同时填写/)).toBeInTheDocument()
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('submits payload and calls onSaved on success', async () => {
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        scan_date: '2026-05-20', weight_kg: 71.6, body_fat_pct: 22.9, smm_kg: 31.1,
        fat_mass_kg: 16.4, visceral_fat_level: 5, jpg_path: null, bmr_kcal: null,
        protein_kg: null, water_l: null, smi: null, inbody_score: null, ingested_at: 'x',
        leg_smm_delta: null, leg_fat_delta: null, arm_smm_delta: null,
        upper_lower_smm_ratio: null, left_arm_smm_kg: null, right_arm_smm_kg: null,
        trunk_smm_kg: null, left_leg_smm_kg: null, right_leg_smm_kg: null,
        left_arm_fat_kg: null, right_arm_fat_kg: null, trunk_fat_kg: null,
        left_leg_fat_kg: null, right_leg_fat_kg: null, left_arm_lean_pct_std: null,
        right_arm_lean_pct_std: null, trunk_lean_pct_std: null, left_leg_lean_pct_std: null,
        right_leg_lean_pct_std: null, left_arm_fat_pct_std: null, right_arm_fat_pct_std: null,
        trunk_fat_pct_std: null, left_leg_fat_pct_std: null, right_leg_fat_pct_std: null,
      },
    } as never)
    const onSaved = vi.fn()
    renderModal({ onSaved })

    fireEvent.change(screen.getByLabelText(/体重/), { target: { value: '71.6' } })
    fireEvent.change(screen.getByLabelText(/体脂率/), { target: { value: '22.9' } })
    fireEvent.change(screen.getByLabelText(/骨骼肌量/), { target: { value: '31.1' } })
    fireEvent.change(screen.getByLabelText(/脂肪量/), { target: { value: '16.4' } })
    fireEvent.change(screen.getByLabelText(/内脏脂肪等级/), { target: { value: '5' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(upsertSpy).toHaveBeenCalledOnce())
    const [, payload] = upsertSpy.mock.calls[0]
    expect(payload.weight_kg).toBe(71.6)
    expect(payload.visceral_fat_level).toBe(5)
    expect(payload.segments).toBeUndefined()
    expect(onSaved).toHaveBeenCalledOnce()
  })

  it('prompts for overwrite when scan_date already exists', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const upsertSpy = vi.spyOn(api, 'upsertBodyComposition').mockResolvedValue({} as never)
    renderModal({ existingDates: new Set(['2026-05-20']) })

    // Set the date input to the existing date
    const dateInput = screen.getByLabelText(/扫描日期/) as HTMLInputElement
    fireEvent.change(dateInput, { target: { value: '2026-05-20' } })

    fireEvent.change(screen.getByLabelText(/体重/), { target: { value: '71.6' } })
    fireEvent.change(screen.getByLabelText(/体脂率/), { target: { value: '22.9' } })
    fireEvent.change(screen.getByLabelText(/骨骼肌量/), { target: { value: '31.1' } })
    fireEvent.change(screen.getByLabelText(/脂肪量/), { target: { value: '16.4' } })
    fireEvent.change(screen.getByLabelText(/内脏脂肪等级/), { target: { value: '5' } })

    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('2026-05-20'))
    expect(upsertSpy).not.toHaveBeenCalled()  // confirm returned false
  })
})
