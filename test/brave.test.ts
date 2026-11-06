import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import brave from '../extensions/brave/server.ts'
import { braveRequest } from '../extensions/brave/client.ts'
import { writeSecret } from '../extensions/secrets/store.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0)) await close()
})
async function fixture(enabled = true) {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const notice = vi.fn<(message: string) => void>()
  const host = {
    userHome: root,
    notice,
    resource: <T>(_key: string, create: () => T) => create(),
    extensions: () => (enabled ? [{ name: 'secrets', enabled: true, server: {} }] : []),
  } as unknown as ExtensionHost
  const tool = brave(host).tools![0]
  const details = vi.fn<(value: unknown, context: unknown) => Promise<void>>(async () => {})
  const run = (args: unknown, signal?: AbortSignal) =>
    tool.execute(args as never, { details } as never, { abortSignal: signal } as never)
  return { root, run, details, notice }
}
/** A fake Brave API: `handler` gets the request path, its query and the subscription token. */
async function fake(
  handler: (
    path: string,
    query: URLSearchParams,
    key: string | undefined,
  ) => { status?: number; data?: unknown; raw?: string; hang?: boolean },
) {
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://fake')
    const result = handler(
      url.pathname,
      url.searchParams,
      request.headers['x-subscription-token'] as string | undefined,
    )
    if (result.hang) return
    response.writeHead(result.status ?? 200, {
      'content-type': 'application/json',
    })
    response.end(result.raw ?? JSON.stringify(result.data))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  vi.stubEnv('ULTIMATE_BRAVE_TEST_URL', `http://127.0.0.1:${address.port}`)
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
}
const context = {
  grounding: {
    generic: [
      {
        url: 'https://example.com/a',
        title: 'Example',
        snippets: ['first', 'second'],
      },
      { url: 'https://other.example/b', title: null, snippets: ['undated'] },
    ],
  },
  sources: {
    'https://example.com/a': {
      title: 'Example',
      hostname: 'example.com',
      age: ['Thursday, January 1, 2026', '2026-01-01', '300 days ago', '2026-01-01T10:00:00Z'],
    },
    'https://other.example/b': {
      title: null,
      hostname: 'other.example',
      age: [],
    },
  },
}
it('queries LLM Context with the stored key and returns details in the search card shape', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-06T12:00:00Z'))
  cleanup.push(async () => void vi.useRealTimers())
  const f = await fixture()
  await writeSecret(f.root, 'BRAVE_API_KEY', 'stored-sentinel')
  vi.stubEnv('BRAVE_API_KEY', 'environment')
  const requests: unknown[] = []
  await fake((path, query, key) => {
    requests.push({ path, query: Object.fromEntries(query), key })
    return { data: context }
  })
  const output = await f.run({
    query: 'question',
    maxResults: 3,
    afterDate: '2026-01-01',
    country: 'DE',
  })
  expect(requests).toEqual([
    {
      path: '/llm/context',
      key: 'stored-sentinel',
      query: {
        q: 'question',
        count: '3',
        maximum_number_of_urls: '3',
        country: 'de',
        freshness: '2026-01-01to2026-11-06',
      },
    },
  ])
  expect(f.details.mock.calls[0][0]).toEqual({
    status: 'success',
    results: [
      {
        url: 'https://example.com/a',
        title: 'Example',
        publish_date: '2026-01-01',
        excerpts: ['first', 'second'],
      },
      {
        url: 'https://other.example/b',
        title: null,
        publish_date: null,
        excerpts: ['undated'],
      },
    ],
  })
  const text = JSON.stringify(output)
  expect(text).toContain('Found 2 results for: question')
  expect(text).toContain('Published: 2026-01-01')
  expect(text).not.toContain('stored-sentinel')
  await f.run({ query: 'defaults' })
  expect(requests[1]).toMatchObject({ query: { q: 'defaults', count: '10' } })
})
it('reports a missing key or disabled secrets with one notice', async () => {
  vi.stubEnv('BRAVE_API_KEY', '')
  const f = await fixture()
  for (let i = 0; i < 2; i++) expect(JSON.stringify(await f.run({ query: 'x' }))).toContain('⌘K')
  expect(f.notice).toHaveBeenCalledTimes(1)
  vi.stubEnv('BRAVE_API_KEY', 'env-key')
  const disabled = await fixture(false)
  expect(JSON.stringify(await disabled.run({ query: 'x' }))).toContain('BRAVE_API_KEY')
})
it.each([401, 429, 500])('maps HTTP %i with its reference and redacts the key', async (status) => {
  const f = await fixture()
  vi.stubEnv('BRAVE_API_KEY', 'secret-sentinel')
  await fake(() => ({
    status,
    data: {
      type: 'ErrorResponse',
      error: { id: 'ref-1', status, detail: 'secret-sentinel bad' },
    },
  }))
  const output = await f.run({ query: 'x' })
  expect(output).toHaveProperty('isError', true)
  expect(JSON.stringify([output, f.details.mock.calls])).not.toContain('secret-sentinel')
  expect(JSON.stringify(output)).toContain(
    status === 401 ? 'Secrets panel' : status === 429 ? 'rate limit' : '[redacted] bad',
  )
  expect(f.details.mock.calls[0][0]).toMatchObject({
    httpStatus: status,
    ref_id: 'ref-1',
  })
})
it('rejects malformed responses and maps cancellation', async () => {
  const f = await fixture()
  vi.stubEnv('BRAVE_API_KEY', 'key')
  let raw = 'not json'
  await fake(() => (raw === 'hang' ? { hang: true } : { raw }))
  for (const value of ['not json', '{}', '{"grounding":{"generic":[{"url":1,"snippets":[]}]}}']) {
    raw = value
    expect(await f.run({ query: 'x' })).toHaveProperty('isError', true)
  }
  raw = 'hang'
  const controller = new AbortController()
  const request = braveRequest('/llm/context', { q: 'x' }, controller.signal, 'key')
  controller.abort()
  await expect(request).rejects.toThrow('cancelled')
})
