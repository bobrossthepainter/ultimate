import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineExtension, UsageDoc } from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  EntryId,
  EntryRecord,
  UsageState,
} from '@earendil-works/pi-durable'
import type { ActionContext } from '../../server/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { rebuiltOnOpen } from '../../lib/errors.ts'
import { onCommit } from '../../lib/commits.ts'
import { postAction, reachable, selfAddress } from '../../lib/remote.ts'
import { Started as StartedEvent } from '../subagents/api.ts'
import {
  addBucket,
  createCallLog,
  emptyBucket,
  lineage,
  merge,
  sum,
  summarize,
} from './aggregate.ts'
import type { Started } from './aggregate.ts'
import { AllAction, ReportAction, SpokeAction, SpokesAction } from './refs.ts'
import type { Instance, Report } from './refs.ts'

type Host = Pick<
  ExtensionHost,
  'harness' | 'onOpen' | 'onClose' | 'notice' | 'conversations' | 'eventLog' | 'modelRuntime'
>
type Index = {
  ready: Promise<void>
  log: ReturnType<typeof createCallLog>
  undated: Map<ConversationId, { cost: number; tokens: number }>
  dated: Map<ConversationId, { cost: number; tokens: number }>
}

const indexes = new WeakMap<object, () => Index | undefined>()

const PAGE = 500

async function scanConversation(host: Host, id: ConversationId) {
  const entries: EntryRecord[] = []
  await host.harness().commit(async (tx) => {
    const forkedAt = (await tx.conversation(id))?.parent?.at
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanEntries(
        {
          conversationId: id,
          order: 'ascending',
          ...(forkedAt !== undefined && { minEntryId: forkedAt }),
        },
        PAGE,
        cursor,
      )
      entries.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
  }, context)
  return entries
}

const usageSpend = (state: UsageState | undefined) => {
  let cost = 0
  let tokens = 0
  for (const bucket of [
    ...Object.values(state?.models ?? {}),
    ...Object.values(state?.tools ?? {}),
  ]) {
    cost += bucket.cost.total
    tokens += bucket.input + bucket.output + bucket.cacheRead + bucket.cacheWrite
  }
  return { cost, tokens }
}

async function startedFacts(host: Pick<Host, 'eventLog'>) {
  const facts = new Map<ConversationId, Started>()
  let before: EntryId | undefined
  for (;;) {
    const page = await host.eventLog.recent({
      events: [StartedEvent],
      ...(before === undefined ? {} : { before }),
      limit: PAGE,
    })
    for (const { data } of page)
      if (!facts.has(data.id))
        facts.set(data.id, {
          agent: data.agent,
          kind: data.kind,
          ...(data.parent !== undefined && { parent: data.parent }),
        })
    if (page.length < PAGE) return facts
    before = page.at(-1)!.id
  }
}

export async function report(
  host: Pick<Host, 'conversations' | 'eventLog' | 'modelRuntime'>,
  index: Index,
  instance: Report['instance'],
  range: { since?: number; until?: number },
): Promise<Report> {
  await index.ready
  const { role, top, title } = lineage(host.conversations(), await startedFacts(host))
  const summary = summarize(index.log.calls, {
    ...range,
    role,
    top,
    title,
    subscription: (provider) => host.modelRuntime.isUsingSubscription(provider),
  })
  const undated = { cost: 0, tokens: 0 }
  for (const [id, whole] of index.undated) {
    const counted = index.dated.get(id) ?? { cost: 0, tokens: 0 }
    undated.cost += Math.max(0, whole.cost - counted.cost)
    undated.tokens += Math.max(0, whole.tokens - counted.tokens)
  }
  return { instance, generatedAt: Date.now(), ...summary, undated }
}

const range = (args: unknown) => {
  const object = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const time = (key: string) => {
    const value = object[key]
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error(`${key} must be a time in ms`)
    return value
  }
  const since = time('since')
  const until = time('until')
  return {
    ...(since !== undefined && { since }),
    ...(until !== undefined && { until }),
  }
}

const indexOf = (host: object) => {
  const index = indexes.get(host)?.()
  if (!index) throw new Error('Usage is not open yet')
  return index
}

type Target = { url: string; label: string; name: string; machine?: string }
type Remote = (
  target: Target,
  extension: string,
  action: string,
  args: JsonValue,
) => Promise<unknown>

export function fallbackFromUsage(
  instance: Report['instance'],
  usages: readonly UsageState[],
): Report {
  const total = emptyBucket()
  const byModel: Report['byModel'] = {}
  const undated = { cost: 0, tokens: 0 }
  for (const state of usages) {
    const tools = usageSpend({ models: {}, tools: state.tools })
    undated.cost += tools.cost
    undated.tokens += tools.tokens
    for (const [model, bucket] of Object.entries(state.models)) {
      const one = {
        calls: 0,
        cost: {
          input: bucket.cost.input,
          output: bucket.cost.output,
          cacheRead: bucket.cost.cacheRead,
          cacheWrite: bucket.cost.cacheWrite,
        },
        tokens: {
          input: bucket.input,
          output: bucket.output,
          cacheRead: bucket.cacheRead,
          cacheWrite: bucket.cacheWrite,
        },
      }
      addBucket((byModel[model] ??= { ...emptyBucket(), subscription: false }), one)
      addBucket(total, one)
    }
  }
  return {
    instance,
    generatedAt: Date.now(),
    total,
    daily: [],
    byRole: {},
    byModel,
    branches: [],
    rebuilds: { count: 0, cost: 0, byCause: {} },
    undated,
    fallback: true,
  }
}

export async function spokeReport(
  target: Target,
  args: { since?: number; until?: number },
  remote: Remote,
): Promise<Report> {
  try {
    return (await remote(target, 'usage', 'report', args)) as Report
  } catch (error) {
    if (!String(error).includes('Unknown extension action')) throw error
  }
  const read = (op: string, readArgs: JsonValue[]) =>
    remote(target, 'codemode', 'read', { op, args: readArgs })
  const conversations = (await read('conversations', [])) as { id: number }[]
  const usages = await Promise.all(
    conversations.map(async ({ id }) => (await read('doc', ['pi.usage', id])) as UsageState),
  )
  return fallbackFromUsage(
    { project: target.name, machine: target.machine ?? 'this machine' },
    usages,
  )
}

const remoteWith =
  (signal: AbortSignal): Remote =>
  (target, extension, action, args) =>
    postAction(target, extension, action, args, signal)

export const actions = {
  report: implementAction(ReportAction, async (args, { host }: Pick<ActionContext, 'host'>) =>
    report(host, indexOf(host), await selfAddress(host), range(args)),
  ),
  spokes: implementAction(SpokesAction, (_args, { host }: Pick<ActionContext, 'host'>) =>
    reachable(host),
  ),
  spoke: implementAction(SpokeAction, async (args, { host, signal }: ActionContext) => {
    const url = args && typeof args === 'object' && 'url' in args ? args.url : undefined
    if (typeof url !== 'string' || !url) throw new Error('url must be nonempty')
    const target = (await reachable(host)).spokes.find((spoke) => spoke.url === url)
    if (!target) throw new Error(`${url} is not a spoke of this instance`)
    return spokeReport(target, range(args), remoteWith(signal))
  }),
  all: implementAction(AllAction, async (args, { host, signal }: ActionContext) => {
    const window = range(args)
    const self = await selfAddress(host)
    const { spokes } = await reachable(host)
    const remote = remoteWith(signal)
    const instances: Instance[] = await Promise.all([
      report(host, indexOf(host), self, window).then(
        (found) => ({ label: 'this instance', report: found }),
        (error: unknown) => ({ label: 'this instance', error: String(error) }),
      ),
      ...spokes.map(async (spoke) => {
        try {
          return { label: spoke.label, report: await spokeReport(spoke, window, remote) }
        } catch (error) {
          return {
            label: spoke.label,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    ])
    const reports = instances.flatMap((instance) =>
      instance.report && !instance.report.fallback ? [instance.report] : [],
    )
    return { instances, merged: merge(reports, { project: 'all', machine: self.machine }) }
  }),
}

export default function usage(host: Host) {
  let current: Index | undefined
  let unsubscribe: (() => void) | undefined
  let epoch = 0
  indexes.set(host, () => current)
  const stop = () => {
    epoch++
    unsubscribe?.()
    unsubscribe = undefined
    current = undefined
  }
  host.onClose(async () => stop())
  host.onOpen(async () => {
    stop()
    const opened = epoch
    const index: Index = {
      ready: Promise.resolve(),
      log: createCallLog(),
      undated: new Map(),
      dated: new Map(),
    }
    const pending = new Map<ConversationId, EntryRecord[]>()
    let seeded = false
    const count = (id: ConversationId, entries: readonly EntryRecord[]) => {
      const before = index.log.calls.length
      index.log.add(id, entries)
      const counted = index.dated.get(id) ?? { cost: 0, tokens: 0 }
      for (const call of index.log.calls.slice(before)) {
        counted.cost += sum(call.cost)
        counted.tokens += sum(call.tokens)
      }
      index.dated.set(id, counted)
    }
    unsubscribe = onCommit(host.harness(), (publication) => {
      for (const change of publication.changes) {
        if (change.type === 'entry') {
          const entry = change.value
          if (!seeded)
            pending.set(entry.conversationId, [...(pending.get(entry.conversationId) ?? []), entry])
          else count(entry.conversationId, [entry])
        }
        if (
          change.type === 'document' &&
          change.conversationId !== undefined &&
          change.record.kind === UsageDoc.definition.kind
        )
          index.undated.set(
            change.conversationId,
            usageSpend(change.kind === 'change' ? (change.value as UsageState) : undefined),
          )
      }
    })
    current = index
    index.ready = (async () => {
      const ids: ConversationId[] = []
      await host.harness().commit(async (tx) => {
        let cursor: Cursor | undefined
        do {
          const page = await tx.scanConversations({}, 256, cursor)
          for (const conversation of page.items) {
            ids.push(conversation.id)
            if (!index.undated.has(conversation.id))
              index.undated.set(
                conversation.id,
                usageSpend(await tx.doc(UsageDoc, conversation.id)),
              )
          }
          cursor = page.next
        } while (cursor !== undefined)
      }, context)
      for (const id of ids) {
        if (opened !== epoch) return
        count(id, await scanConversation(host, id))
      }
      seeded = true
      for (const [id, entries] of pending) count(id, entries)
      pending.clear()
    })()
    rebuiltOnOpen(
      'open reads the usage history again',
      index.ready.catch((error: unknown) => {
        if (opened === epoch) host.notice(`Usage could not read the history: ${String(error)}`)
      }),
    )
  })
  return defineExtension({ name: 'usage' })
}
