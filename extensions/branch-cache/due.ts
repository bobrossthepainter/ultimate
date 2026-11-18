import { CACHE_WARMING_MAX_AGE_MS } from '@earendil-works/pi-ai'

export type Step = 'ping' | 'compact'

export type Policy = {
  warm: boolean
  compact: boolean
  warmMs: number
  minCompactTokens: number
}

export type Situation = {
  now: number
  ttl: number
  delayBeforeRefresh: number
  realRequestAt: number
  lastCacheRequestAt: number
  runActive: boolean
  withinMaxWarm: boolean
  tokens: number
  compactedSinceRequest: boolean
}

export type Decision = Step | { stop: string }

export const lateRefreshCutoff = (
  situation: Pick<Situation, 'ttl' | 'delayBeforeRefresh' | 'lastCacheRequestAt'>,
) => {
  const dueAt = situation.lastCacheRequestAt + situation.delayBeforeRefresh
  const halfTheMarginBeforeExpiry = Math.floor((situation.ttl - situation.delayBeforeRefresh) / 2)
  return dueAt + halfTheMarginBeforeExpiry
}

export const warmWindowEnd = (
  situation: Pick<Situation, 'realRequestAt' | 'runActive'>,
  policy: Policy,
) =>
  situation.realRequestAt +
  (situation.runActive ? Math.max(CACHE_WARMING_MAX_AGE_MS, policy.warmMs) : policy.warmMs)

const minutes = (ms: number) => Math.round(ms / 60_000)

export function decide(situation: Situation, policy: Policy): Decision {
  if (situation.now > lateRefreshCutoff(situation)) return { stop: 'Refresh came too late' }
  const windowOpen = situation.now <= warmWindowEnd(situation, policy)
  if (policy.warm && windowOpen)
    return situation.withinMaxWarm ? 'ping' : { stop: 'Over the limit of warm branches' }
  if (situation.runActive)
    return {
      stop: policy.warm
        ? `Run longer than ${minutes(Math.max(CACHE_WARMING_MAX_AGE_MS, policy.warmMs))} min`
        : 'Off for this branch',
    }
  if (windowOpen) return { stop: 'Off for this branch' }
  if (!policy.compact) return { stop: `No request for ${minutes(policy.warmMs)} min` }
  if (situation.tokens < policy.minCompactTokens)
    return { stop: `Too small to compact (under ${Math.round(policy.minCompactTokens / 1000)}k)` }
  if (situation.compactedSinceRequest) return { stop: 'Compacted' }
  return 'compact'
}
