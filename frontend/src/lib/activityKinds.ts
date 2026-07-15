import type { Activity } from '../api'

export function isRunActivity(activity: Activity): boolean {
  return activity.sport_type === 100 || /run|treadmill|trail|track/i.test(activity.sport_name)
}

export function isStrengthActivity(activity: Activity): boolean {
  return [4, 402, 800].includes(activity.sport_type) || /strength/i.test(activity.sport_name)
}
