import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { copyJson } from '@earendil-works/chord/json'
import {
  CompactionTask,
  defineDoc,
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from '@earendil-works/pi-durable'
import type { ConversationId, Cursor, JsonObject, TaskId } from '@earendil-works/pi-durable'
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
import { UserInputEvent } from '../../shared/events.ts'
import { discoverAgents } from '../../lib/agents.ts'
import { implementAction } from '../../lib/actions.ts'
import { admitCompaction, compacting } from '../../lib/compaction.ts'
import { inProcess, rebuiltOnOpen } from '../../lib/errors.ts'
import { parseConversationId } from '../../lib/ids.ts'
import { readSettings, userSettingsPath } from '../../lib/settings.ts'
import { deadline } from '../../lib/timers.ts'
import type { Cancel } from '../../lib/timers.ts'
import { ContextUsageDoc, ConversationsApi } from '../conversations/api.ts'
import type { ResponseReceipt } from '../conversations/summary.ts'
import { PauseApi } from '../pause/api.ts'
import { Profile, Standing } from '../subagents/api.ts'
import { decide, lateRefreshCutoff, policyOf, resolvePolicy } from './due.ts'
import type { Situation } from './due.ts'
import { CacheWarmingDoc, SetAction, StateAction } from './refs.ts'
import type { CacheWarmingDocState, CacheWarmingState, Compaction, Ping } from './refs.ts'

const State = defineDoc<CacheWarmingDocState>({
  kind: CacheWarmingDoc.kind,
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
const DEFAULT_MAX_WARM = 5
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

type Kind = 'standing' | 'coordinator'

export const kindOf = (summary: ConversationSummary): Kind | undefined =>
  summary.ownerTaskId !== undefined
    ? undefined
    : summary.label === 'coordinator'
      ? 'coordinator'
      : summary.label === 'agent'
        ? 'standing'
        : undefined

const warmedKind = (host: ExtensionHost, id: ConversationId) => {
  const summary = host.conversations().find((candidate) => candidate.id === id)
  return summary && kindOf(summary)
}

export function oneTokenPayload(api: Api, payload: unknown) {
  const field = OUTPUT_CAP_FIELD[api]
  if (!field || !payload || typeof payload !== 'object' || !(field in payload)) return undefined
  return { ...(payload as JsonObject), [field]: 1 }
}

export function cacheTiming(model: Model<Api>) {
  const ttl =
    model.provider === 'claude-code' ? CLAUDE_CODE_TTL_MS : getPromptCacheTtlMs(model, undefined)
  const delayBeforeRefresh = ttl === undefined ? undefined : getCacheWarmingDelayMs(ttl)
  return ttl === undefined || delayBeforeRefresh === undefined
    ? undefined
    : { ttl, delayBeforeRefresh }
}

const readDoc = async (host: ExtensionHost, id: ConversationId) =>
  (await host.harness().snapshot(State, id, context)) ?? {}

async function maxWarmBranches(host: ExtensionHost) {
  const user = await readSettings(userSettingsPath(host.userHome)).catch((error: unknown) => {
    host.notice(`Cache warming: ${String(error)}`)
    return {}
  })
  const project = await host.projectSettings()
  const of = (settings: JsonObject) => {
    const section = settings.cacheWarming
    return section && typeof section === 'object' && !Array.isArray(section)
      ? section.maxWarm
      : undefined
  }
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  return [of(project), of(user)].find(isCount) ?? DEFAULT_MAX_WARM
}

type Definitions = Awaited<ReturnType<typeof discoverAgents>>['definitions']

const discover = async (host: ExtensionHost) =>
  (await discoverAgents(host.ultimateRoot, host.projectRoot, host.userHome, host.modelRuntime))
    .definitions

async function policyFor(
  host: ExtensionHost,
  id: ConversationId,
  ttl: number | undefined,
  definitions: Definitions,
) {
  const kind = warmedKind(host, id)
  const profile = await host.harness().snapshot(Profile, id, context)
  const name = profile?.definition ?? (kind === 'coordinator' ? 'coordinator' : undefined)
  const agent = name === undefined ? undefined : definitions.find((item) => item.name === name)
  const doc = await readDoc(host, id)
  const resolved = resolvePolicy(agent?.cache, doc, ttl)
  return { kind, agent, doc, resolved, effective: policyOf(resolved) }
}

async function agentOf(host: ExtensionHost, id: ConversationId) {
  const conversation = await host.harness().conversation(id, context)
  return conversation && (await conversation.agent(context))
}

async function situationOf(
  host: ExtensionHost,
  runs: Runs,
  run: Run,
  now: number,
  definitions: Definitions,
) {
  const { kind, doc, effective } = await policyFor(host, run.id, run.ttl, definitions)
  let withinMaxWarm = true
  if (kind === 'coordinator') {
    const concluded = await host.need(ConversationsApi).concluded(context)
    const warming: Run[] = []
    for (const other of runs.active.values()) {
      if (warmedKind(host, other.id) !== 'coordinator' || concluded.has(other.id)) continue
      if (
        other.id === run.id ||
        (await policyFor(host, other.id, other.ttl, definitions)).effective.warm
      )
        warming.push(other)
    }
    withinMaxWarm = warming
      .toSorted((a, b) => b.realRequestAt - a.realRequestAt)
      .slice(0, await maxWarmBranches(host))
      .includes(run)
  }
  const usage = await host.harness().snapshot(ContextUsageDoc, run.id, context)
  const fromInput = kind === 'standing'
  const situation: Situation = {
    now,
    ttl: run.ttl,
    delayBeforeRefresh: run.delayBeforeRefresh,
    realRequestAt: run.realRequestAt,
    lastCacheRequestAt: run.lastCacheRequestAt,
    from: fromInput ? 'input' : 'request',
    windowStart: fromInput ? doc.inputAt : run.realRequestAt,
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
  if (cacheRead + cacheWrite === 0) return stop(runs, run, 'Ping found no cache')
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
    !warmedKind(host, run.id) ||
    (await host.need(ConversationsApi).concluded(context)).has(run.id)
  )
    return stop(runs, run, 'Not a standing agent or an open branch')
  const model = (await agentOf(host, run.id))?.model
  if (model?.provider !== run.model.provider || model.modelId !== run.model.id)
    return stop(runs, run, 'Model changed')
  const { situation, policy } = await situationOf(host, runs, run, Date.now(), await discover(host))
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
        "a conversation's warming lives with the process; its next request starts it again",
        refresh(host, runs, run).catch((error: unknown) => {
          stop(runs, run, String(error))
          host.notice(`Cache warming: ${String(error)}`)
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
  if (answer.usage.cacheRead + answer.usage.cacheWrite === 0) {
    runs.stopped.set(id, 'The last request used no cache')
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

export function recoverRun(
  newestFirst: { kind: string; message?: AssistantMessage }[],
  last: Ping | undefined,
  model: Pick<Model<Api>, 'provider' | 'id'>,
) {
  const latest = newestFirst.find(
    (entry) =>
      entry.kind === 'pi.compaction' ||
      entry.kind === 'pi.reset' ||
      entry.message?.role === 'assistant',
  )
  const answer = latest?.message
  const renewed =
    answer?.provider === model.provider &&
    answer.model === model.id &&
    answer.stopReason !== 'error' &&
    answer.stopReason !== 'aborted' &&
    answer.usage.cacheRead + answer.usage.cacheWrite > 0
  if (!answer || !renewed) return undefined
  if (!last || last.at < answer.timestamp)
    return { realRequestAt: answer.timestamp, lastCacheRequestAt: answer.timestamp }
  const pinged =
    last.error === undefined &&
    last.provider === model.provider &&
    last.model === model.id &&
    (last.read ?? 0) + (last.write ?? 0) > 0
  return pinged ? { realRequestAt: answer.timestamp, lastCacheRequestAt: last.at } : undefined
}

async function newestEntries(host: ExtensionHost, id: ConversationId, ttl: number) {
  const conversation = (await host.harness().conversation(id, context))!
  const found: { kind: string; message?: AssistantMessage }[] = []
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries({}, 100, cursor, context)
    for (const entry of page.items) {
      const message = entry.model?.[0]
      found.push({
        kind: entry.kind,
        ...(message?.role === 'assistant' ? { message } : {}),
      })
      if (entry.kind === 'pi.compaction' || entry.kind === 'pi.reset') return found
      if (message?.role === 'assistant') return found
      if (message && Date.now() - message.timestamp > ttl) return found
    }
    cursor = page.next
  } while (cursor)
  return found
}

async function warmedConversations(host: ExtensionHost) {
  const records = await host.harness().commit(async (tx) => {
    const scanned = []
    let cursor: Cursor | undefined
    do {
      const page = await tx.scanConversations({}, 256, cursor)
      scanned.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    return scanned
  }, context)
  const ids: ConversationId[] = []
  for (const record of records) {
    if (record.owner) continue
    const label = (await host.harness().snapshot(host.metadata, record.id, context))?.label
    if (label === 'coordinator' || label === 'agent') ids.push(record.id)
  }
  return ids
}

async function resume(host: ExtensionHost, runs: Runs, facet: { closed: boolean }) {
  const concluded = await host.need(ConversationsApi).concluded(context)
  for (const id of await warmedConversations(host)) {
    if (concluded.has(id) || runs.active.has(id)) continue
    const ref = (await agentOf(host, id))?.model
    if (ref?.provider !== 'claude-code') continue
    const model = host.modelRuntime.getModel(ref.provider, ref.modelId)
    const timing = model && cacheTiming(model)
    if (!model || !timing) continue
    const recovered = recoverRun(
      await newestEntries(host, id, timing.ttl),
      (await readDoc(host, id)).last,
      model,
    )
    if (!recovered || facet.closed || runs.active.has(id)) continue
    const cutoff = lateRefreshCutoff({
      ...timing,
      lastCacheRequestAt: recovered.lastCacheRequestAt,
    })
    if (Date.now() > cutoff) continue
    const run: Run = {
      id,
      model,
      ...timing,
      ...recovered,
      nextAt: recovered.lastCacheRequestAt + timing.delayBeforeRefresh,
      controller: new AbortController(),
    }
    runs.active.set(id, run)
    schedule(host, runs, run)
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
): Promise<CacheWarmingState> {
  const usage = await host.harness().snapshot(ContextUsageDoc, id, context)
  const agent = await agentOf(host, id)
  const model =
    agent?.model && host.modelRuntime.getModel(agent.model.provider, agent.model.modelId)
  const timing = model && cacheTiming(model)
  const definitions = await discover(host)
  const {
    kind,
    agent: definition,
    doc,
    resolved,
  } = await policyFor(host, id, timing?.ttl, definitions)
  const run = runs.active.get(id)
  const open = kind && !(await host.need(ConversationsApi).concluded(context)).has(id)
  const base = {
    ...(open ? { kind } : {}),
    ...(definition ? { agent: definition.name } : {}),
    warm: resolved.warm,
    compact: resolved.compact,
    minutes: resolved.minutes,
    compactTokens: resolved.compactTokens,
    tokens: usage?.tokens ?? 0,
    pings: doc.pings ?? 0,
    ...(doc.inputAt === undefined ? {} : { inputAt: doc.inputAt }),
    ...(doc.last ? { last: doc.last } : {}),
    ...(doc.compaction ? { compaction: doc.compaction } : {}),
  }
  if (!open) return { ...base, idle: 'Not a standing agent or an open branch' }
  if (!model) return { ...base, idle: 'No model' }
  const reasoning = agent.thinkingLevel === 'off' ? undefined : agent.thinkingLevel
  const described: CacheWarmingState = {
    ...base,
    provider: model.provider,
    model: model.id,
    ...(timing ? { ttl: timing.ttl, pingAfter: timing.delayBeforeRefresh } : {}),
    replayable: isCacheWarmingReplayable(model, { reasoning }),
  }
  if (!run) return { ...described, idle: runs.stopped.get(id) ?? 'Waiting for the next request' }
  const { situation, policy: effective } = await situationOf(
    host,
    runs,
    run,
    run.nextAt,
    definitions,
  )
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

export default function cacheWarming(host: ExtensionHost) {
  host.need(ConversationsApi)
  host.want(PauseApi)
  const runs = runsOf(host)
  const facet = { closed: false }
  const stopAll = (reason: string) => {
    for (const run of runs.active.values()) stop(runs, run, reason)
    runs.sent.clear()
  }
  host.react(
    'user-input',
    [UserInputEvent],
    async (tx, { data, at }) => {
      const standing = Object.values(await tx.doc(Standing, ROOT_CONVERSATION_ID))
      if (!standing.includes(data.conversation)) return
      ;(await tx.doc(State, data.conversation)).inputAt = Date.parse(at)
    },
    { from: 'now' },
  )
  host.onOpen(async () => {
    rebuiltOnOpen(
      'warming runs are rebuilt from the stored answers and pings each time the extension opens',
      resume(host, runs, facet).catch((error: unknown) =>
        host.notice(`Cache warming: ${String(error)}`),
      ),
    )
  })
  host.onRelease(async () => stopAll('Ultimate restarted'))
  host.onClose(async () => {
    facet.closed = true
    stopAll('Cache warming reloaded')
  })
  return defineExtension({
    name: 'cache-warming',
    hooks: [
      hook(GenerationTask, {
        beforeProviderRequest: ({ model, payload }, api) => {
          const now = Date.now()
          for (const [id, sent] of runs.sent)
            if (now - sent.at > CACHE_WARMING_MAX_AGE_MS) runs.sent.delete(id)
          if (warmedKind(host, api.conversationId))
            runs.sent.set(api.conversationId, { model, payload, at: now })
          return undefined
        },
        afterResponse: async (message, api) => {
          if (message.stopReason === 'error' || message.stopReason === 'aborted') {
            runs.sent.delete(api.conversationId)
            return
          }
          if (warmedKind(host, api.conversationId))
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
          const kept = await api.memo<string>('cache-warming.summary', ctx)
          if (kept !== undefined) return { summary: kept }
          if ((await api.snapshot(LiveDoc, api.conversationId, ctx))?.run) return undefined
          const summary = await summaryFromCache(host, api.conversationId, api.taskId, (fresh) =>
            api.memo('cache-warming.summary', fresh, ctx),
          )
          return summary === undefined ? undefined : { summary }
        },
      }),
    ],
  })
}

const runsOf = (host: ExtensionHost) =>
  host.resource<Runs>('cache-warming.runs', () => ({
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

function override<T>(value: unknown, valid: (value: unknown) => value is T, message: string) {
  if (value === undefined || value === null || valid(value)) return value as T | null | undefined
  throw new Error(message)
}

const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

export const actions = {
  state: implementAction(StateAction, (args, { host }) =>
    state(host, runsOf(host), conversationArg(args)),
  ),
  set: implementAction(SetAction, async (args, { host }) => {
    const id = conversationArg(args)
    const values = args as { warm?: unknown; compact?: unknown; minutes?: unknown }
    const change = {
      warm: override(values.warm, isBoolean, 'warm must be a boolean or null'),
      compact: override(values.compact, isBoolean, 'compact must be a boolean or null'),
      minutes: override(values.minutes, isCount, 'minutes must be a number of at least 0, or null'),
    }
    if (!warmedKind(host, id) || (await host.need(ConversationsApi).concluded(context)).has(id))
      throw new Error(`#${id} is not a standing agent or an open branch`)
    await host.harness().commit(async (tx) => {
      const doc = await tx.doc(State, id)
      for (const key of ['warm', 'compact', 'minutes'] as const) {
        const value = change[key]
        if (value === null) delete doc[key]
        else if (value !== undefined) Object.assign(doc, { [key]: value })
      }
    }, context)
    return state(host, runsOf(host), id)
  }),
}
export const userActions = ['set']
