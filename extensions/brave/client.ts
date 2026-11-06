const API_BASE_URL = 'https://api.search.brave.com/res/v1'
const REQUEST_TIMEOUT_MS = 120_000

/** One page in `grounding.generic` of `/llm/context`. */
export interface BraveGrounding {
  url: string
  title?: string | null
  snippets: string[]
}

/** `age` holds four fixed renderings: full date, `YYYY-MM-DD`, relative, ISO 8601; empty without a known date. */
export interface BraveSource {
  title?: string | null
  hostname?: string | null
  age?: string[] | null
}

export interface ContextResponse {
  grounding: { generic: BraveGrounding[] }
  sources?: Record<string, BraveSource> | null
}

export class BraveApiError extends Error {
  constructor(message: string, status?: number, referenceId?: string) {
    super(message)
    this.name = 'BraveApiError'
    this.status = status
    this.referenceId = referenceId
  }
  readonly status?: number
  readonly referenceId?: string
}

export async function braveRequest<T>(
  path: '/llm/context',
  params: Record<string, string>,
  signal: AbortSignal | undefined,
  apiKey: string,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const failed = () => {
    if (signal?.aborted) return new Error('Brave Search API request was cancelled.')
    if (timeoutSignal.aborted)
      return new Error('Brave Search API request timed out after 120 seconds.')
    return new Error('Could not reach the Brave Search API.')
  }

  let response: Response
  let raw: string
  try {
    response = await fetch(
      `${process.env.ULTIMATE_BRAVE_TEST_URL ?? API_BASE_URL}${path}?${new URLSearchParams(params)}`,
      {
        headers: { accept: 'application/json', 'x-subscription-token': apiKey },
        signal: requestSignal,
      },
    )
    raw = await response.text()
  } catch {
    throw failed()
  }
  let payload: unknown
  try {
    // Decode first: JSON escaping must not defeat credential redaction.
    payload = raw ? redact(JSON.parse(raw), apiKey) : undefined
  } catch {
    if (response.ok)
      throw new BraveApiError(
        'Brave Search API returned an invalid JSON response.',
        response.status,
      )
  }

  if (!response.ok) throw createApiError(response.status, payload)
  if (!payload || typeof payload !== 'object')
    throw new BraveApiError('Brave Search API returned an empty response.', response.status)
  return payload as T
}

function redact(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') return value.replaceAll(apiKey, '[redacted]')
  if (Array.isArray(value)) return value.map((item) => redact(item, apiKey))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(apiKey, '[redacted]'),
        redact(item, apiKey),
      ]),
    )
  return value
}

/** Brave answers errors as `{ type: 'ErrorResponse', error: { id, status, code, detail } }`. */
function createApiError(status: number, payload: unknown): BraveApiError {
  const error = getRecord(getRecord(payload)?.error)
  const referenceId = typeof error?.id === 'string' ? error.id.slice(0, 200) : undefined
  const apiMessage = typeof error?.detail === 'string' ? error.detail.slice(0, 500) : undefined

  if (status === 401 || status === 403)
    return new BraveApiError(
      'BRAVE_API_KEY was rejected. Replace it in the Secrets panel (⌘K → Secrets).',
      status,
      referenceId,
    )
  if (status === 429)
    return new BraveApiError(
      'Brave Search API rate limit or monthly credit exceeded. Wait and try again.',
      status,
      referenceId,
    )
  const message = apiMessage || `Brave Search API request failed with HTTP ${status}.`
  const suffix = referenceId ? ` (reference: ${referenceId})` : ''
  return new BraveApiError(`${message}${suffix}`, status, referenceId)
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
