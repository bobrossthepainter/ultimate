export const FRAMES = ['today', '7d', '30d', 'all', 'custom'] as const
export type Frame = (typeof FRAMES)[number]
export const isFrame = (value: string): value is Frame =>
  (FRAMES as readonly string[]).includes(value)

const pad = (value: number) => String(value).padStart(2, '0')
export const localDay = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

const fields = (day: string) => day.split('-').map(Number)
const calendarOrder = (day: string) => {
  const [year, month, date] = fields(day)
  return new Date(0).setUTCFullYear(year, month - 1, date)
}
const midnight = (day: string, plusDays = 0) => {
  const [year, month, date] = fields(day)
  const start = new Date(0)
  start.setFullYear(year, month - 1, date + plusDays)
  return start.setHours(0, 0, 0, 0)
}
export const shiftDay = (day: string, days: number) => localDay(new Date(midnight(day, days)))

export function windowOf(
  frame: Frame,
  today: string,
  custom: { from: string; to: string },
): { since?: number; until?: number } {
  if (frame === 'all') return {}
  if (frame === 'custom') {
    const [from, to] = [custom.from, custom.to].toSorted(
      (a, b) => calendarOrder(a) - calendarOrder(b),
    )
    return { since: midnight(from), until: midnight(to, 1) }
  }
  return { since: midnight(today, { today: 0, '7d': -6, '30d': -29 }[frame]) }
}
