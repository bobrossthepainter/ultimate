import { describe, expect, it } from 'vitest'
import { windowOf } from '../../frame.tsx'

const custom = { from: '2026-11-03', to: '2026-11-05' }

describe('usage frame', () => {
  it('starts today and the rolling frames at local midnight, open-ended', () => {
    expect(windowOf('today', '2026-11-18', custom)).toEqual({
      since: new Date(2026, 10, 18).getTime(),
    })
    expect(windowOf('7d', '2026-11-18', custom)).toEqual({
      since: new Date(2026, 10, 12).getTime(),
    })
    expect(windowOf('all', '2026-11-18', custom)).toEqual({})
  })

  it('counts the custom end day in full and accepts the days in either order', () => {
    const window = {
      since: new Date(2026, 10, 3).getTime(),
      until: new Date(2026, 10, 6).getTime(),
    }
    expect(windowOf('custom', '2026-11-18', custom)).toEqual(window)
    expect(windowOf('custom', '2026-11-18', { from: custom.to, to: custom.from })).toEqual(window)
  })

  it('keeps two-digit years as entered instead of mapping them to 19xx', () => {
    const { since, until } = windowOf('custom', '2026-11-18', {
      from: '0099-12-31',
      to: '0100-01-01',
    })
    expect(new Date(since!).getFullYear()).toBe(99)
    expect(until! - since!).toBeGreaterThan(0)
    const across = windowOf('custom', '2026-11-18', { from: '10000-01-01', to: '9999-12-31' })
    expect(new Date(across.since!).getFullYear()).toBe(9999)
    expect(new Date(across.until!).getFullYear()).toBe(10000)
  })
})
