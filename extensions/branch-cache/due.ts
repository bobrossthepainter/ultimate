const MINUTE_MS = 60_000
export const TTL = 60 * MINUTE_MS
export const LEAD = 55 * MINUTE_MS
export const IDLE_STOP = 8 * 60 * MINUTE_MS

export type Step = 'ping' | 'compact'

export type Situation = {
  now: number
  lastRequest?: number
  inputAt?: number
  failedAfter?: number
  warm: boolean
  compact: boolean
  tokens: number
  minCompactTokens: number
  compactedAt?: number
}

export const failing = (failedAt: number | undefined, lastRequest: number | undefined) =>
  failedAt !== undefined && (lastRequest === undefined || failedAt >= lastRequest)

export const warmWindowOpen = (now: number, inputAt: number | undefined) =>
  inputAt !== undefined && now - inputAt < IDLE_STOP

export function nextStep(situation: Situation): Step | undefined {
  const { now, lastRequest } = situation
  if (lastRequest === undefined) return undefined
  const cacheAgeMs = now - lastRequest
  if (cacheAgeMs < LEAD || cacheAgeMs >= TTL) return undefined
  const keepsWarm =
    situation.warm &&
    warmWindowOpen(now, situation.inputAt) &&
    !failing(situation.failedAfter, lastRequest)
  if (keepsWarm) return 'ping'
  const compactedSinceLastRequest =
    situation.compactedAt !== undefined && situation.compactedAt >= lastRequest
  if (
    situation.compact &&
    situation.tokens >= situation.minCompactTokens &&
    !compactedSinceLastRequest
  )
    return 'compact'
  return undefined
}
