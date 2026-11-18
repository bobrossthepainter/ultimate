import type { JsonObject } from '@earendil-works/pi-durable'
import type { Api, Model } from '@earendil-works/pi-ai'
import { expect, it } from 'vitest'
import { decide, lateRefreshCutoff } from '../due.ts'
import type { Policy, Situation } from '../due.ts'
import { cacheTiming, oneTokenPayload } from '../server.ts'
import { readPolicy, writeModelPolicy } from '../settings.ts'

const now = Date.parse('2026-11-16T12:00:00Z')
const minutes = (count: number) => count * 60_000
const policy: Policy = { warm: true, compact: true, warmMs: minutes(30), minCompactTokens: 150_000 }
const fiveMinutes = (change: Partial<Situation>): Situation => ({
  now,
  ttl: minutes(5),
  delayBeforeRefresh: minutes(4.5),
  realRequestAt: now - minutes(13.5),
  lastCacheRequestAt: now - minutes(4.5),
  runActive: false,
  withinMaxWarm: true,
  tokens: 200_000,
  compactedSinceRequest: false,
  ...change,
})
const hour = (change: Partial<Situation>) =>
  fiveMinutes({
    ttl: minutes(60),
    delayBeforeRefresh: minutes(54),
    realRequestAt: now - minutes(54),
    lastCacheRequestAt: now - minutes(54),
    ...change,
  })

it('pings a five-minute cache at 4.5 minutes for 30 minutes after the request, then compacts', () => {
  expect(decide(fiveMinutes({}), policy)).toBe('ping')
  expect(decide(fiveMinutes({ realRequestAt: now - minutes(31.5) }), policy)).toBe('compact')
  expect(
    decide(fiveMinutes({ realRequestAt: now - minutes(31.5) }), { ...policy, compact: false }),
  ).toEqual({
    stop: 'No request for 30 min',
  })
})

it('keeps a branch with a run warm for an hour after its request, and never compacts it', () => {
  expect(decide(fiveMinutes({ runActive: true, realRequestAt: now - minutes(58.5) }), policy)).toBe(
    'ping',
  )
  expect(
    decide(fiveMinutes({ runActive: true, realRequestAt: now - minutes(63) }), policy),
  ).toEqual({
    stop: 'Run longer than 60 min',
  })
  expect(
    decide(fiveMinutes({ runActive: true, realRequestAt: now - minutes(63) }), {
      ...policy,
      warmMs: minutes(480),
    }),
  ).toEqual({ stop: 'Run longer than 60 min' })
})

it('skips a refresh that fires after half the margin before expiry', () => {
  const late = fiveMinutes({})
  expect(lateRefreshCutoff(late)).toBe(now + minutes(0.25))
  expect(decide({ ...late, now: now + minutes(0.25) }, policy)).toBe('ping')
  expect(decide({ ...late, now: now + minutes(0.25) + 1 }, policy)).toEqual({
    stop: 'Refresh came too late',
  })
})

it('does not compact a five-minute cache inside its window, nor warm it when off', () => {
  expect(decide(fiveMinutes({}), { ...policy, warm: false })).toEqual({
    stop: 'Off for this branch',
  })
  expect(decide(fiveMinutes({ withinMaxWarm: false }), policy)).toEqual({
    stop: 'Over the limit of warm branches',
  })
})

it('compacts an hour-long cache at 54 minutes once its 30-minute idle window is over', () => {
  expect(decide(hour({}), policy)).toBe('compact')
  expect(decide(hour({}), { ...policy, warmMs: minutes(480) })).toBe('ping')
  expect(decide(hour({ tokens: 100_000 }), policy)).toEqual({
    stop: 'Too small to compact (under 150k)',
  })
  expect(decide(hour({ compactedSinceRequest: true }), policy)).toEqual({ stop: 'Compacted' })
})

it("takes the cache lifetime and refresh delay from the model's promptCache metadata", () => {
  const opus = {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    api: 'anthropic-messages',
    promptCache: { short: 300, long: 3600 },
  } as Model<Api>
  expect(cacheTiming(opus)).toEqual({ ttl: minutes(5), delayBeforeRefresh: minutes(4.5) })
  expect(cacheTiming({ ...opus, promptCache: undefined })).toBe(undefined)
  expect(
    cacheTiming({ ...opus, provider: 'github-copilot', promptCache: { short: 300, long: 3600 } }),
  ).toEqual({ ttl: minutes(5), delayBeforeRefresh: minutes(4.5) })
  expect(
    cacheTiming({ ...opus, provider: 'claude-code', api: 'claude-code', promptCache: undefined }),
  ).toEqual({ ttl: minutes(60), delayBeforeRefresh: minutes(54) })
})

it('caps a replayed Anthropic request at one output token, and refuses bodies it cannot cap', () => {
  const body = { model: 'x', max_tokens: 64_000, messages: [{ role: 'user', content: 'hi' }] }
  expect(oneTokenPayload('anthropic-messages', body)).toEqual({ ...body, max_tokens: 1 })
  expect(body.max_tokens).toBe(64_000)
  expect(oneTokenPayload('pi-messages', { options: { maxTokens: 8192 } })).toBe(undefined)
  expect(oneTokenPayload('anthropic-messages', { messages: [] })).toBe(undefined)
})

it('resolves a model policy from defaults, provider and exact keys, the project over the user', () => {
  expect(readPolicy({ user: {}, project: {} }, 'github-copilot', 'claude-opus-5.5')).toEqual({
    maxWarm: 5,
    policy: {
      warm: { value: true, source: 'default' },
      compact: { value: false, source: 'default' },
      warmMinutes: { value: 30, source: 'default' },
      minCompactTokens: { value: 150_000, source: 'default' },
    },
  })
  const user = {
    branchCache: {
      maxWarm: 3,
      models: {
        'github-copilot/*': { warmMinutes: 20, compact: true },
        'github-copilot/claude-opus-5.5': { warmMinutes: 45 },
      },
    },
  }
  const project = {
    branchCache: { models: { 'github-copilot/*': { minCompactTokens: 'x', warm: false } } },
  }
  expect(readPolicy({ user, project }, 'github-copilot', 'claude-opus-5.5')).toEqual({
    maxWarm: 3,
    policy: {
      warm: { value: false, source: 'project' },
      compact: { value: true, source: 'yours' },
      warmMinutes: { value: 45, source: 'yours' },
      minCompactTokens: { value: 150_000, source: 'default' },
    },
  })
})

it("writes a model's values into user settings and removes them again", () => {
  const settings: JsonObject = { theme: 'dark' }
  writeModelPolicy(settings, 'github-copilot/claude-opus-5.5', { warmMinutes: 45 })
  expect(settings).toEqual({
    theme: 'dark',
    branchCache: { models: { 'github-copilot/claude-opus-5.5': { warmMinutes: 45 } } },
  })
  writeModelPolicy(settings, 'github-copilot/claude-opus-5.5', { warmMinutes: null })
  expect(settings).toEqual({ theme: 'dark' })
})
