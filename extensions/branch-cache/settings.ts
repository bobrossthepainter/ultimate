import type { JsonObject } from '@earendil-works/pi-durable'
import type { ModelPolicy, Setting, Source } from './refs.ts'

export const DEFAULTS = { warm: true, compact: false, warmMinutes: 30, minCompactTokens: 150_000 }
export const DEFAULT_MAX_WARM = 5

const objectOf = (raw: unknown) =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonObject) : {}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export function readPolicy(
  layers: { user: JsonObject; project: JsonObject },
  provider: string,
  model: string,
): { maxWarm: number; policy: ModelPolicy } {
  const user = objectOf(layers.user.branchCache)
  const project = objectOf(layers.project.branchCache)
  const entries = (
    [
      [user, 'yours'],
      [project, 'project'],
    ] as const
  ).flatMap(([value, source]) =>
    [`${provider}/*`, `${provider}/${model}`].map((key) => ({
      source: source as Source,
      value: objectOf(objectOf(value.models)[key]),
    })),
  )
  function pick<T>(key: string, fallback: Setting<T>, valid: (value: unknown) => value is T) {
    let found = fallback
    for (const entry of entries)
      if (valid(entry.value[key])) found = { value: entry.value[key], source: entry.source }
    return found
  }
  const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
  const byDefault = <T>(value: T): Setting<T> => ({ value, source: 'default' })
  const maxWarm = [project.maxWarm, user.maxWarm].find(isCount) ?? DEFAULT_MAX_WARM
  return {
    maxWarm,
    policy: {
      warm: pick('warm', byDefault(DEFAULTS.warm), isBoolean),
      compact: pick('compact', byDefault(DEFAULTS.compact), isBoolean),
      warmMinutes: pick('warmMinutes', byDefault(DEFAULTS.warmMinutes), isCount),
      minCompactTokens: pick('minCompactTokens', byDefault(DEFAULTS.minCompactTokens), isCount),
    },
  }
}

export function writeModelPolicy(
  settings: JsonObject,
  key: string,
  change: { warmMinutes?: number | null; minCompactTokens?: number | null },
) {
  const branchCache = objectOf(settings.branchCache)
  const models = objectOf(branchCache.models)
  const entry = { ...objectOf(models[key]) }
  for (const field of ['warmMinutes', 'minCompactTokens'] as const) {
    const value = change[field]
    if (value === null) delete entry[field]
    else if (value !== undefined) entry[field] = value
  }
  if (Object.keys(entry).length) models[key] = entry
  else delete models[key]
  if (Object.keys(models).length) branchCache.models = models
  else delete branchCache.models
  if (Object.keys(branchCache).length) settings.branchCache = branchCache
  else delete settings.branchCache
}
