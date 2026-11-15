import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord/json'
import {
  CompactionTask,
  defineDoc,
  defineExtension,
  hook,
  LiveDoc,
} from '@earendil-works/pi-durable'
import type {
  ConversationId,
  Cursor,
  JsonObject,
  ModelRef,
  TaskId,
  Tx,
} from '@earendil-works/pi-durable'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ConversationSummary } from '../../shared/protocol.ts'
import { implementAction } from '../../lib/actions.ts'
import { admitCompaction, compacting } from '../../lib/compaction.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { every } from '../../lib/timers.ts'
import { ContextUsageDoc, ConversationsApi } from '../conversations/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { PauseApi } from '../pause/api.ts'
import { LEAD, nextStep, TTL, warmWindowOpen, failing } from './due.ts'
import type { Situation } from './due.ts'
import { BranchCacheDoc, SetAction, StateAction } from './refs.ts'
import type { BranchCacheDocState, BranchCacheState, Compaction, Ping } from './refs.ts'

const State = defineDoc<BranchCacheDocState>({
  kind: BranchCacheDoc.kind,
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({}),
})
export const docs = [State]
export const order = -1

const CACHE_CHECK_INTERVAL_MS = 60_000
const PING_TIMEOUT_MS = 180_000
const SUMMARY_TIMEOUT_MS = 300_000
const PING_QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'
const SUMMARY_REQUEST =
  'Context compaction from Ultimate, not from the user: do not continue the work and call no tools. Write the summary this branch continues from, in Markdown. Keep its intent and progress toward it: decisions and who made them, open questions and what it waits for, changed files, verification, what remains. Preserve exact file paths, names and errors; cite entries as #<conversation>/<entry>. The most recent turns stay verbatim after the summary. Output only the summary.'

export type Settings = {
  maxWarm: number
  minCompactTokens: number
  warm: boolean
  compact: boolean
}

export function readSettings(project: JsonObject): Settings {
  const raw = project.branchCache
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const defaults =
    value.default && typeof value.default === 'object' && !Array.isArray(value.default)
      ? value.default
      : {}
  const count = (input: unknown, fallback: number) =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? input : fallback
  return {
    maxWarm: count(value.maxWarm, 5),
    minCompactTokens: count(value.minCompactTokens, 150_000),
    warm: defaults.warm === true,
    compact: defaults.compact === true,
  }
}

export const hourLong = (provider: string) =>
  provider === 'claude-code' ||
  (provider === 'anthropic' && process.env.PI_CACHE_RETENTION === 'long')

export const cached = (message: AssistantMessage, model: ModelRef) =>
  message.provider === model.provider &&
  message.model === model.modelId &&
  message.stopReason !== 'error' &&
  message.stopReason !== 'aborted' &&
  message.usage.cacheRead + message.usage.cacheWrite > 0

const lastOn = (last: Ping | undefined, model: ModelRef) =>
  last?.provider === model.provider && last.model === model.modelId ? last : undefined

export const isCoordinator = (summary: ConversationSummary) =>
  summary.label === 'coordinator' && summary.ownerTaskId === undefined

const read = async (host: ExtensionHost, id: ConversationId) =>
  (await host.harness().snapshot(State, id, context)) ?? {}

async function lastCacheRenewingAnswerAtMs(
  host: ExtensionHost,
  id: ConversationId,
  model: ModelRef,
  now: number,
) {
  const conversation = (await host.harness().conversation(id, context))!
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries({}, 100, cursor, context)
    for (const entry of page.items) {
      const message = entry.model?.[0]
      if (message?.role !== 'assistant') continue
      if (now - message.timestamp >= TTL) return undefined
      if (cached(message, model)) return message.timestamp
    }
    cursor = page.next
  } while (cursor)
  return undefined
}

type Branch = {
  id: ConversationId
  provider: string
  model: string
  doc: BranchCacheDocState
  settings: Settings
  situation: Situation
}

async function branchOf(
  host: ExtensionHost,
  summary: ConversationSummary,
  settings: Settings,
  now: number,
): Promise<Branch | undefined> {
  const id = summary.id
  const conversation = await host.harness().conversation(id, context)
  if (!conversation) return undefined
  const model = (await conversation.agent(context)).model
  if (!model || !hourLong(model.provider)) return undefined
  const doc = await read(host, id)
  const answered = await lastCacheRenewingAnswerAtMs(host, id, model, now)
  const last = lastOn(doc.last, model)
  const pinged = lastOn(doc.warmed, model)?.at
  const usage = await host.harness().snapshot(ContextUsageDoc, id, context)
  return {
    id,
    provider: model.provider,
    model: model.modelId,
    doc,
    settings,
    situation: {
      now,
      lastRequest: Math.max(answered ?? 0, pinged ?? 0) || undefined,
      inputAt: summary.inputAt,
      failedAfter: last?.error ? last.at : undefined,
      warm: doc.warm ?? settings.warm,
      compact: doc.compact ?? settings.compact,
      tokens: usage?.tokens ?? 0,
      minCompactTokens: settings.minCompactTokens,
      compactedAt: doc.compaction?.at,
    },
  }
}

async function openCoordinators(host: ExtensionHost) {
  const concluded = await host.need(ConversationsApi).concluded(context)
  return host
    .conversations()
    .filter((summary) => isCoordinator(summary) && !concluded.has(summary.id))
}

export function warmAllowed(
  candidates: { id: ConversationId; inputAt?: number; warm: boolean }[],
  now: number,
  maxWarm: number,
) {
  return new Set(
    candidates
      .filter((candidate) => candidate.warm && warmWindowOpen(now, candidate.inputAt))
      .toSorted((a, b) => (b.inputAt ?? 0) - (a.inputAt ?? 0))
      .slice(0, maxWarm)
      .map((candidate) => candidate.id),
  )
}

async function branches(host: ExtensionHost, now: number) {
  const settings = readSettings(await host.projectSettings())
  const found: Branch[] = []
  for (const summary of await openCoordinators(host)) {
    const branch = await branchOf(host, summary, settings, now)
    if (branch && (branch.situation.warm || branch.situation.compact)) found.push(branch)
  }
  const allowed = warmAllowed(
    found.map((branch) => ({ id: branch.id, ...branch.situation })),
    now,
    settings.maxWarm,
  )
  for (const branch of found)
    branch.situation = {
      ...branch.situation,
      warm: branch.situation.warm && allowed.has(branch.id),
    }
  return { settings, found }
}

const cacheOpen = (paused: boolean | undefined, lastRequest: number, now: number) =>
  !paused && now - lastRequest < TTL

async function commitIdleUnchangedStillOn(
  host: ExtensionHost,
  branch: Branch,
  toggle: 'warm' | 'compact',
  change: (tx: Tx, doc: BranchCacheDocState) => Promise<void> | void,
) {
  const { id, doc: previous, settings } = branch
  return host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, id)
    const unchanged =
      doc.last?.at === previous.last?.at && doc.compaction?.at === previous.compaction?.at
    const stillOn = doc[toggle] ?? settings[toggle]
    const withinHour = Date.now() - branch.situation.lastRequest! < TTL
    if (!unchanged || !stillOn || !withinHour || (await tx.doc(LiveDoc, id)).run) return false
    await change(tx, doc)
    return true
  }, context)
}

function receipt(answer: AssistantMessage): ResponseReceipt {
  return {
    provider: answer.provider,
    model: answer.model,
    usage: copyJson(answer.usage, { omitUndefinedProperties: true }) as ResponseReceipt['usage'],
    text: '',
    stopReason: answer.stopReason,
  }
}

async function commitPingOutcome(
  host: ExtensionHost,
  id: ConversationId,
  last: Ping,
  answer?: AssistantMessage,
) {
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, id)
    doc.last = last
    if (last.error === undefined) doc.warmed = last
    if (answer) await host.need(ConversationsApi).accountResponse(tx, id, receipt(answer))
  }, context)
}

async function nextRequestMessages(host: ExtensionHost, id: ConversationId) {
  const conversation = (await host.harness().conversation(id, context))!
  let messages: Message[] = [...(await conversation.context(context)).messages]
  const leadingConversationIdentity = `You are conversation #${id}.`
  if (
    !messages.some(
      (message) => message.role === 'user' && message.content === leadingConversationIdentity,
    )
  )
    messages = [{ role: 'user', content: leadingConversationIdentity, timestamp: 0 }, ...messages]
  return { messages, agent: await conversation.agent(context) }
}

async function sendOneShotPingWithoutSession(host: ExtensionHost, branch: Branch) {
  const paused = () => host.want(PauseApi)?.paused()
  const { id, provider } = branch
  const lastRequest = branch.situation.lastRequest!
  const model = host.modelRuntime.getModel(provider, branch.model)
  if (!model) return
  const { messages, agent } = await nextRequestMessages(host, id)
  const at = Date.now()
  messages.push({ role: 'user', content: PING_QUESTION, timestamp: at })
  if (!cacheOpen(paused(), lastRequest, Date.now())) return
  const attempt: Ping = { at, provider, model: branch.model, error: 'interrupted' }
  const claimed = await commitIdleUnchangedStillOn(host, branch, 'warm', (_tx, doc) => {
    doc.last = attempt
    doc.pings = (doc.pings ?? 0) + 1
  })
  if (!claimed) return
  if (!cacheOpen(paused(), lastRequest, Date.now())) {
    await commitPingOutcome(host, id, { ...attempt, error: 'skipped: paused or expired' })
    return
  }
  let answer: AssistantMessage
  try {
    answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages },
        {
          ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        },
      )
      .result()
  } catch (error) {
    await commitPingOutcome(host, id, {
      ...attempt,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }
  const failed = answer.stopReason === 'error' || answer.stopReason === 'aborted'
  await commitPingOutcome(
    host,
    id,
    failed
      ? { ...attempt, error: answer.errorMessage ?? answer.stopReason }
      : {
          at,
          provider,
          model: branch.model,
          read: answer.usage.cacheRead,
          write: answer.usage.cacheWrite,
        },
    answer,
  )
}

async function startCompaction(host: ExtensionHost, branch: Branch) {
  const { id } = branch
  if (host.want(PauseApi)?.paused()) return
  await commitIdleUnchangedStillOn(host, branch, 'compact', async (tx, doc) => {
    if (await compacting(tx, id)) return
    const task = await admitCompaction(tx, id)
    doc.compaction = { at: Date.now(), task, tokens: branch.situation.tokens }
  })
}

async function tick(host: ExtensionHost) {
  if (host.want(PauseApi)?.paused()) return
  const now = Date.now()
  const { found } = await branches(host, now)
  for (const branch of found) {
    if (host.want(PauseApi)?.paused()) return
    const step = nextStep(branch.situation)
    if (step === 'ping') await sendOneShotPingWithoutSession(host, branch)
    if (step === 'compact') await startCompaction(host, branch)
  }
}

const text = (message: AssistantMessage) =>
  message.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim()

async function commitCompactionUsage(
  host: ExtensionHost,
  id: ConversationId,
  task: TaskId,
  outcome: Pick<Compaction, 'read' | 'write' | 'error'>,
  answer?: AssistantMessage,
) {
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, id)
    if (doc.compaction?.task === task) Object.assign(doc.compaction, outcome)
    if (answer) await host.need(ConversationsApi).accountResponse(tx, id, receipt(answer))
  }, context)
}

async function summaryFromCache(
  host: ExtensionHost,
  id: ConversationId,
  task: TaskId,
  keep: (summary: string) => Promise<string>,
) {
  const { messages, agent } = await nextRequestMessages(host, id)
  const model = agent.model && host.modelRuntime.getModel(agent.model.provider, agent.model.modelId)
  if (!model) return undefined
  messages.push({ role: 'user', content: SUMMARY_REQUEST, timestamp: Date.now() })
  let answer: AssistantMessage
  try {
    answer = await host.modelRuntime
      .streamSimple(
        model,
        { messages },
        {
          ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
          signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
        },
      )
      .result()
  } catch (error) {
    await commitCompactionUsage(host, id, task, {
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
  const fresh = answer.stopReason === 'stop' ? text(answer) : ''
  const summary = fresh ? await keep(fresh) : undefined
  await commitCompactionUsage(
    host,
    id,
    task,
    summary
      ? { read: answer.usage.cacheRead, write: answer.usage.cacheWrite }
      : { error: answer.errorMessage ?? `no summary (${answer.stopReason})` },
    answer,
  )
  return summary
}

async function state(host: ExtensionHost, id: ConversationId): Promise<BranchCacheState> {
  const now = Date.now()
  const { settings, found } = await branches(host, now)
  const doc = await read(host, id)
  const summary = host.conversations().find((candidate) => candidate.id === id)
  const usage = await host.harness().snapshot(ContextUsageDoc, id, context)
  const branch =
    found.find((candidate) => candidate.id === id) ??
    (summary && (await branchOf(host, summary, settings, now)))
  const base: BranchCacheState = {
    warm: doc.warm ?? settings.warm,
    compact: doc.compact ?? settings.compact,
    tokens: usage?.tokens ?? 0,
    minCompactTokens: settings.minCompactTokens,
    pings: doc.pings ?? 0,
    ...(summary?.inputAt === undefined ? {} : { inputAt: summary.inputAt }),
    ...(doc.last ? { last: doc.last } : {}),
    ...(doc.compaction ? { compaction: doc.compaction } : {}),
  }
  if (!branch) return { ...base, idle: 'Not on a provider with an hour-long cache' }
  const { situation } = branch
  const withRequest =
    situation.lastRequest === undefined ? base : { ...base, lastRequest: situation.lastRequest }
  if (situation.lastRequest === undefined) return { ...withRequest, idle: 'No warm cache' }
  const at = situation.lastRequest + LEAD
  const step = nextStep({ ...situation, now: Math.max(now, at) })
  if (step) return { ...withRequest, next: { at, step } }
  if (base.warm && !situation.warm && warmWindowOpen(now, situation.inputAt))
    return { ...withRequest, idle: `Over the limit of ${settings.maxWarm} warm branches` }
  if (base.warm && failing(situation.failedAfter, situation.lastRequest))
    return { ...withRequest, idle: 'Last ping failed; waiting for the next answer' }
  if (base.compact && situation.tokens < settings.minCompactTokens)
    return {
      ...withRequest,
      idle: `Too small to compact (under ${Math.round(settings.minCompactTokens / 1000)}k)`,
    }
  return withRequest
}

export default function branchCache(host: ExtensionHost) {
  host.need(ConversationsApi)
  host.want(PauseApi)
  const shared = host.resource('branch-cache.timer', () => ({
    running: undefined as Promise<void> | undefined,
  }))
  const stopPolling = every(CACHE_CHECK_INTERVAL_MS, () => {
    shared.running ??= tick(host)
      .catch((error: unknown) => host.notice(`Branch cache: ${String(error)}`))
      .finally(() => {
        shared.running = undefined
      })
  })
  host.onClose(async () => {
    stopPolling()
    await shared.running
  })
  return defineExtension({
    name: 'branch-cache',
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async (_compaction, api, ctx) => {
          const doc = await api.snapshot(State, api.conversationId, ctx)
          if (doc?.compaction?.task !== api.taskId) return undefined
          const kept = await api.memo<string>('branch-cache.summary', ctx)
          if (kept !== undefined) return { summary: kept }
          if ((await api.snapshot(LiveDoc, api.conversationId, ctx))?.run) return undefined
          const summary = await summaryFromCache(host, api.conversationId, api.taskId, (fresh) =>
            api.memo('branch-cache.summary', fresh, ctx),
          )
          return summary === undefined ? undefined : { summary }
        },
      }),
    ],
  })
}

function conversationArg(args: unknown) {
  const id = (args as { id?: unknown } | null)?.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected { id: conversation }')
  return parseConversationId(id)
}

export const actions = {
  state: implementAction(StateAction, (args, { host }) => state(host, conversationArg(args))),
  set: implementAction(SetAction, async (args, { host }) => {
    const id = conversationArg(args)
    const { warm, compact } = args as { warm?: unknown; compact?: unknown }
    if (warm !== undefined && typeof warm !== 'boolean') throw new Error('warm must be a boolean')
    if (compact !== undefined && typeof compact !== 'boolean')
      throw new Error('compact must be a boolean')
    const summary = host.conversations().find((candidate) => candidate.id === id)
    if (!summary || !isCoordinator(summary)) throw new Error(`#${id} is not a branch coordinator`)
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, id)
      if (warm !== undefined) doc.warm = warm
      if (compact !== undefined) doc.compact = compact
    }, context)
    return state(host, id)
  }),
}
export const userActions = ['set']
