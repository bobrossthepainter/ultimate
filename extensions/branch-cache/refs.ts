/** Branch cache in the browser: a coordinator branch's switches, its model's cache policy, and what was done about it. Browser-safe. */
import type { ConversationId, TaskId } from '@earendil-works/pi-durable'
import { actionRef, docRef } from '../../shared/extension-api.ts'

/** One keep-warm request on a branch, recorded as `interrupted` before it is sent. */
export type Ping = {
  at: number
  provider: string
  model: string
  read?: number
  write?: number
  error?: string
}

/** One compaction this extension started: its task, the context size before it, and the cache-reading summary's usage. */
export type Compaction = {
  at: number
  task: TaskId
  tokens: number
  read?: number
  write?: number
  error?: string
}

/** On each coordinator branch. `warm` and `compact` are the user's choices for it; unset follows its model's policy. */
export type BranchCacheDocState = {
  warm?: boolean
  compact?: boolean
  /** The latest ping attempt, failed or not. */
  last?: Ping
  pings?: number
  compaction?: Compaction
}

/** Where a value comes from: this branch's own switch, derived from the model's cache lifetime, the built-in default, the user's settings, or the project's. */
export type Source = 'branch' | 'model' | 'default' | 'yours' | 'project'

export type Setting<T> = { value: T; source: Source }

/** The cache policy of one model, `branchCache.models["provider/model"]` over `["provider/*"]`, the project's over the user's. */
export type ModelPolicy = {
  warm: Setting<boolean>
  compact: Setting<boolean>
  /** How long an idle branch is kept warm after its last request: 30 min on a five-minute cache, 8 h on an hour-long one. */
  warmMinutes: Setting<number>
  minCompactTokens: Setting<number>
}

export type BranchCacheState = {
  /** This branch's switches: its own choice (`branch`), else its model's policy. */
  warm: Setting<boolean>
  compact: Setting<boolean>
  provider?: string
  model?: string
  /** How long the model's provider keeps its prompt cache (ms); unset when it is unknown. */
  ttl?: number
  /** How long after a request on the cache the next ping is due (ms): 90 % of `ttl`, as pi's own warmer. */
  pingAfter?: number
  /** False when the model's requests cannot be re-sent without changing the cache (budget-based thinking). */
  replayable?: boolean
  policy?: ModelPolicy
  /** The latest request on the cache, real or a ping (ms); the cache is warm for `ttl` after it. */
  lastAt?: number
  /** The branch has a run: it is kept warm up to an hour after its request. */
  running?: boolean
  /** Context size now, in tokens. */
  tokens: number
  /** When the next step is due and which, while one will run. */
  next?: { at: number; step: 'ping' | 'compact' }
  /** Why no step is coming, when none is. */
  idle?: string
  last?: Ping
  pings: number
  compaction?: Compaction
}

/** A model's policy values to write to the user's settings; `null` removes one. */
export type ModelPolicyChange = {
  provider: string
  model: string
  warmMinutes?: number | null
  minCompactTokens?: number | null
}

/** On each coordinator branch: its switches, the last ping and the last compaction. */
export const BranchCacheDoc = docRef<BranchCacheDocState>('branch-cache.state')
/** `{ id }` → the branch's switches, its model's cache policy, and its next step. */
export const StateAction = actionRef<{ id: ConversationId }, BranchCacheState>(
  'branch-cache',
  'state',
)
/** User-only `{ id, warm?, compact? }`: turn a branch's switches on or off. Returns the state. */
export const SetAction = actionRef<
  { id: ConversationId; warm?: boolean; compact?: boolean },
  BranchCacheState
>('branch-cache', 'set')
/** User-only: write a model's `warmMinutes` or `minCompactTokens` to `branchCache.models` in the user's settings. */
export const SetModelAction = actionRef<ModelPolicyChange, null>('branch-cache', 'set-model')
