import { describe, expect, it } from 'vitest'

import { resolveBreadcrumb } from '../breadcrumb'

describe('resolveBreadcrumb', () => {
  it('maps activity list route', () => {
    expect(resolveBreadcrumb('/activities')).toEqual({ section: '训练', current: '活动列表' })
  })

  it('maps plan adjustment route', () => {
    expect(resolveBreadcrumb('/plan/adjust')).toEqual({ section: '训练计划', current: '调整 / 重新生成' })
  })
})
