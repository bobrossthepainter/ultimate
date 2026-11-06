import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { ExtensionHost } from '../../server/extensions.ts'
import { readSecret } from '../../lib/secrets.ts'
import { braveRequest, BraveApiError } from './client.ts'
import type { ContextResponse } from './client.ts'
import { truncateToolOutput } from './output.ts'

export const secrets = [
  {
    name: 'BRAVE_API_KEY',
    description:
      'Brave Search API key for web search ($5 free credit a month; sign-up needs a credit card)',
    url: 'https://api-dashboard.search.brave.com/app/keys',
  },
]
const missing =
  'Missing BRAVE_API_KEY or secrets is not enabled. Enable secrets and add BRAVE_API_KEY in the Secrets panel (⌘K → Secrets).'
export default function brave(host: ExtensionHost) {
  const notices = host.resource('brave:missing-key', () => ({ sent: false }))
  async function key() {
    if (
      host
        .extensions()
        .some(
          (extension) =>
            extension.name === 'secrets' &&
            extension.enabled &&
            extension.server &&
            !extension.server.error,
        )
    ) {
      const value = (await readSecret(host.userHome, 'BRAVE_API_KEY')) ?? process.env.BRAVE_API_KEY
      if (value) return value
    }
    if (!notices.sent) {
      notices.sent = true
      host.notice(missing)
    }
    throw new Error(missing)
  }
  return defineExtension({
    name: 'brave',
    tools: [
      defineTool({
        name: 'web_search',
        // Repeating a search only reads public web results; it changes no project state.
        replay: 'safe',
        description:
          "Search the public web with Brave Search's LLM Context API. Returns ranked pages with titles, URLs, dates, and the passages of each page that answer the query (text, tables, code). Use this to discover sources or find current information; to read one known site, add site:example.com to the query. For raw files, APIs, JSON feeds, or a known URL's full page, use curl. Output is limited to 50KB or 2,000 lines.",
        parameters: obj({
          query: str({
            minLength: 1,
            maxLength: 600,
            description:
              'Search keywords, at most 75 words. Supports search operators: "exact phrase", -exclude, site:example.com, filetype:pdf.',
          }),
          maxResults: opt(
            int({
              minimum: 1,
              maximum: 20,
              description: 'Maximum number of results. Defaults to 10.',
            }),
          ),
          afterDate: opt(
            str({
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Only include content published on or after this date (YYYY-MM-DD).',
            }),
          ),
          country: opt(
            str({
              pattern: '^[A-Za-z]{2}$',
              description: 'Two-letter country code to search from (e.g. DE). Defaults to US.',
            }),
          ),
        }),
        async execute(args, api, context) {
          try {
            const max = String(args.maxResults ?? 10)
            const response = await braveRequest<ContextResponse>(
              '/llm/context',
              {
                q: args.query,
                count: max,
                maximum_number_of_urls: max,
                ...(args.country ? { country: args.country.toLowerCase() } : {}),
                ...(args.afterDate
                  ? {
                      freshness: `${args.afterDate}to${new Date().toISOString().slice(0, 10)}`,
                    }
                  : {}),
              },
              context.abortSignal,
              await key(),
            )
            validateResponse(response)
            const results = summarize(response)
            await api.details({ status: 'success', results }, context)
            const text =
              `Found ${results.length} results for: ${args.query}\n\n` +
              response.grounding.generic
                .map((page, index) => {
                  const date = results[index].publish_date
                  return `${index + 1}. ${page.title || 'Untitled page'}\nURL: ${page.url}${date ? `\nPublished: ${date}` : ''}\n${page.snippets.join('\n\n')}`
                })
                .join('\n\n---\n\n')
            return {
              output: [{ type: 'text', text: truncateToolOutput(text) }],
            }
          } catch (error) {
            const text = truncateToolOutput(
              error instanceof Error ? error.message : 'Brave Search request failed.',
            )
            await api.details(
              {
                status: 'error',
                error: text,
                httpStatus: error instanceof BraveApiError ? (error.status ?? null) : null,
                ref_id: error instanceof BraveApiError ? (error.referenceId ?? null) : null,
              },
              context,
            )
            return { isError: true, output: [{ type: 'text' as const, text }] }
          }
        },
      }),
    ],
  })
}
/** Bounded details in the shape parallel's search card reads: url, title, publish_date, excerpts. */
function summarize(response: ContextResponse) {
  return response.grounding.generic.slice(0, 20).map((page) => {
    const age = response.sources?.[page.url]?.age
    return {
      url: page.url.slice(0, 2048),
      title: page.title?.slice(0, 500) ?? null,
      publish_date: (Array.isArray(age) && typeof age[1] === 'string' && age[1]) || null,
      excerpts: page.snippets.slice(0, 10).map((snippet) => snippet.slice(0, 2000)),
    }
  })
}
const nullableString = (item: unknown) => item == null || typeof item === 'string'
export function validateResponse(value: ContextResponse) {
  if (
    !value.grounding ||
    !Array.isArray(value.grounding.generic) ||
    !value.grounding.generic.every(
      (item) =>
        item &&
        typeof item.url === 'string' &&
        nullableString(item.title) &&
        Array.isArray(item.snippets) &&
        item.snippets.every((snippet) => typeof snippet === 'string'),
    ) ||
    (value.sources != null && (typeof value.sources !== 'object' || Array.isArray(value.sources)))
  )
    throw new Error('Brave Search API returned an unexpected response shape.')
}
