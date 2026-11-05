/** Upstream sync in the browser: what the fork's `upstream` has that the clone lacks, and asking for the merge. */
import { actionRef } from '../../shared/extension-api.ts'

export type UpstreamState = {
  /** The clone Ultimate runs from. */
  root: string
  /** The clone has no `upstream` remote, or this is a preview: no item. */
  off?: true
  /** `upstream`'s default branch, e.g. `main`. */
  branch?: string
  /** Commits on `upstream/<branch>` that the clone lacks, as of the last fetch. */
  behind: number
  /** Commits of the clone's own that upstream lacks: the fork's divergences. */
  ahead: number
  /** The newest missing commits (at most 5), newest first. */
  commits: { sha: string; subject: string }[]
  /** 2–4 plain lines on what the range brings, from the summary model; absent without one. */
  summary?: string[]
  /** DiffsHub's view of the range, for a GitHub upstream. */
  compare?: string
  /** `merge` asks @ultimate for a branch that merges upstream: offered while behind, the clone is the project and nothing refuses. */
  merge?: true
  /** Why no merge is offered: another branch is checked out, or the lander is landing into the clone. */
  refused?: string
  /** Why the last fetch failed; the counts are from the fetch before. */
  error?: string
  /** When upstream was last fetched (ms), by any Ultimate on this clone. */
  fetchedAt?: number
}

/** No arguments → the clone against upstream, from the last fetch (fetched hourly in the background). */
export const StateAction = actionRef<null, UpstreamState>('upstream-sync', 'state')
/** No arguments → fetch upstream now (bypassing the hourly gate, under the clone's lock), then the refreshed state. */
export const CheckAction = actionRef<null, UpstreamState>('upstream-sync', 'check')
/**
 * The user's alone: ask @ultimate for a coordinator branch that merges `upstream/<branch>` with the project's
 * `merge-upstream` skill; @ultimate's conversation id. Only while `merge` is offered.
 */
export const MergeAction = actionRef<null, { id: number }>('upstream-sync', 'merge')
