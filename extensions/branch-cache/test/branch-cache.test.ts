import { expect, it } from 'vitest'
import { IDLE_STOP, LEAD, nextStep, TTL } from '../due.ts'
import type { Situation } from '../due.ts'
import { readSettings, warmAllowed } from '../server.ts'
import { parseConversationId } from '../../../lib/ids.ts'

const now = Date.parse('2026-11-16T12:00:00Z')
const minutes = (count: number) => count * 60_000
const situation = (change: Partial<Situation>): Situation => ({
  now,
  lastRequest: now - LEAD,
  inputAt: now - minutes(70),
  warm: true,
  compact: true,
  tokens: 400_000,
  minCompactTokens: 150_000,
  ...change,
})

it('pings while the branch was active in the last 8 hours, then compacts once that window ends', () => {
  expect(nextStep(situation({}))).toBe('ping')
  expect(nextStep(situation({ inputAt: now - IDLE_STOP }))).toBe('compact')
  expect(nextStep(situation({ compact: false, inputAt: now - IDLE_STOP }))).toBe(undefined)
})

it('compacts instead of pinging after a failed ping, and alone when only compaction is on', () => {
  expect(nextStep(situation({ failedAfter: now - minutes(1) }))).toBe('compact')
  expect(nextStep(situation({ warm: false }))).toBe('compact')
})

it('acts only in the last minutes of the cache hour', () => {
  expect(nextStep(situation({ lastRequest: now - minutes(30) }))).toBe(undefined)
  expect(nextStep(situation({ lastRequest: now - TTL }))).toBe(undefined)
  expect(nextStep(situation({ lastRequest: undefined }))).toBe(undefined)
})

it('leaves small contexts and ones already compacted since the last request alone', () => {
  expect(nextStep(situation({ warm: false, tokens: 100_000 }))).toBe(undefined)
  expect(nextStep(situation({ warm: false, compactedAt: now - minutes(1) }))).toBe(undefined)
  expect(nextStep(situation({ warm: false, compactedAt: now - minutes(120) }))).toBe('compact')
})

it('keeps at most maxWarm branches warm, the most recently active first', () => {
  const branch = (id: number, inputAgo: number, warm = true) => ({
    id: parseConversationId(id),
    inputAt: now - minutes(inputAgo),
    warm,
  })
  const allowed = warmAllowed(
    [branch(1, 10), branch(2, 5), branch(3, 1, false), branch(4, 30), branch(5, 600)],
    now,
    2,
  )
  expect([...allowed].toSorted((a, b) => a - b)).toEqual([1, 2])
})

it('reads its settings with defaults off', () => {
  expect(readSettings({})).toEqual({
    maxWarm: 5,
    minCompactTokens: 150_000,
    warm: false,
    compact: false,
  })
  expect(
    readSettings({ branchCache: { maxWarm: 2, default: { warm: true }, minCompactTokens: 'x' } }),
  ).toEqual({ maxWarm: 2, minCompactTokens: 150_000, warm: true, compact: false })
})
