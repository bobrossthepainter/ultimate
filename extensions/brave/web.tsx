// The search card is copied from extensions/parallel/web.tsx so this fork leaves parallel untouched
// (#14198, keep-divergence-mergeable); share it through parallel's ui.tsx if this goes upstream.
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Shimmer } from '@/components/ai/shimmer'
import {
  Tool,
  ToolContent,
  ToolDiagnostics,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { defineWebExtension, events, useCommands, useToolDuration, useUltimate } from '@/sdk'
import { plural } from '@/sdk'
import type { ToolCallView } from '@/sdk'

/** A result in the tool's `details` (server.ts). */
interface Page {
  url: string
  title: string | null
  publish_date: string | null
  excerpts: string[]
}
type Details =
  | { status: 'success'; results?: Page[] }
  | {
      status: 'error'
      error: string
      httpStatus: number | null
      ref_id: string | null
    }

const text = (value: unknown) => (typeof value === 'string' ? value : '')

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
/** A URL as shown: no scheme, no `www.`, no trailing slash. */
const bare = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
/** The first few distinct domains, in rank order. */
function domains(urls: readonly string[], count = 3) {
  const unique = [...new Set(urls.map(host))]
  return unique.length > count
    ? `${unique.slice(0, count).join(', ')} +${unique.length - count}`
    : unique.join(', ')
}
const day = (date: string) => (/^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : date)

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      className="mr-1.5 h-6 shrink-0 px-2 font-mono text-[11px]"
      onClick={onClick}
      size="xs"
      type="button"
      variant="outline"
    >
      {label}
    </Button>
  )
}

/**
 * For a missing or rejected BRAVE_API_KEY: opens the Secrets panel at it, or, while `secrets` is off, the
 * Extensions panel to turn it on.
 */
function KeyAction({ error }: { error: string }) {
  const commands = useCommands()
  const ui = useUltimate()
  if (!error.includes('BRAVE_API_KEY')) return null
  const has = (id: string) => commands.some((command) => command.id === id)
  if (has('secrets.panel'))
    return (
      <Action
        label={error.includes('rejected') ? 'Replace key' : 'Add key'}
        onClick={() => events.emit('secrets:open', { name: 'BRAVE_API_KEY' })}
      />
    )
  if (has('onboarding.extensions'))
    return <Action label="Turn on secrets" onClick={() => ui.runCommand('onboarding.extensions')} />
  return null
}

/** The card: the header, an action beside it, and the body. */
function Card({
  call,
  name,
  title,
  meta,
  running,
  children,
}: {
  call: ToolCallView
  name: string
  title: ReactNode
  meta: ReactNode
  running: string
  children: ReactNode
}) {
  const duration = useToolDuration(call)
  const details = call.details as Details | undefined
  const failure = details?.status === 'error' ? details : undefined
  // Collapsed while it goes well; a failure opens it, also one that arrives live.
  const failed = call.status === 'error'
  const [open, setOpen] = useState(failed)
  const was = useRef(failed)
  useEffect(() => {
    if (failed && !was.current) setOpen(true)
    was.current = failed
  }, [failed])
  return (
    <Tool onOpenChange={setOpen} open={open}>
      <div className="flex items-center">
        <ToolHeader
          className="min-w-0 flex-1"
          meta={
            <>
              {meta}
              {duration && <span>{duration}</span>}
            </>
          }
          name={name}
          state={call.status}
          title={title}
        />
        {failure && <KeyAction error={failure.error} />}
      </div>
      <ToolContent>
        {call.status === 'running' && (
          <ToolSection>
            <Shimmer className="text-[12px]">{running}</Shimmer>
          </ToolSection>
        )}
        {failure ? (
          <ToolSection>
            <div className="break-words text-error">{failure.error}</div>
            {(failure.httpStatus || failure.ref_id) && (
              <div className="text-[11px] text-muted-foreground/70">
                {[
                  failure.httpStatus && `HTTP ${failure.httpStatus}`,
                  failure.ref_id && `ref ${failure.ref_id}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            )}
          </ToolSection>
        ) : details ? (
          children
        ) : (
          call.status === 'error' && <ToolOutput isError output={call.output} />
        )}
        <ToolDiagnostics diagnostics={call.diagnostics.filter((d) => d.code !== 'tool_error')} />
      </ToolContent>
    </Tool>
  )
}

/** A link that opens in a new tab; nothing is requested until it is followed. */
function Link({
  url,
  className,
  children,
}: {
  url: string
  className?: string
  children: ReactNode
}) {
  return (
    <a className={className} href={url} rel="noreferrer" target="_blank" title={url}>
      {children}
    </a>
  )
}

function Search({ call }: { call: ToolCallView }) {
  const details = call.details as Details | undefined
  const results = (details?.status !== 'error' && details?.results) || []
  const query = text(call.args.query)
  const shown = details && details.status !== 'error'
  return (
    <Card
      call={call}
      meta={shown && <span>{plural(results.length, 'result')}</span>}
      name="search"
      running="searching the web…"
      title={
        <>
          <span className="text-foreground/90">{query}</span>
          {results.length > 0 && (
            <span className="text-muted-foreground/60">
              {' '}
              · {domains(results.map((r) => r.url))}
            </span>
          )}
        </>
      }
    >
      {results.length > 0 && (
        <ol aria-label="Search results" className="divide-y divide-border/60">
          {results.map((result, index) => {
            const excerpt = result.excerpts.join(' … ').replace(/\s+/g, ' ').trim()
            return (
              <li className="flex gap-2.5 px-2.5 py-2" key={result.url}>
                <span className="w-4 shrink-0 text-right text-muted-foreground/60 tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    className="block truncate font-sans text-[13px] text-foreground hover:underline"
                    url={result.url}
                  >
                    {result.title || bare(result.url)}
                  </Link>
                  <div className="mt-0.5 flex min-w-0 gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate">{host(result.url)}</span>
                    {result.publish_date && (
                      <span className="shrink-0 text-muted-foreground/70">
                        {day(result.publish_date)}
                      </span>
                    )}
                  </div>
                  {excerpt && (
                    <p className="mt-1 line-clamp-3 font-sans text-[12.5px] leading-snug text-muted-foreground">
                      {excerpt}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {shown && results.length === 0 && (
        <ToolSection className="text-muted-foreground/70">no results</ToolSection>
      )}
    </Card>
  )
}

export default defineWebExtension({ tools: { web_search: Search } })
