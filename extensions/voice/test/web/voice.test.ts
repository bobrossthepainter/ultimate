import { createElement } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { spliced } from '../../../../web/src/app/queued.ts'

const NO_LOGIN =
  'Voice through ChatGPT needs your subscription: log in to “OpenAI (ChatGPT Plus/Pro)” in the model picker'

const status = vi.hoisted(() => ({ data: undefined as unknown }))
vi.mock('@/sdk', () => ({
  api: {},
  cn: (...names: unknown[]) => names.filter(Boolean).join(' '),
  defineWebExtension: (facet: unknown) => facet,
  errorMessage: String,
  events: { emit: () => {} },
  insertIntoComposer: () => {},
  useAction: () => ({ data: status.data, loading: false, refetch: async () => undefined }),
  useConversation: () => ({ id: 7 }),
  useEvent: () => {},
  useEvents: () => [],
  useNow: () => 0,
  useSystem: () => undefined,
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: () => null,
}))

async function button(data: unknown) {
  status.data = data
  vi.stubGlobal('window', { isSecureContext: true })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => {} } })
  vi.stubGlobal('MediaRecorder', function MediaRecorder() {})
  const facet = (await import('../../web.tsx')).default as unknown as {
    slots: { 'composer.actions': ComponentType[] }
  }
  const html = renderToStaticMarkup(createElement(facet.slots['composer.actions'][0]))
  vi.unstubAllGlobals()
  return html
}

it('dims the mic and says why while no OpenAI key is set', async () => {
  const reason = 'Voice needs an OpenAI API key: add OPENAI_API_KEY in ⌘K → Secrets'
  const html = await button({ available: false, reason, secret: 'OPENAI_API_KEY' })
  expect(html).toContain('data-voice="blocked"')
  expect(html).toContain('aria-disabled="true"')
  expect(html).toContain(`aria-label="${reason}"`)
})

it('dims the mic and says to log in while voice-chatgpt has no subscription login', async () => {
  const html = await button({ available: false, reason: NO_LOGIN })
  expect(html).toContain('data-voice="blocked"')
  expect(html).toContain(`aria-label="${NO_LOGIN}"`)
})

it('offers the mic once a key is set', async () => {
  const html = await button({ available: true })
  expect(html).toContain('data-voice="idle"')
  expect(html).toContain('aria-label="Voice input"')
  expect(html).toContain('aria-disabled="false"')
})

it('spaces inserted words from their neighbours and puts the cursor after them', () => {
  expect(spliced('', 0, 0, 'Hello')).toEqual({ text: 'Hello', cursor: 5 })
  expect(spliced('Fix the', 7, 7, 'login bug')).toEqual({ text: 'Fix the login bug', cursor: 17 })
  expect(spliced('Fix bug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fixbug', 3, 3, 'the')).toEqual({ text: 'Fix the bug', cursor: 8 })
  expect(spliced('Fix  bug', 4, 4, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
  expect(spliced('Fix XXX bug', 4, 7, 'the')).toEqual({ text: 'Fix the bug', cursor: 7 })
})
