/** Branch cache in the browser: a coordinator branch's toggles, its cache and what was done about it. Browser-safe. */
import type { ConversationId } from '@earendil-works/pi-durable'
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
  task: number
  tokens: number
  read?: number
  write?: number
  error?: string
}

/** On each coordinator branch. `warm` and `compact` are the user's choices; unset follows the project default. */
export type BranchCacheDocState = {
  warm?: boolean
  compact?: boolean
  last?: Ping
  pings?: number
  compaction?: Compaction
}

export type BranchCacheState = {
  warm: boolean
  compact: boolean
  /** The branch's latest request on its cache, an answer or a ping (ms); the cache is warm for an hour after it. */
  lastRequest?: number
  /** The branch's latest input of any kind (ms); pings stop 8 hours after it. */
  inputAt?: number
  /** Context size now, in tokens. */
  tokens: number
  minCompactTokens: number
  /** When the next step is due and which, while one will run. */
  next?: { at: number; step: 'ping' | 'compact' }
  /** Why no step is coming, when none is. */
  idle?: string
  last?: Ping
  pings: number
  compaction?: Compaction
}

/** On each coordinator branch: its toggles, the last ping and the last compaction. */
export const BranchCacheDoc = docRef<BranchCacheDocState>('branch-cache.state')
/** `{ id }` → the branch's toggles, cache and next step. */
export const StateAction = actionRef<{ id: ConversationId }, BranchCacheState>(
  'branch-cache',
  'state',
)
/** User-only `{ id, warm?, compact? }`: turn a branch's toggles on or off. Returns the state. */
export const SetAction = actionRef<
  { id: ConversationId; warm?: boolean; compact?: boolean },
  BranchCacheState
>('branch-cache', 'set')
