import { describe, expect, it } from 'vitest'

import { resolveBreadcrumb } from '../breadcrumb'

describe('resolveBreadcrumb', () => {
  it('maps activity list route', () => {
    expect(resolveBreadcrumb('/activities')).toEqual({ section: '训练', current: '活动列表' })
  })
})
