import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord/json'
import {
  CompactionTask,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
} from '@earendil-works/pi-durable'
import type { ConversationId, JsonObject, TaskId } from '@earendil-works/pi-durable'
import {
  CACHE_WARMING_MAX_AGE_MS,
  getCacheWarmingDelayMs,
  getCacheWarmingRequestOptions,
  getPromptCacheTtlMs,
  isCacheWarmingReplayable,
} from '@earendil-works/pi-ai'
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ConversationSummary } from '../../shared/protocol.ts'
import { implementAction } from '../../lib/actions.ts'
import { admitCompaction, compacting } from '../../lib/compaction.ts'
import { inProcess } from '../../lib/errors.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { ContextUsageDoc, ConversationsApi } from '../conversations/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { PauseApi } from '../pause/api.ts'
import { decide } from './due.ts'
import type { Policy, Situation } from './due.ts'
import { BranchCacheDoc, SetAction, SetModelAction, StateAction } from './refs.ts'
import type { BranchCacheDocState, BranchCacheState, Compaction, Ping, Setting } from './refs.ts'
import { DEFAULTS, readPolicy, writeModelPolicy } from './settings.ts'

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

const PING_TIMEOUT_MS = 180_000
const SUMMARY_TIMEOUT_MS = 300_000
const SUMMARY_REQUEST =
  'Context compaction from Ultimate, not from the user: do not continue the work and call no tools. Write the summary this branch continues from, in Markdown. Keep its intent and progress toward it: decisions and who made them, open questions and what it waits for, changed files, verification, what remains. Preserve exact file paths, names and errors; cite entries as #<conversation>/<entry>. The most recent turns stay verbatim after the summary. Output only the summary.'
const OUTPUT_CAP_FIELD: Partial<Record<Api, string>> = { 'anthropic-messages': 'max_tokens' }
const CLAUDE_CODE_TTL_MS = 3_600_000
const PING_QUESTION = 'Cache keep-warm check from Ultimate, not from the user. Reply with just: ok'

type Run = {
  id: ConversationId
  model: Model<Api>
  payload?: unknown
  ttl: number
  delayBeforeRefresh: number
  realRequestAt: number
  lastCacheRequestAt: number
  nextAt: number
  controller: AbortController
  cancel?: Cancel
}

type Runs = {
  sent: Map<ConversationId, { model: Model<Api>; payload: unknown; at: number }>
  active: Map<ConversationId, Run>
  stopped: Map<ConversationId, string>
}

export const isCoordinator = (summary: ConversationSummary) =>
  summary.label === 'coordinator' && summary.ownerTaskId === undefined

const isOpenCoordinator = (host: ExtensionHost, id: ConversationId) => {
  const summary = host.conversations().find((candidate) => candidate.id === id)
  return summary !== undefined && isCoordinator(summary)
}

export function oneTokenPayload(api: Api, payload: unknown) {
  const field = OUTPUT_CAP_FIELD[api]
  if (!field || !payload || typeof payload !== 'object' || !(field in payload)) return undefined
  return { ...(payload as JsonObject), [field]: 1 }
}

export function cacheTiming(model: Model<Api>) {
  const ttl =
    getPromptCacheTtlMs(model, undefined) ??
    (model.provider === 'claude-code' ? CLAUDE_CODE_TTL_MS : undefined)
  const delayBeforeRefresh = ttl === undefined ? undefined : getCacheWarmingDelayMs(ttl)
  return ttl === undefined || delayBeforeRefresh === undefined
    ? undefined
    : { ttl, delayBeforeRefresh }
}

const readDoc = async (host: ExtensionHost, id: ConversationId) =>
  (await host.harness().snapshot(State, id, context)) ?? {}

async function settingsLayers(host: ExtensionHost) {
  const user = await readSettings(userSettingsPath(host.userHome)).catch((error: unknown) => {
    host.notice(`Branch cache: ${String(error)}`)
    return {}
  })
  return { user, project: await host.projectSettings() }
}

async function branchPolicy(host: ExtensionHost, id: ConversationId, model: Model<Api>) {
  const { maxWarm, policy } = readPolicy(await settingsLayers(host), model.provider, model.id)
  const doc = await readDoc(host, id)
  const effective: Policy = {
    warm: doc.warm ?? policy.warm.value,
    compact: doc.compact ?? policy.compact.value,
    warmMs: policy.warmMinutes.value * 60_000,
    minCompactTokens: policy.minCompactTokens.value,
  }
  return { maxWarm, policy, effective, doc }
}

async function agentOf(host: ExtensionHost, id: ConversationId) {
  const conversation = await host.harness().conversation(id, context)
  return conversation && (await conversation.agent(context))
}

async function situationOf(host: ExtensionHost, runs: Runs, run: Run, now: number) {
  const { maxWarm, effective, doc } = await branchPolicy(host, run.id, run.model)
  const warming: Run[] = []
  for (const other of runs.active.values())
    if (other.id === run.id || (await branchPolicy(host, other.id, other.model)).effective.warm)
      warming.push(other)
  const withinMaxWarm = warming
    .toSorted((a, b) => b.realRequestAt - a.realRequestAt)
    .slice(0, maxWarm)
    .includes(run)
  const usage = await host.harness().snapshot(ContextUsageDoc, run.id, context)
  const situation: Situation = {
    now,
    ttl: run.ttl,
    delayBeforeRefresh: run.delayBeforeRefresh,
    realRequestAt: run.realRequestAt,
    lastCacheRequestAt: run.lastCacheRequestAt,
    runActive: Boolean((await host.harness().snapshot(LiveDoc, run.id, context))?.run),
    withinMaxWarm,
    tokens: usage?.tokens ?? 0,
    compactedSinceRequest: (doc.compaction?.at ?? 0) >= run.realRequestAt,
  }
  return { situation, policy: effective }
}

function stop(runs: Runs, run: Run, reason: string) {
  if (runs.active.get(run.id) !== run) return
  runs.active.delete(run.id)
  run.cancel?.()
  run.controller.abort()
  runs.stopped.set(run.id, reason)
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

async function commitPing(
  host: ExtensionHost,
  id: ConversationId,
  ping: Ping,
  answer?: AssistantMessage,
) {
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, id)
    doc.last = ping
    if (answer) await host.need(ConversationsApi).accountResponse(tx, id, receipt(answer))
  }, context)
}

async function pingRequest(host: ExtensionHost, run: Run) {
  const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(PING_TIMEOUT_MS)])
  if (run.payload !== undefined) {
    const replayed = run.payload
    return host.modelRuntime
      .streamSimple(
        run.model,
        { messages: [] },
        {
          ...getCacheWarmingRequestOptions({}, signal),
          onPayload: () => replayed,
        },
      )
      .result()
  }
  const { messages, agent } = await nextRequestMessages(host, run.id)
  messages.push({ role: 'user', content: PING_QUESTION, timestamp: Date.now() })
  return host.modelRuntime
    .streamSimple(
      run.model,
      { messages },
      {
        ...(agent.thinkingLevel === 'off' ? {} : { reasoning: agent.thinkingLevel }),
        maxRetries: 0,
        signal,
      },
    )
    .result()
}

async function sendPing(host: ExtensionHost, runs: Runs, run: Run) {
  const at = Date.now()
  const attempt: Ping = {
    at,
    provider: run.model.provider,
    model: run.model.id,
    error: 'interrupted',
  }
  await host.harness().commit(async (tx) => {
    const doc = await tx.doc(State, run.id)
    doc.last = attempt
    doc.pings = (doc.pings ?? 0) + 1
  }, context)
  let answer: AssistantMessage
  try {
    answer = await pingRequest(host, run)
  } catch (error) {
    if (run.controller.signal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    await commitPing(host, run.id, { ...attempt, error: message })
    stop(runs, run, `Ping failed: ${message}`)
    return
  }
  if (run.controller.signal.aborted) return
  if (answer.stopReason === 'error' || answer.stopReason === 'aborted') {
    const message = answer.errorMessage ?? answer.stopReason
    await commitPing(host, run.id, { ...attempt, error: message }, answer)
    stop(runs, run, `Ping failed: ${message}`)
    return
  }
  const { cacheRead, cacheWrite } = answer.usage
  await commitPing(
    host,
    run.id,
    { at, provider: attempt.provider, model: attempt.model, read: cacheRead, write: cacheWrite },
    answer,
  )
  if (runs.active.get(run.id) !== run) return
  run.lastCacheRequestAt = at
  schedule(host, runs, run)
}

async function startCompaction(host: ExtensionHost, runs: Runs, run: Run, tokens: number) {
  stop(runs, run, 'Compacted before it went cold')
  await host.harness().commit(async (tx) => {
    if ((await tx.doc(LiveDoc, run.id)).run || (await compacting(tx, run.id))) return
    const task = await admitCompaction(tx, run.id)
    const doc = await tx.doc(State, run.id)
    doc.compaction = { at: Date.now(), task, tokens }
  }, context)
}

async function refresh(host: ExtensionHost, runs: Runs, run: Run) {
  run.cancel = undefined
  if (runs.active.get(run.id) !== run) return
  if (host.want(PauseApi)?.paused()) return stop(runs, run, 'Ultimate is paused')
  if (
    !isOpenCoordinator(host, run.id) ||
    (await host.need(ConversationsApi).concluded(context)).has(run.id)
  )
    return stop(runs, run, 'Not an open branch')
  const model = (await agentOf(host, run.id))?.model
  if (model?.provider !== run.model.provider || model.modelId !== run.model.id)
    return stop(runs, run, 'Model changed')
  const { situation, policy } = await situationOf(host, runs, run, Date.now())
  if (runs.active.get(run.id) !== run) return
  const step = decide(situation, policy)
  if (step === 'ping') return sendPing(host, runs, run)
  if (step === 'compact') return startCompaction(host, runs, run, situation.tokens)
  stop(runs, run, step.stop)
}

function schedule(host: ExtensionHost, runs: Runs, run: Run) {
  run.cancel?.()
  run.nextAt = run.lastCacheRequestAt + run.delayBeforeRefresh
  run.cancel = deadline(
    run.nextAt - Date.now(),
    () =>
      inProcess(
        "a branch's warming lives with the process; its next request starts it again",
        refresh(host, runs, run).catch((error: unknown) => {
          stop(runs, run, String(error))
          host.notice(`Branch cache: ${String(error)}`)
        }),
      ),
    { unref: true },
  )
}

async function start(
  host: ExtensionHost,
  runs: Runs,
  id: ConversationId,
  answer: AssistantMessage,
  facet: { closed: boolean },
) {
  const sent = runs.sent.get(id)
  runs.sent.delete(id)
  const previous = runs.active.get(id)
  if (previous) stop(runs, previous, 'Context changed')
  runs.stopped.delete(id)
  const model = sent
    ? sent.model
    : answer.provider === 'claude-code'
      ? host.modelRuntime.getModel(answer.provider, answer.model)
      : undefined
  if (!model) {
    runs.stopped.set(id, 'Waiting for the next request')
    return
  }
  const timing = cacheTiming(model)
  if (!timing) {
    runs.stopped.set(id, 'Model has no known cache lifetime')
    return
  }
  const thinking = (await agentOf(host, id))?.thinkingLevel
  if (facet.closed) return
  const reasoning = thinking === undefined || thinking === 'off' ? undefined : thinking
  if (sent && !isCacheWarmingReplayable(model, { reasoning })) {
    runs.stopped.set(id, 'Requests cannot be re-sent unchanged (budget-based thinking)')
    return
  }
  const replay = sent && oneTokenPayload(model.api, sent.payload)
  if (sent && !replay) {
    runs.stopped.set(id, `Cannot cap a re-sent ${model.api} request at one token`)
    return
  }
  const at = sent?.at ?? answer.timestamp
  const run: Run = {
    id,
    model,
    ...(replay ? { payload: replay } : {}),
    ...timing,
    realRequestAt: at,
    lastCacheRequestAt: at,
    nextAt: at + timing.delayBeforeRefresh,
    controller: new AbortController(),
  }
  runs.active.set(id, run)
  schedule(host, runs, run)
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

async function nextRequestMessages(host: ExtensionHost, id: ConversationId) {
  const conversation = (await host.harness().conversation(id, context))!
  let messages: Message[] = [...(await conversation.context(context)).messages]
  const leadingConversationIdentity = `You are conversation #${id}.`
  if (
    !messages.some(
      (message) => message.role === 'user' && message.content === leadingConversationIdentity,
    )
  ) {
    const place = messages[0]?.role === 'system' ? 1 : 0
    messages = [
      ...messages.slice(0, place),
      { role: 'user', content: leadingConversationIdentity, timestamp: 0 },
      ...messages.slice(place),
    ]
  }
  return { messages, agent: await conversation.agent(context) }
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

async function state(
  host: ExtensionHost,
  runs: Runs,
  id: ConversationId,
): Promise<BranchCacheState> {
  const doc = await readDoc(host, id)
  const usage = await host.harness().snapshot(ContextUsageDoc, id, context)
  const agent = await agentOf(host, id)
  const model =
    agent?.model && host.modelRuntime.getModel(agent.model.provider, agent.model.modelId)
  const run = runs.active.get(id)
  const base = {
    tokens: usage?.tokens ?? 0,
    pings: doc.pings ?? 0,
    ...(doc.last ? { last: doc.last } : {}),
    ...(doc.compaction ? { compaction: doc.compaction } : {}),
  }
  const branchSwitch = (value: boolean | undefined, policyValue: Setting<boolean>) =>
    value === undefined ? policyValue : { value, source: 'branch' as const }
  if (!model)
    return {
      ...base,
      warm: branchSwitch(doc.warm, { value: DEFAULTS.warm, source: 'default' }),
      compact: branchSwitch(doc.compact, { value: DEFAULTS.compact, source: 'default' }),
      idle: 'No model',
    }
  const { policy } = await branchPolicy(host, id, model)
  const timing = cacheTiming(model)
  const reasoning = agent.thinkingLevel === 'off' ? undefined : agent.thinkingLevel
  const described: BranchCacheState = {
    ...base,
    warm: branchSwitch(doc.warm, policy.warm),
    compact: branchSwitch(doc.compact, policy.compact),
    provider: model.provider,
    model: model.id,
    ...(timing ? { ttl: timing.ttl, pingAfter: timing.delayBeforeRefresh } : {}),
    replayable: isCacheWarmingReplayable(model, { reasoning }),
    policy,
  }
  if (!run) return { ...described, idle: runs.stopped.get(id) ?? 'Waiting for the next request' }
  const { situation, policy: effective } = await situationOf(host, runs, run, run.nextAt)
  const step = decide(situation, effective)
  const live = {
    ...described,
    lastAt: run.lastCacheRequestAt,
    running: situation.runActive,
  }
  return typeof step === 'string'
    ? { ...live, next: { at: run.nextAt, step } }
    : { ...live, idle: step.stop }
}

export default function branchCache(host: ExtensionHost) {
  host.need(ConversationsApi)
  host.want(PauseApi)
  const runs = runsOf(host)
  const facet = { closed: false }
  const stopAll = (reason: string) => {
    for (const run of runs.active.values()) stop(runs, run, reason)
    runs.sent.clear()
  }
  host.onRelease(async () => stopAll('Ultimate restarted'))
  host.onClose(async () => {
    facet.closed = true
    stopAll('Branch cache reloaded')
  })
  return defineExtension({
    name: 'branch-cache',
    hooks: [
      hook(GenerationTask, {
        beforeProviderRequest: ({ model, payload }, api) => {
          const now = Date.now()
          for (const [id, sent] of runs.sent)
            if (now - sent.at > CACHE_WARMING_MAX_AGE_MS) runs.sent.delete(id)
          if (isOpenCoordinator(host, api.conversationId))
            runs.sent.set(api.conversationId, { model, payload, at: now })
          return undefined
        },
        afterResponse: async (message, api) => {
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            runs.sent.delete(api.conversationId)
            return
          }
          if (isOpenCoordinator(host, api.conversationId))
            await start(host, runs, api.conversationId, message, facet)
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (_compaction, api, ctx) => {
          runs.sent.delete(api.conversationId)
          const run = runs.active.get(api.conversationId)
          if (run) stop(runs, run, 'Compacted')
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

const runsOf = (host: ExtensionHost) =>
  host.resource<Runs>('branch-cache.runs', () => ({
    sent: new Map(),
    active: new Map(),
    stopped: new Map(),
  }))

function conversationArg(args: unknown) {
  const id = (args as { id?: unknown } | null)?.id
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1)
    throw new Error('Expected { id: conversation }')
  return parseConversationId(id)
}

const countOrNull = (value: unknown, name: string) => {
  if (value === undefined || value === null) return value
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be a number of at least 0, or null`)
  return value
}

export const actions = {
  state: implementAction(StateAction, (args, { host }) =>
    state(host, runsOf(host), conversationArg(args)),
  ),
  set: implementAction(SetAction, async (args, { host }) => {
    const id = conversationArg(args)
    const { warm, compact } = args as { warm?: unknown; compact?: unknown }
    if (warm !== undefined && typeof warm !== 'boolean') throw new Error('warm must be a boolean')
    if (compact !== undefined && typeof compact !== 'boolean')
      throw new Error('compact must be a boolean')
    if (!isOpenCoordinator(host, id)) throw new Error(`#${id} is not a branch coordinator`)
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, id)
      if (warm !== undefined) doc.warm = warm
      if (compact !== undefined) doc.compact = compact
    }, context)
    return state(host, runsOf(host), id)
  }),
  'set-model': implementAction(SetModelAction, async (args, { host }) => {
    const { provider, model, ...values } = (args ?? {}) as {
      provider?: unknown
      model?: unknown
      warmMinutes?: unknown
      minCompactTokens?: unknown
    }
    if (typeof provider !== 'string' || typeof model !== 'string' || !provider || !model)
      throw new Error('Expected { provider, model, warmMinutes?, minCompactTokens? }')
    const warmMinutes = countOrNull(values.warmMinutes, 'warmMinutes')
    const minCompactTokens = countOrNull(values.minCompactTokens, 'minCompactTokens')
    await updateSettings(userSettingsPath(host.userHome), (settings) =>
      writeModelPolicy(settings, `${provider}/${model}`, {
        ...(warmMinutes === undefined ? {} : { warmMinutes }),
        ...(minCompactTokens === undefined ? {} : { minCompactTokens }),
      }),
    )
    return null
  }),
}
export const userActions = ['set', 'set-model']
