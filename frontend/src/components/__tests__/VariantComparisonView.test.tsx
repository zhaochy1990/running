import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VariantComparisonView from '../VariantComparisonView'
import type { PlanVariant, VariantsResponse } from '../../types/plan'

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api')
  return {
    ...actual,
    getPlanVariants: vi.fn(),
    ratePlanVariant: vi.fn(),
    selectPlanVariant: vi.fn(),
  }
})

import * as api from '../../api'

function makeVariant(overrides: Partial<PlanVariant> = {}): PlanVariant {
  return {
    variant_id: 1,
    variant_index: 0,
    model_id: 'claude-opus-4-7',
    schema_version: 1,
    variant_parse_status: 'fresh',
    content_md: '# Sample plan\n\n- Easy 10km',
    sessions: [],
    nutrition: [],
    ratings: {},
    rating_comment: null,
    is_selected: false,
    generated_at: '2026-04-20T10:00:00Z',
    generation_metadata: null,
    selectable: true,
    ...overrides,
  }
}

function makeResponse(variants: PlanVariant[]): VariantsResponse {
  return {
    week_folder: '2026-04-20_04-26',
    selected_variant_id: variants.find((v) => v.is_selected)?.variant_id ?? null,
    variants,
  }
}

describe('VariantComparisonView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders 3 columns when 3 variants are returned', async () => {
    const data = makeResponse([
      makeVariant({ variant_id: 1, model_id: 'claude' }),
      makeVariant({ variant_id: 2, model_id: 'codex' }),
      makeVariant({ variant_id: 3, model_id: 'gemini' }),
    ])
    render(
      <VariantComparisonView
        user="zhaochaoyi"
        folder="2026-04-20_04-26"
        initialData={data}
      />,
    )
    expect(screen.getByTestId('variant-card-1')).toBeInTheDocument()
    expect(screen.getByTestId('variant-card-2')).toBeInTheDocument()
    expect(screen.getByTestId('variant-card-3')).toBeInTheDocument()
  })

  it('clicking the select button dispatches selectPlanVariant with force=false', async () => {
    const data = makeResponse([makeVariant({ variant_id: 7 })])
    vi.mocked(api.selectPlanVariant).mockResolvedValueOnce({
      ok: true,
      week_folder: '2026-04-20_04-26',
      selected_variant_id: 7,
      dropped_scheduled_workout_ids: [],
    })
    vi.mocked(api.getPlanVariants).mockResolvedValueOnce(data)
    render(
      <VariantComparisonView
        user="zhaochaoyi"
        folder="2026-04-20_04-26"
        initialData={data}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('select-button-7'))
    })
    expect(api.selectPlanVariant).toHaveBeenCalledWith(
      'zhaochaoyi',
      '2026-04-20_04-26',
      7,
      false,
    )
  })

  it('409 selection_conflict opens confirm dialog → confirm dispatches force=true', async () => {
    const data = makeResponse([makeVariant({ variant_id: 9 })])
    // First call (force=false) → reject with conflict envelope.
    vi.mocked(api.selectPlanVariant).mockRejectedValueOnce({
      status: 409,
      error: 'selection_conflict',
      already_pushed_count: 2,
    })
    // Second call (force=true) → success.
    vi.mocked(api.selectPlanVariant).mockResolvedValueOnce({
      ok: true,
      week_folder: '2026-04-20_04-26',
      selected_variant_id: 9,
      dropped_scheduled_workout_ids: [101, 102],
    })
    vi.mocked(api.getPlanVariants).mockResolvedValueOnce(data)

    render(
      <VariantComparisonView
        user="zhaochaoyi"
        folder="2026-04-20_04-26"
        initialData={data}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('select-button-9'))
    })
    // Dialog should appear with already_pushed count.
    expect(screen.getByTestId('select-confirm-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('select-confirm-dialog').textContent).toContain('2')

    // Confirm — second call with force=true.
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-force-select'))
    })
    expect(api.selectPlanVariant).toHaveBeenCalledTimes(2)
    expect(api.selectPlanVariant).toHaveBeenLastCalledWith(
      'zhaochaoyi',
      '2026-04-20_04-26',
      9,
      true,
    )
  })

  it('rating slider change debounces 800ms then calls ratePlanVariant', async () => {
    const data = makeResponse([makeVariant({ variant_id: 11 })])
    vi.mocked(api.ratePlanVariant).mockResolvedValueOnce({
      ratings: { overall: 4 },
      rating_comment: null,
    })
    vi.mocked(api.getPlanVariants).mockResolvedValue(data)

    render(
      <VariantComparisonView
        user="zhaochaoyi"
        folder="2026-04-20_04-26"
        initialData={data}
      />,
    )

    const slider = screen.getByTestId('rating-slider-11-overall')
    await act(async () => {
      fireEvent.change(slider, { target: { value: '4' } })
    })
    // Not yet — debounce window is 800ms.
    expect(api.ratePlanVariant).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(800)
    })
    expect(api.ratePlanVariant).toHaveBeenCalledWith(
      'zhaochaoyi',
      11,
      expect.objectContaining({ overall: 4 }),
      null,
    )
  })

  it('show historical toggle fetches variants with includeSuperseded=true', async () => {
    // Real timers for this test — the toggle dispatches an async fetch
    // that we need to await without fake-timer interference.
    vi.useRealTimers()
    const data = makeResponse([makeVariant({ variant_id: 1 })])
    const dataWithHistory = makeResponse([
      makeVariant({ variant_id: 1 }),
      makeVariant({ variant_id: 0, superseded_at: '2026-04-19T00:00:00Z' }),
    ])
    vi.mocked(api.getPlanVariants).mockResolvedValueOnce(dataWithHistory)

    render(
      <VariantComparisonView
        user="zhaochaoyi"
        folder="2026-04-20_04-26"
        initialData={data}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-historical'))
    })
    expect(api.getPlanVariants).toHaveBeenCalledWith(
      'zhaochaoyi',
      '2026-04-20_04-26',
      true,
    )
    await waitFor(() => {
      expect(screen.getByTestId('superseded-grid')).toBeInTheDocument()
    })
  })

  it('disables select button on already-selected variant', () => {
    const data = makeResponse([
      makeVariant({ variant_id: 1, is_selected: true }),
    ])
    render(
      <VariantComparisonView
        user="zhaochaoyi"
        folder="2026-04-20_04-26"
        initialData={data}
      />,
    )
    const btn = screen.getByTestId('select-button-1')
    expect(btn).toBeDisabled()
    expect(btn.textContent).toContain('已选定')
  })

  it('disables select button when variant is unselectable', () => {
    const data = makeResponse([
      makeVariant({
        variant_id: 1,
        selectable: false,
        unselectable_reason: 'parse_failed',
        variant_parse_status: 'parse_failed',
      }),
    ])
    render(
      <VariantComparisonView
        user="zhaochaoyi"
        folder="2026-04-20_04-26"
        initialData={data}
      />,
    )
    const btn = screen.getByTestId('select-button-1')
    expect(btn).toBeDisabled()
  })
})
