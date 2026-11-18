export const FRAMES = ['today', '7d', '30d', 'all', 'custom'] as const
export type Frame = (typeof FRAMES)[number]
export const isFrame = (value: string): value is Frame =>
  (FRAMES as readonly string[]).includes(value)

const pad = (value: number) => String(value).padStart(2, '0')
export const localDay = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

const midnight = (day: string, plusDays = 0) => {
  const date = new Date(`${day}T00:00`)
  date.setDate(date.getDate() + plusDays)
  return date.getTime()
}
export const shiftDay = (day: string, days: number) => localDay(new Date(midnight(day, days)))

export function windowOf(
  frame: Frame,
  today: string,
  custom: { from: string; to: string },
): { since?: number; until?: number } {
  if (frame === 'all') return {}
  if (frame === 'custom') {
    const [from, to] = [custom.from, custom.to].toSorted()
    return { since: midnight(from), until: midnight(to, 1) }
  }
  return { since: midnight(today, { today: 0, '7d': -6, '30d': -29 }[frame]) }
}
