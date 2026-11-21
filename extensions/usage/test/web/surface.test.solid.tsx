/** @jsxImportSource @solidjs/web */
import { createAgent } from '@ui-sdk/solid/agent'
import { settle } from '@ui-sdk/core/testing'
import { flush } from 'solid-js'
import { expect, it, vi } from 'vitest'
import { ExtensionName } from '@/sdk/solid'
import { parseConversationId } from '../../../../lib/ids.ts'
import { expectDistinctAgentNames } from '../../../../test/web/agent-names.ts'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { store } from '../../../../web/src/sdk/client.ts'
import type { Report } from '../../refs.ts'
import usage from '../../web.solid.tsx'

const kinds = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
const report: Report = {
  instance: { project: 'my-app', machine: 'example' },
  generatedAt: 0,
  total: { calls: 3, cost: kinds, tokens: kinds },
  daily: [{ day: '2026-11-20', cost: kinds, calls: 3 }],
  byRole: { worker: { calls: 3, cost: kinds, tokens: kinds, rebuilds: 0, rebuildCost: 0 } },
  byModel: { 'claude/opus': { calls: 3, cost: kinds, tokens: kinds, subscription: true } },
  branches: [
    {
      id: parseConversationId(7),
      title: 'Fix the parser',
      total: { calls: 3, cost: kinds, tokens: kinds },
      roles: { worker: 10 },
      rebuilds: 0,
      rebuildCost: 0,
    },
  ],
  rebuilds: { count: 0, cost: 0, byCause: {} },
  undated: { cost: 0, tokens: 0 },
}

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  reports: [] as { since?: number; until?: number }[],
  report: undefined as unknown,
}))

vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const { createRegistry } = await import('../../../../web/src/sdk/registry.ts')
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = input as string
    if (path === '/api/ui') return Response.json({ ok: true, rev: 1 })
    if (path === '/api/extensions/usage/actions/spokes')
      return Response.json({ result: { spokes: [], errors: [] } })
    if (path === '/api/extensions/usage/actions/report') {
      harness.reports.push((JSON.parse(init!.body as string) as { args: Report }).args)
      return Response.json({ result: harness.report })
    }
    return harness.server?.handle(path, init) ?? Response.json({ ok: true })
  }
  const { answerReadsWith } = await import('../../../../test/web/fake-source.ts')
  const pageFetch = answerReadsWith(fetch)
  const clientStore = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: pageFetch,
  })
  const api = createApi(clientStore, { fetch: pageFetch })
  return {
    store: clientStore,
    api,
    reads: createReads(api, clientStore),
    registry: createRegistry(),
    uiState: createUiState(api.updateUi),
  }
})

vi.mock('@/sdk/solid', async (original) => ({
  ...(await original<typeof import('@/sdk/solid')>()),
  Header: () => null,
  StatusLine: () => null,
}))

const agent = createAgent({ allow: (step) => !step.confirm })
harness.server = fakeSubscriptions(harness.sources)
harness.report = report

it('shows the report and asks for the picked frame', async ({ onTestFinished }) => {
  store.start()
  onTestFinished(() => store.stop())
  harness.sources[0].open()
  const Surface = usage.surfaces![0].component
  const container = renderSolid(() => (
    <ExtensionName value="usage">
      <Surface />
    </ExtensionName>
  ))
  await settle()
  flush()
  expect(container.querySelector('[data-usage-total]')?.textContent).toBe('≈$10.00')
  expect(container.textContent).toContain('Fix the parser')
  await expectDistinctAgentNames(agent)

  const pick = async (frame: string) => {
    const range = agent.snapshot().find((entry) => !entry.offPage && entry.label === 'Range')!
    const done = await agent.act({ steps: [{ ref: range.ref, action: 'setValue', args: [frame] }] })
    expect(done.ok).toBe(true)
    await settle()
    flush()
  }
  await pick('today')
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  expect(harness.reports.at(-1)).toEqual({ since: midnight.getTime() })

  await pick('custom')
  const field = (label: string) =>
    agent.snapshot().find((entry) => !entry.offPage && entry.label === label)!
  const set = await agent.act({
    steps: [
      { ref: field('From').ref, action: 'setValue', args: ['2026-11-03'] },
      { ref: field('To').ref, action: 'setValue', args: ['2026-11-05'] },
    ],
  })
  expect(set.ok).toBe(true)
  await settle()
  flush()
  await expectDistinctAgentNames(agent)
  const { since, until } = harness.reports.at(-1)!
  expect(new Date(since!)).toEqual(new Date(2026, 10, 3))
  expect(new Date(until!)).toEqual(new Date(2026, 10, 6))
})
