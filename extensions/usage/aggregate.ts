import type { AssistantMessage } from '@earendil-works/pi-ai'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { cacheBusts, promptTokens } from '../../lib/context-usage.ts'
import type { Bucket, Kinds, RebuildCause, Report } from './refs.ts'

export type Call = {
  conversation: ConversationId
  at: number
  model: string
  cost: Kinds
  tokens: Kinds
  rebuild?: { cause: RebuildCause; cost: number }
}

const CONTEXT_KINDS = new Set(['pi.assistant', 'pi.system', 'pi.compaction', 'pi.reset'])

export const zero = (): Kinds => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
})
export const emptyBucket = (): Bucket => ({
  calls: 0,
  cost: zero(),
  tokens: zero(),
})
export const sum = (kinds: Kinds) => kinds.input + kinds.output + kinds.cacheRead + kinds.cacheWrite

export function addKinds(into: Kinds, from: Kinds) {
  into.input += from.input
  into.output += from.output
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
}

export function addBucket(into: Bucket, from: Bucket) {
  into.calls += from.calls
  addKinds(into.cost, from.cost)
  addKinds(into.tokens, from.tokens)
}

const assistant = (entry: EntryRecord): AssistantMessage | undefined => {
  const message = entry.model?.[0]
  return entry.kind === 'pi.assistant' && message?.role === 'assistant' ? message : undefined
}

export function createCallLog() {
  const calls: Call[] = []
  const conversations = new Map<ConversationId, { tail: EntryRecord[]; last: number }>()
  return {
    calls,
    add(conversation: ConversationId, entries: readonly EntryRecord[]) {
      const state = conversations.get(conversation) ?? { tail: [], last: -1 }
      const fresh = entries
        .filter((entry) => entry.id > state.last && CONTEXT_KINDS.has(entry.kind))
        .toSorted((a, b) => a.id - b.id)
      const newest = entries.reduce((max, entry) => Math.max(max, entry.id), state.last)
      if (!fresh.length) {
        conversations.set(conversation, { ...state, last: newest })
        return
      }
      const window = [...state.tail, ...fresh]
      const busts = cacheBusts(window)
      for (const entry of fresh) {
        const message = assistant(entry)
        if (!message || entry.conversationId !== conversation) continue
        const { usage } = message
        const bust = busts.get(entry.id)
        calls.push({
          conversation,
          at: message.timestamp,
          model: `${message.provider}/${message.model}`,
          cost: {
            input: usage.cost.input,
            output: usage.cost.output,
            cacheRead: usage.cost.cacheRead,
            cacheWrite: usage.cost.cacheWrite,
          },
          tokens: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          ...(bust && {
            rebuild: {
              cause: bust.cause,
              cost: usage.cost.input + usage.cost.cacheWrite,
            },
          }),
        })
      }
      const lastAssistant = window.findLastIndex((entry) => {
        const message = assistant(entry)
        return message !== undefined && promptTokens(message.usage) > 0
      })
      conversations.set(conversation, {
        tail: lastAssistant < 0 ? window : window.slice(lastAssistant),
        last: newest,
      })
    },
  }
}

export type Started = {
  agent: string
  kind: 'child' | 'standing' | 'branch'
  parent?: ConversationId
}
export type Summary = {
  id: ConversationId
  label?: string
  title?: string
  parentConversationId?: ConversationId
  branchOf?: { conversationId: ConversationId }
}

const agentRole = (agent: string) =>
  agent.startsWith('reviewer')
    ? 'reviewer'
    : agent.startsWith('dream')
      ? 'dream'
      : agent.includes(' ')
        ? 'adhoc'
        : agent

export function lineage(
  summaries: readonly Summary[],
  started: ReadonlyMap<ConversationId, Started>,
) {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]))
  const role = (id: ConversationId) => {
    const fact = started.get(id)
    if (fact?.kind === 'standing') return fact.agent === 'ultimate' ? '@ultimate' : `@${fact.agent}`
    if (fact?.kind === 'branch') return 'coordinator'
    if (fact) return agentRole(fact.agent)
    const summary = byId.get(id)
    if (summary?.title?.startsWith('@')) return summary.title
    if (summary?.label) return agentRole(summary.label)
    return 'other'
  }
  const top = (id: ConversationId) => {
    let current = id
    for (let hop = 0; hop < 20; hop++) {
      const fact = started.get(current)
      const summary = byId.get(current)
      if (fact?.kind === 'branch' || fact?.kind === 'standing' || summary?.branchOf) return current
      const parent = fact?.parent ?? summary?.parentConversationId
      if (parent === undefined || parent === ROOT_CONVERSATION_ID) return current
      current = parent
    }
    return current
  }
  const title = (id: ConversationId) => byId.get(id)?.title
  return { role, top, title }
}

const day = (at: number) => {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function merge(reports: readonly Report[], instance: Report['instance']): Report {
  const merged: Report = {
    instance,
    generatedAt: Date.now(),
    total: emptyBucket(),
    daily: [],
    byRole: {},
    byModel: {},
    branches: [],
    rebuilds: { count: 0, cost: 0, byCause: {} },
    undated: { cost: 0, tokens: 0 },
  }
  const days = new Map<string, Report['daily'][number]>()
  for (const report of reports) {
    addBucket(merged.total, report.total)
    for (const row of report.daily) {
      const into = days.get(row.day) ?? { day: row.day, calls: 0, cost: zero() }
      into.calls += row.calls
      addKinds(into.cost, row.cost)
      days.set(row.day, into)
    }
    for (const [role, bucket] of Object.entries(report.byRole)) {
      const into = (merged.byRole[role] ??= { ...emptyBucket(), rebuilds: 0, rebuildCost: 0 })
      addBucket(into, bucket)
      into.rebuilds += bucket.rebuilds
      into.rebuildCost += bucket.rebuildCost
    }
    for (const [model, bucket] of Object.entries(report.byModel)) {
      const into = (merged.byModel[model] ??= { ...emptyBucket(), subscription: false })
      addBucket(into, bucket)
      into.subscription ||= bucket.subscription
    }
    for (const branch of report.branches)
      merged.branches.push({
        ...branch,
        title: `${report.instance.project} · ${branch.title ?? `#${branch.id}`}`,
      })
    merged.rebuilds.count += report.rebuilds.count
    merged.rebuilds.cost += report.rebuilds.cost
    for (const [cause, value] of Object.entries(report.rebuilds.byCause)) {
      const into = (merged.rebuilds.byCause[cause as RebuildCause] ??= { count: 0, cost: 0 })
      into.count += value.count
      into.cost += value.cost
    }
    merged.undated.cost += report.undated.cost
    merged.undated.tokens += report.undated.tokens
  }
  merged.daily = [...days.values()].toSorted((a, b) => a.day.localeCompare(b.day))
  merged.branches = merged.branches.toSorted((a, b) => sum(b.total.cost) - sum(a.total.cost))
  return merged
}

export function summarize(
  calls: readonly Call[],
  options: {
    since?: number
    until?: number
    role: (conversation: ConversationId) => string
    top: (conversation: ConversationId) => ConversationId
    title: (conversation: ConversationId) => string | undefined
    subscription: (provider: string) => boolean
  },
): Omit<Report, 'instance' | 'generatedAt' | 'undated'> {
  const total = emptyBucket()
  const daily = new Map<string, { cost: Kinds; calls: number }>()
  const byRole: Report['byRole'] = {}
  const byModel: Report['byModel'] = {}
  const branches = new Map<ConversationId, Report['branches'][number]>()
  const rebuilds: Report['rebuilds'] = { count: 0, cost: 0, byCause: {} }
  for (const call of calls) {
    if (options.since !== undefined && call.at < options.since) continue
    if (options.until !== undefined && call.at >= options.until) continue
    const one: Bucket = { calls: 1, cost: call.cost, tokens: call.tokens }
    const role = options.role(call.conversation)
    const top = options.top(call.conversation)
    const cost = sum(call.cost)
    addBucket(total, one)
    const today = daily.get(day(call.at)) ?? { cost: zero(), calls: 0 }
    addKinds(today.cost, call.cost)
    today.calls++
    daily.set(day(call.at), today)
    const roleBucket = (byRole[role] ??= {
      ...emptyBucket(),
      rebuilds: 0,
      rebuildCost: 0,
    })
    addBucket(roleBucket, one)
    const modelBucket = (byModel[call.model] ??= {
      ...emptyBucket(),
      subscription: options.subscription(call.model.split('/')[0]),
    })
    addBucket(modelBucket, one)
    const branch = branches.get(top) ?? {
      id: top,
      total: emptyBucket(),
      roles: {},
      rebuilds: 0,
      rebuildCost: 0,
    }
    addBucket(branch.total, one)
    branch.roles[role] = (branch.roles[role] ?? 0) + cost
    branches.set(top, branch)
    if (call.rebuild) {
      rebuilds.count++
      rebuilds.cost += call.rebuild.cost
      const cause = (rebuilds.byCause[call.rebuild.cause] ??= {
        count: 0,
        cost: 0,
      })
      cause.count++
      cause.cost += call.rebuild.cost
      roleBucket.rebuilds++
      roleBucket.rebuildCost += call.rebuild.cost
      branch.rebuilds++
      branch.rebuildCost += call.rebuild.cost
    }
  }
  return {
    ...(options.since !== undefined && { since: options.since }),
    ...(options.until !== undefined && { until: options.until }),
    total,
    daily: [...daily]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ day: key, ...value })),
    byRole,
    byModel,
    branches: [...branches.values()]
      .toSorted((a, b) => sum(b.total.cost) - sum(a.total.cost))
      .map((branch) => {
        const title = options.title(branch.id)
        return { ...branch, ...(title !== undefined && { title }) }
      }),
    rebuilds,
  }
}
