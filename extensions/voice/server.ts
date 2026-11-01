import { defineExtension } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { implementAction } from '../../lib/actions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { Transcriber } from './api.ts'
import type { TranscriberService } from './api.ts'
import { StatusAction, TranscribeAction } from './refs.ts'

const SECRET = 'OPENAI_API_KEY'
const NO_KEY = `Voice needs an OpenAI API key: add ${SECRET} in ⌘K → Secrets`
const TIMEOUT_MS = 65_000
/** The largest recording taken, in bytes before base64: what fits the 12 MB action request. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export const secrets = [
  {
    name: SECRET,
    description: 'OpenAI API key for voice input in the composer (speech to text)',
    url: 'https://platform.openai.com/api-keys',
  },
]

type VoiceHost = Pick<ExtensionHost, 'userHome' | 'modelRuntime' | 'want'>

/** The OpenAI API key: the `OPENAI_API_KEY` secret, else an API key Pi's `openai` provider holds (not its OAuth login). */
async function apiKey(host: VoiceHost, signal?: AbortSignal): Promise<string | undefined> {
  const secret = await readSecret(host.userHome, SECRET)
  if (secret) return secret
  const runtime = host.modelRuntime
  if (!runtime.getProviderAuthStatus('openai').configured || runtime.isUsingOAuth('openai'))
    return undefined
  return (await runtime.getAuth('openai', { signal }))?.auth.apiKey
}

/** OpenAI's documented transcription endpoint; the one place that knows its URL, form fields and answer. */
async function openaiTranscribe(
  key: string,
  audio: Blob,
  signal: AbortSignal,
): Promise<{ status: number; text?: string; detail?: string }> {
  const form = new FormData()
  const extension = audio.type.includes('mp4') ? 'mp4' : audio.type.includes('ogg') ? 'ogg' : 'webm'
  form.set('file', audio, `recording.${extension}`)
  form.set('model', 'gpt-4o-mini-transcribe')
  form.set('response_format', 'json')
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  })
  const body = await response.text()
  let answer: { text?: unknown; error?: { message?: unknown } } | undefined
  try {
    answer = JSON.parse(body)
  } catch {
    // An HTML or truncated page instead of JSON: a proxy or an outage answered.
    answer = undefined
  }
  if (!response.ok) {
    const message = answer?.error?.message
    return { status: response.status, detail: typeof message === 'string' ? message : undefined }
  }
  return typeof answer?.text === 'string'
    ? { status: response.status, text: answer.text }
    : { status: 502, detail: 'no text in the answer' }
}

/** What the composer shows for a failed transcription, by the endpoint's HTTP status. */
function failure(status: number, detail: string | undefined) {
  if (status === 401) return `OpenAI rejected the API key: check ${SECRET} in ⌘K → Secrets`
  if (status === 413) return 'The recording is too large to transcribe'
  if (status === 429)
    return `OpenAI is rate-limiting transcription${detail ? ` (${detail})` : ''}: try again in a minute`
  return `Transcription failed (HTTP ${status})${detail ? `: ${detail}` : ''}`
}

/** Transcription with the OpenAI API key: voice's own, used while no extension provides `voice.transcriber`. */
const byKey = (host: VoiceHost): TranscriberService => ({
  status: async (signal) =>
    (await apiKey(host, signal))
      ? { available: true }
      : { available: false, reason: NO_KEY, secret: SECRET },
  async transcribe(audio, signal) {
    const key = await apiKey(host, signal)
    if (!key) throw new Error(NO_KEY)
    const answer = await openaiTranscribe(key, audio, signal).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError') throw error
      throw new Error(
        `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (answer.text === undefined) throw new Error(failure(answer.status, answer.detail))
    return answer.text
  },
})
const transcriber = (host: VoiceHost) => host.want(Transcriber) ?? byKey(host)

export default (host: ExtensionHost) => {
  host.want(Transcriber)
  return defineExtension({ name: 'voice' })
}

export const actions = {
  /** `{ available }`, or `{ available: false, reason, secret? }` when transcription is not set up. */
  status: implementAction(StatusAction, async (_args, { host, signal }) =>
    transcriber(host).status(signal),
  ),
  /** `{ audio, mimeType }`: base64 audio as the browser recorded it (`audio/mp4` on iOS, `audio/webm` elsewhere). */
  transcribe: implementAction(TranscribeAction, async (args, { host, signal }) => {
    const { audio, mimeType } = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    if (typeof audio !== 'string' || !audio || typeof mimeType !== 'string' || !mimeType)
      throw new Error('Expected { audio: base64, mimeType }')
    const bytes = Buffer.from(audio, 'base64')
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error(failure(413, undefined))
    const text = await transcriber(host)
      .transcribe(
        new Blob([bytes], { type: mimeType }),
        AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'TimeoutError')
          throw new Error('Transcription timed out: try a shorter recording')
        throw error
      })
    return { text: text.trim() }
  }),
}
