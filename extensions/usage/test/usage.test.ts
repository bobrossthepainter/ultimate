import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { UsageDoc } from '@earendil-works/pi-durable'
import type { ConversationId, EntryId, Tx } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import usage, { actions, spokeReport } from '../server.ts'
import { createCallLog, merge } from '../aggregate.ts'
import type { Started } from '../aggregate.ts'
import type { Report } from '../refs.ts'
import type { ExtensionHost } from '../../../server/extensions.ts'
import { prepareHarness } from '../../../server/harness.ts'
import { openers, temp } from '../../../test/helpers.ts'

const HOUR = 3600_000
const START = Date.UTC(2026, 10, 10, 12)

function call(
  at: number,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
  model = 'opus',
): AssistantMessage {
  const message = fauxAssistantMessage([fauxText('ok')])
  return {
    ...message,
    provider: 'claude-code',
    model,
    timestamp: at,
    usage: {
      ...message.usage,
      ...tokens,
      cacheWrite1h: tokens.cacheWrite,
      cost: {
        input: tokens.input / 1e6,
        output: tokens.output / 1e6,
        cacheRead: tokens.cacheRead / 1e6,
        cacheWrite: tokens.cacheWrite / 1e6,
        total: (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite) / 1e6,
        totalFromProvider: false,
      },
    },
  }
}

async function append(tx: Tx, id: ConversationId, messages: AssistantMessage[], toolCost = 0) {
  const models: Record<string, AssistantMessage['usage']> = {}
  for (const message of messages) {
    await tx.appendEntry(id, { kind: 'pi.assistant', model: [message] })
    const into = (models[`${message.provider}/${message.model}`] ??= {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    })
    into.input += message.usage.input
    into.output += message.usage.output
    into.cacheRead += message.usage.cacheRead
    into.cacheWrite += message.usage.cacheWrite
    into.cost.input += message.usage.cost.input
    into.cost.output += message.usage.cost.output
    into.cost.cacheRead += message.usage.cost.cacheRead
    into.cost.cacheWrite += message.usage.cost.cacheWrite
    into.cost.total += message.usage.cost.total
  }
  const state = await tx.doc(UsageDoc, id)
  for (const [key, value] of Object.entries(models)) {
    const before = state.models[key]
    state.models[key] = before
      ? {
          ...value,
          input: before.input + value.input,
          output: before.output + value.output,
          cacheRead: before.cacheRead + value.cacheRead,
          cacheWrite: before.cacheWrite + value.cacheWrite,
          cost: {
            input: before.cost.input + value.cost.input,
            output: before.cost.output + value.cost.output,
            cacheRead: before.cost.cacheRead + value.cost.cacheRead,
            cacheWrite: before.cost.cacheWrite + value.cost.cacheWrite,
            total: before.cost.total + value.cost.total,
          },
        }
      : value
  }
  if (toolCost)
    state.tools.bash = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: toolCost },
    }
}

async function fixture() {
  const prepared = await prepareHarness({
    ultimateRoot: await temp(),
    userHome: await temp(),
    home: await temp(),
    faux: fauxProvider(),
  })
  const opened = await prepared.open()
  const lifecycle = openers()
  let close!: () => Promise<void>
  const started = new Map<number, Started & { id: number }>()
  const summaries: { id: ConversationId; title?: string; parentConversationId?: ConversationId }[] =
    []
  const notices: string[] = []
  const host = {
    harness: () => opened.harness,
    onOpen: lifecycle.onOpen,
    onClose: (callback: () => Promise<void>) => {
      close = callback
    },
    notice: (value: string) => notices.push(value),
    conversations: () => summaries,
    eventLog: {
      recent: async () =>
        [...started.values()].map((data, index) => ({ id: index as EntryId, data })),
    },
    modelRuntime: { isUsingSubscription: (provider: string) => provider === 'claude-code' },
    projects: async () => [{ name: 'my-app', current: true }],
    userHome: await temp(),
  }
  usage(host as unknown as Parameters<typeof usage>[0])
  const report = (args: { since?: number; until?: number } = {}) =>
    actions.report(args, { host: host as unknown as ExtensionHost })
  return {
    ...opened,
    started,
    summaries,
    notices,
    open: lifecycle.open,
    report,
    async cleanup() {
      await lifecycle.close()
      await close()
      await opened.close()
    },
  }
}

describe('usage report', () => {
  it('splits cost by kind, role, model, branch and day, and finds rebuilds with their cause', async () => {
    const f = await fixture()
    try {
      const ids = await f.harness.commit(async (tx) => {
        const primary = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        const branch = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        const worker = await tx.createConversation({ ownership: { kind: 'ownerless' } })
        await append(tx, primary.id, [
          call(START, { input: 10, output: 100, cacheRead: 0, cacheWrite: 100_000 }),
          call(START + 2 * HOUR, { input: 10, output: 100, cacheRead: 0, cacheWrite: 110_000 }),
        ])
        await append(tx, branch.id, [
          call(START, { input: 10, output: 200, cacheRead: 0, cacheWrite: 50_000 }),
          call(START + 60_000, { input: 10, output: 200, cacheRead: 50_000, cacheWrite: 1000 }),
        ])
        await append(
          tx,
          worker.id,
          [
            call(
              START + 25 * HOUR,
              { input: 10, output: 300, cacheRead: 0, cacheWrite: 20_000 },
              'sonnet',
            ),
          ],
          0.5,
        )
        return { primary: primary.id, branch: branch.id, worker: worker.id }
      }, context)
      f.started.set(ids.primary, { id: ids.primary, agent: 'ultimate', kind: 'standing' })
      f.started.set(ids.branch, {
        id: ids.branch,
        agent: 'branch',
        kind: 'branch',
        parent: 1 as ConversationId,
      })
      f.started.set(ids.worker, {
        id: ids.worker,
        agent: 'worker',
        kind: 'child',
        parent: ids.branch,
      })
      f.summaries.push({ id: ids.branch, title: 'Fix login' })
      await f.open()
      const all = await f.report()
      expect(all.total.calls).toBe(5)
      expect(all.total.tokens.cacheWrite).toBe(281_000)
      expect(Object.keys(all.byRole).toSorted()).toEqual(['@ultimate', 'coordinator', 'worker'])
      expect(all.byModel['claude-code/opus']).toMatchObject({ calls: 4, subscription: true })
      expect(all.rebuilds.count).toBe(1)
      expect(all.rebuilds.byCause.expired).toEqual({ count: 1, cost: 110_010 / 1e6 })
      expect(all.byRole['@ultimate'].rebuilds).toBe(1)
      const branch = all.branches.find((item) => item.id === ids.branch)!
      expect(branch.title).toBe('Fix login')
      expect(branch.total.calls).toBe(3)
      expect(Object.keys(branch.roles).toSorted()).toEqual(['coordinator', 'worker'])
      expect(all.daily.map((day) => day.calls)).toEqual([4, 1])
      expect(all.undated.cost).toBeCloseTo(0.5)

      const firstDay = await f.report({ until: START + 24 * HOUR })
      expect(firstDay.total.calls).toBe(4)

      await f.harness.commit(
        (tx) =>
          append(tx, ids.branch, [
            call(START + 26 * HOUR, { input: 10, output: 10, cacheRead: 0, cacheWrite: 60_000 }),
          ]),
        context,
      )
      const later = await f.report()
      expect(later.total.calls).toBe(6)
      expect(later.rebuilds.count).toBe(2)
      expect(later.branches.find((item) => item.id === ids.branch)).toMatchObject({
        rebuilds: 1,
        rebuildCost: 60_010 / 1e6,
      })
      expect(f.notices).toEqual([])
    } finally {
      await f.cleanup()
    }
  })
})

describe('call log', () => {
  it('keeps a failed zero-token response from hiding the rebuild after it, when calls arrive one by one', () => {
    const id = 7 as ConversationId
    const entry = (n: number, message: AssistantMessage) =>
      ({ id: n as EntryId, conversationId: id, kind: 'pi.assistant', model: [message] }) as const
    const log = createCallLog()
    log.add(id, [
      entry(1, call(START, { input: 10, output: 10, cacheRead: 0, cacheWrite: 80_000 })),
    ])
    log.add(id, [
      entry(2, call(START + 60_000, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
    ])
    log.add(id, [
      entry(3, call(START + 2 * HOUR, { input: 10, output: 10, cacheRead: 0, cacheWrite: 80_000 })),
    ])
    expect(log.calls.map((item) => item.rebuild?.cause)).toEqual([undefined, undefined, 'expired'])
  })
})

describe('spokes', () => {
  const target = {
    url: 'http://127.0.0.1:1',
    label: 'my-app on laptop',
    name: 'my-app',
    machine: 'laptop',
  }
  const bucket = (cost: number) => ({
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  })

  it('falls back to pi.usage totals when the spoke has no usage extension', async () => {
    const asked: string[] = []
    const report = await spokeReport(target, {}, async (_target, extension, action, args) => {
      asked.push(`${extension}/${action}`)
      if (extension === 'usage') throw new Error('my-app on laptop: Unknown extension action')
      const { op, args: readArgs } = args as { op: string; args: unknown[] }
      if (op === 'conversations') return [{ id: 1 }, { id: 2 }]
      return {
        models: { 'openai/gpt': bucket(readArgs[1] === 1 ? 1 : 2) },
        tools: readArgs[1] === 2 ? { web_search: bucket(0.25) } : {},
      }
    })
    expect(report.fallback).toBe(true)
    expect(report.instance).toEqual({ project: 'my-app', machine: 'laptop' })
    expect(report.byModel['openai/gpt'].cost.input).toBe(3)
    expect(report.total.tokens.cacheWrite).toBe(8)
    expect(report.undated).toEqual({ cost: 0.25, tokens: 10 })
    expect(asked[0]).toBe('usage/report')
  })

  it('passes any other failure on, so an unreachable spoke never reads as $0', async () => {
    await expect(
      spokeReport(target, {}, () => Promise.reject(new Error('my-app on laptop did not answer'))),
    ).rejects.toThrow('did not answer')
  })

  it('merges instances, naming each branch by its instance', () => {
    const one = (project: string, cost: number): Report => ({
      instance: { project, machine: 'm' },
      generatedAt: 0,
      total: {
        calls: 1,
        cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0 },
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      daily: [
        {
          day: '2026-11-10',
          calls: 1,
          cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      byRole: {},
      byModel: {},
      branches: [
        {
          id: 5 as ConversationId,
          title: 'Fix',
          total: {
            calls: 1,
            cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0 },
            tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          roles: {},
          rebuilds: 0,
          rebuildCost: 0,
        },
      ],
      rebuilds: { count: 1, cost: cost / 2, byCause: { expired: { count: 1, cost: cost / 2 } } },
      undated: { cost: 0, tokens: 0 },
    })
    const merged = merge([one('a', 1), one('b', 3)], { project: 'all', machine: 'm' })
    expect(merged.total.cost.input).toBe(4)
    expect(merged.daily).toEqual([
      { day: '2026-11-10', calls: 2, cost: { input: 4, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ])
    expect(merged.branches.map((branch) => branch.title)).toEqual(['b · Fix', 'a · Fix'])
    expect(merged.rebuilds.byCause.expired).toEqual({ count: 2, cost: 2 })
  })
})
