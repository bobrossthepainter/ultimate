import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { actions as voice } from '../extensions/voice/server.ts'
import { Transcriber } from '../extensions/voice/api.ts'
import { transcriber } from '../extensions/voice-chatgpt/server.ts'
import { NO_LOGIN } from '../extensions/voice-chatgpt/chatgpt.ts'
import type { ActionContext } from '../server/actions.ts'
import { removeTemp, temp } from './helpers.ts'

type Sent = { url: string; headers: Record<string, string>; body: Buffer }
type Reply = { status: number; body: string; headers?: Record<string, string> }
const https = vi.hoisted(() => ({ sent: [] as Sent[], replies: [] as Reply[] }))
// chatgpt.com only through node:https: each request records what it sent and gets the next queued reply.
vi.mock('node:https', () => ({
  request: (
    url: string,
    options: { headers: Record<string, string> },
    respond: (res: EventEmitter) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & { end(body: Buffer): void }
    req.end = (body) => {
      https.sent.push({ url, headers: options.headers, body })
      const reply = https.replies.shift()!
      const res = Object.assign(new EventEmitter(), {
        statusCode: reply.status,
        headers: reply.headers ?? {},
      })
      respond(res)
      res.emit('data', Buffer.from(reply.body))
      res.emit('end')
    }
    return req
  },
}))

const cleanup: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  https.sent.length = 0
  https.replies.length = 0
  for (const root of cleanup.splice(0)) await removeTemp(root)
})

const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }
const token = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`

/** A host with no OpenAI API key; with `login`, Pi holds the `openai-codex` login; with `subscription`, voice-chatgpt provides its point. */
async function context(login: boolean, subscription: boolean) {
  const userHome = await temp()
  cleanup.push(userHome)
  const modelRuntime = {
    getProviderAuthStatus: (provider: string) => ({
      configured: login && provider === 'openai-codex',
    }),
    isUsingOAuth: () => true,
    getAuth: async (provider: string) =>
      login && provider === 'openai-codex' ? { auth: { apiKey: token } } : undefined,
  }
  const points = new Map<string, unknown>(
    subscription ? [[Transcriber.name, transcriber({ modelRuntime } as never)]] : [],
  )
  return {
    host: { userHome, modelRuntime, want: (api: { name: string }) => points.get(api.name) },
    signal: new AbortController().signal,
  } as unknown as ActionContext
}

const audio = { audio: Buffer.from('fake audio').toString('base64'), mimeType: 'audio/webm' }

it('without voice-chatgpt, voice still asks for the API key', async () => {
  const ctx = await context(true, false)
  expect(await voice.status(null, ctx)).toEqual({
    available: false,
    reason: 'Voice needs an OpenAI API key: add OPENAI_API_KEY in ⌘K → Secrets',
    secret: 'OPENAI_API_KEY',
  })
  await expect(voice.transcribe(audio, ctx)).rejects.toThrow('Voice needs an OpenAI API key')
  expect(https.sent).toEqual([])
})

it('with voice-chatgpt, dictation goes to ChatGPT with the subscription login and no API key', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
  vi.stubGlobal('fetch', fetch)
  const ctx = await context(true, true)
  expect(await voice.status(null, ctx)).toEqual({ available: true })
  https.replies.push({ status: 200, body: JSON.stringify({ text: ' Hello there. ' }) })
  expect(await voice.transcribe(audio, ctx)).toEqual({ text: 'Hello there.' })
  const [sent] = https.sent
  expect(sent.url).toBe('https://chatgpt.com/backend-api/transcribe')
  expect(sent.headers).toMatchObject({
    Authorization: `Bearer ${token}`,
    'chatgpt-account-id': 'acct-1',
    originator: 'ultimate',
  })
  const form = await new Response(new Uint8Array(sent.body), {
    headers: { 'content-type': sent.headers['Content-Type'] },
  }).formData()
  expect(form.get('model')).toBe('gpt-transcribe')
  const file = form.get('file') as File
  expect([file.name, await file.text()]).toEqual(['recording.webm', 'fake audio'])
  expect(fetch).not.toHaveBeenCalled()
})

it('with voice-chatgpt but no login, the mic says to log in and sends nothing', async () => {
  const ctx = await context(false, true)
  expect(await voice.status(null, ctx)).toEqual({ available: false, reason: NO_LOGIN })
  await expect(voice.transcribe(audio, ctx)).rejects.toThrow(NO_LOGIN)
  expect(https.sent).toEqual([])
})

it('names a Cloudflare challenge, a rejected login and a rate limit', async () => {
  const ctx = await context(true, true)
  https.replies.push(
    { status: 403, body: '<html>Just a moment…</html>', headers: { 'cf-mitigated': 'challenge' } },
    { status: 401, body: JSON.stringify({ detail: 'Could not parse your authentication token.' }) },
    { status: 429, body: JSON.stringify({ detail: 'Too many requests' }) },
  )
  await expect(voice.transcribe(audio, ctx)).rejects.toThrow(
    'Cloudflare blocked ChatGPT transcription from this server: disable voice-chatgpt to use an OpenAI API key',
  )
  await expect(voice.transcribe(audio, ctx)).rejects.toThrow(
    'ChatGPT rejected the login: log in to “OpenAI (ChatGPT Plus/Pro)” again in the model picker',
  )
  await expect(voice.transcribe(audio, ctx)).rejects.toThrow(
    'ChatGPT is rate-limiting transcription (Too many requests): try again later',
  )
})

it('a failed login refresh never passes its token response on', async () => {
  const modelRuntime = {
    getProviderAuthStatus: () => ({ configured: true }),
    getAuth: async () => {
      throw new Error('token response {"access_token":"sk-leak-sentinel"} has no expires_in')
    },
  }
  const failure = await transcriber({ modelRuntime } as never)
    .transcribe(new Blob(['x'], { type: 'audio/webm' }), new AbortController().signal)
    .catch((error: Error) => error)
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toBe(
    'ChatGPT rejected the login: log in to “OpenAI (ChatGPT Plus/Pro)” again in the model picker',
  )
  expect(JSON.stringify([String(failure), (failure as Error).cause])).not.toContain('sk-leak')
  expect(https.sent).toEqual([])
})
