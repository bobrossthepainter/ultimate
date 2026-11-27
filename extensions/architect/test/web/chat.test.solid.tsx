import { flush } from 'solid-js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FakeSource, fakeSubscriptions } from '../../../../test/web/fake-source.ts'
import { renderSolid } from '../../../../test/web/solid-dom-setup.ts'
import { parseConversationId } from '../../../../lib/ids.ts'
import type { StreamedView } from '../../../../shared/protocol.ts'

const harness = vi.hoisted(() => ({
  sources: [] as FakeSource[],
  server: undefined as ReturnType<typeof fakeSubscriptions> | undefined,
  fetch: vi.fn<typeof fetch>(
    async (path, init): Promise<Response> =>
      harness.server?.handle(path as string, init) ?? Response.json({ result: null }),
  ),
}))
vi.mock('../../../../web/src/sdk/client.ts', async () => {
  const { createStore } = await import('../../../../web/src/sdk/store.ts')
  const { createApi } = await import('../../../../web/src/sdk/api.ts')
  const { createReads } = await import('../../../../web/src/sdk/reads.ts')
  const { createUiState } = await import('../../../../web/src/sdk/ui-state.ts')
  const store = createStore({
    eventSource: (url) => {
      const stream = new FakeSource(url)
      harness.sources.push(stream)
      return stream
    },
    fetch: harness.fetch,
  })
  const api = createApi(store, { fetch: harness.fetch })
  return { store, api, reads: createReads(api, store), uiState: createUiState(undefined) }
})
vi.mock('../../../../web/src/app/shell.solid.tsx', async (original) => {
  const { useConversation } = await import('../../../../web/src/sdk/hooks.ts')
  return {
    ...(await original<object>()),
    Conversation: () => {
      const conversation = useConversation()
      return (
        <output>
          {conversation().loading
            ? 'loading'
            : conversation().entries.map((entry) => JSON.stringify(entry.model))}
        </output>
      )
    },
  }
})

import { store } from '../../../../web/src/sdk/client.ts'
import { ChatPanel } from '../../chat.solid.tsx'

harness.server = fakeSubscriptions(harness.sources)
const tick = async () => {
  await vi.advanceTimersByTimeAsync(25)
  flush()
}

beforeEach(async () => {
  vi.useFakeTimers()
  harness.sources.length = 0
  harness.server!.subscriptions.length = 0
  store.show(undefined)
  store.start()
  harness.sources[0].open()
  await tick()
})
afterEach(() => {
  store.stop()
  vi.useRealTimers()
})

it("shows the chat conversation's answer, which is not the shown conversation", async () => {
  const branch = parseConversationId(5)
  const root = renderSolid(() => (
    <ChatPanel branch={branch} latest={1} onClose={() => {}} phone={false} />
  ))
  await tick()
  harness
    .server!.of(5, false)!
    .send('doc', { kind: 'architect.chat', value: { id: 7, version: 1 } })
  await tick()
  const chat = harness.server!.of(7, true)
  expect(chat).toBeDefined()
  chat!.send('view', {
    conversation: { id: 7 },
    entries: [
      {
        id: 70,
        conversationId: 7,
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: 'the answer' }],
      },
    ],
    docs: {},
  } as unknown as StreamedView)
  await tick()
  expect(root.querySelector('output')?.textContent).toContain('the answer')
})
