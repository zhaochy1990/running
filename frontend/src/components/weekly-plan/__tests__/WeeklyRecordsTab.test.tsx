import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { Activity, PlanDay } from '../../../api'
import WeeklyRecordsTab from '../WeeklyRecordsTab'

function activity(overrides: Partial<Activity>): Activity {
  return {
    label_id: 'activity',
    name: '实际晨跑',
    sport_type: 100,
    sport_name: 'Run',
    date: '2026-07-13T07:00:00+08:00',
    distance_m: 8200,
    distance_km: 8.2,
    duration_s: 3000,
    duration_fmt: '50m',
    avg_pace_s_km: 366,
    pace_fmt: "6'06\"",
    avg_hr: 140,
    max_hr: 160,
    avg_cadence: 176,
    calories_kcal: 500,
    training_load: 60,
    vo2max: null,
    train_type: null,
    ascent_m: 20,
    aerobic_effect: null,
    anaerobic_effect: null,
    temperature: null,
    humidity: null,
    feels_like: null,
    wind_speed: null,
    feel_type: null,
    sport_note: null,
    ...overrides,
  }
}

const days: PlanDay[] = [{
  date: '2026-07-13',
  nutrition: null,
  sessions: [{
    id: 1,
    pushable: false,
    schema: 'plan-session/v1',
    date: '2026-07-13',
    session_index: 0,
    kind: 'run',
    summary: '计划中的轻松跑',
    spec: null,
    notes_md: null,
    total_distance_m: 8000,
    total_duration_s: 3000,
    scheduled_workout_id: null,
  }],
}]

describe('WeeklyRecordsTab', () => {
  it('uses actual activity titles and includes activities without a matching plan session', () => {
    render(
      <MemoryRouter>
        <WeeklyRecordsTab
          days={days}
          activities={[
            activity({ label_id: 'run', name: '昆明高原晨跑' }),
            activity({ label_id: 'ride', name: '恢复骑行', sport_type: 200, sport_name: 'Bike', date: '2026-07-14T18:00:00+08:00', distance_km: 18 }),
          ]}
        />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: '昆明高原晨跑' })).toHaveAttribute('href', '/activity/run')
    expect(screen.getByRole('link', { name: '恢复骑行' })).toHaveAttribute('href', '/activity/ride')
    expect(screen.queryByText(/计划中的轻松跑/)).not.toBeInTheDocument()
    expect(screen.getByText('2 次记录')).toBeInTheDocument()
  })
})
