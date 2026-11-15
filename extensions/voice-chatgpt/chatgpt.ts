import { request } from 'node:https'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

type Runtime = Pick<ModelRuntime, 'getProviderAuthStatus' | 'getAuth'>

const PROVIDER = 'openai-codex'
export const NO_LOGIN =
  'Voice through ChatGPT needs your subscription: log in to “OpenAI (ChatGPT Plus/Pro)” in the model picker'

export const loggedIn = (runtime: Runtime) => runtime.getProviderAuthStatus(PROVIDER).configured
const RELOGIN =
  'ChatGPT rejected the login: log in to “OpenAI (ChatGPT Plus/Pro)” again in the model picker'

function accountId(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const id = claims?.['https://api.openai.com/auth']?.chatgpt_account_id
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

export type ChatGPTAnswer = { status: number; text: string; challenged: boolean }

export async function postTranscribe(
  runtime: Runtime,
  body: { type: string; data: Buffer },
  signal: AbortSignal,
): Promise<ChatGPTAnswer> {
  let token: string | undefined
  try {
    token = loggedIn(runtime)
      ? (await runtime.getAuth(PROVIDER, { signal }))?.auth.apiKey
      : undefined
  } catch {
    if (signal.aborted) throw signal.reason
    throw new Error(RELOGIN)
  }
  if (!token) throw new Error(NO_LOGIN)
  const account = accountId(token)
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(account ? { 'chatgpt-account-id': account } : {}),
    originator: 'ultimate',
    'User-Agent': 'ultimate',
    'Content-Type': body.type,
    'Content-Length': String(body.data.byteLength),
  }
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) =>
      reject(
        signal.aborted
          ? signal.reason
          : new Error(
              `Could not reach ChatGPT: ${error instanceof Error ? error.message : String(error)}`,
            ),
      )
    const req = request(
      'https://chatgpt.com/backend-api/transcribe',
      { method: 'POST', headers, signal },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', fail)
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            challenged: res.headers['cf-mitigated'] === 'challenge',
          }),
        )
      },
    )
    req.on('error', fail)
    req.end(body.data)
  })
}

export function failure(answer: ChatGPTAnswer) {
  if (answer.challenged)
    return 'Cloudflare blocked ChatGPT transcription from this server: disable voice-chatgpt to use an OpenAI API key'
  if (answer.status === 401) return RELOGIN
  let detail: unknown
  try {
    const parsed = JSON.parse(answer.text)
    detail = parsed?.detail ?? parsed?.error?.message
  } catch {
    detail = undefined
  }
  const reason = typeof detail === 'string' && detail ? detail : undefined
  if (answer.status === 429)
    return `ChatGPT is rate-limiting transcription${reason ? ` (${reason})` : ''}: try again later`
  return `ChatGPT transcription failed (HTTP ${answer.status})${reason ? `: ${reason}` : ''}`
}
