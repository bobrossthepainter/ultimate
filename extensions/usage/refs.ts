/**
 * Usage in the browser: what this instance's model calls cost at list price, by day, cost type, role, model and branch,
 * and the same report from the other instances it reaches (its spokes). Browser-safe.
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { actionRef } from '../../shared/extension-api.ts'

/** Tokens or dollars by kind: uncached input, output, cache reads and cache writes. */
export type Kinds = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Model calls, their list-price cost by kind in dollars, and their tokens by kind. */
export type Bucket = { calls: number; cost: Kinds; tokens: Kinds }

/** Why a call rebuilt the prompt cache, as the transcript's cache-rebuilt line names it. */
export type RebuildCause = 'system' | 'model' | 'expired' | 'prefix'

/** Cache rebuilds: how many, and what their freshly sent input (uncached input and cache writes) cost. */
export type Rebuilds = {
  count: number
  cost: number
  byCause: Partial<Record<RebuildCause, { count: number; cost: number }>>
}

/**
 * One instance's usage over a time range. Costs are Pi's list-price estimates, not what a subscription bills. Calls are
 * the stored model responses; `undated` is spend recorded without one (tool usage, titles and summaries, keep-warm
 * pings), all time, so `total` plus `undated` is the instance's whole `pi.usage`.
 */
export type Report = {
  instance: { project: string; machine: string }
  since?: number
  until?: number
  generatedAt: number
  total: Bucket
  /** One row per local calendar day with calls, oldest first, `YYYY-MM-DD`. */
  daily: { day: string; cost: Kinds; calls: number }[]
  /** By agent role: `@ultimate`, `coordinator`, `worker`, `reviewer`, `lander`, … */
  byRole: Record<string, Bucket & { rebuilds: number; rebuildCost: number }>
  /** By `provider/model`; `subscription` when this instance reaches that provider through a plan, not per token. */
  byModel: Record<string, Bucket & { subscription: boolean }>
  /** Every top-level conversation (branch, standing agent) with its subagents, costliest first, and each role's cost in it. */
  branches: {
    id: ConversationId
    title?: string
    total: Bucket
    roles: Record<string, number>
  }[]
  rebuilds: Rebuilds
  undated: { cost: number; tokens: number }
  /** Set when the spoke has no usage extension: totals by model from its `pi.usage` documents only. */
  fallback?: true
}

/** Another instance this one reaches: a project running on this machine, in `remotes`, or in the cloud register. */
export type Spoke = { project: string; machine?: string; label: string }

/** `{ since?, until? }` (ms) → this instance's report over that range; all time without them. */
export const ReportAction = actionRef<{ since?: number; until?: number }, Report>('usage', 'report')
/** No arguments → the other instances this one reaches, and why some could not be listed. */
export const SpokesAction = actionRef<null, { spokes: Spoke[]; errors: string[] }>(
  'usage',
  'spokes',
)
/**
 * `{ project, machine?, since?, until? }` → that instance's report: from its usage extension, else its `pi.usage`
 * totals (`fallback`). Throws when it cannot be reached.
 */
export const SpokeAction = actionRef<
  { project: string; machine?: string; since?: number; until?: number },
  Report
>('usage', 'spoke')

/** One instance of `all`: its report, or why it could not be read. */
export type Instance = { label: string; report?: Report; error?: string }

/**
 * `{ since?, until? }` → this instance and every spoke, read in parallel, and their reports merged into one
 * (`merged.branches` titles name their instance). Spokes that failed, and those with totals only (`fallback`, all time
 * whatever the range), are left out of `merged`.
 */
export const AllAction = actionRef<
  { since?: number; until?: number },
  { instances: Instance[]; merged: Report }
>('usage', 'all')
