import { ArrowDownIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api, cn, defineWebExtension, events, formatAgo, useAction, useUltimate } from '@/sdk'
import { CheckAction, MergeAction, StateAction } from './refs.ts'
import type { UpstreamState } from './refs.ts'

const statusButton =
  '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent'

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

function Popup({
  state,
  busy,
  checking,
  error,
  check,
  merge,
}: {
  state: UpstreamState
  busy: boolean
  checking: boolean
  error?: string
  check: () => void
  merge: () => void
}) {
  const branch = state.branch ?? 'main'
  // Under a summary the commit list folds to the first few.
  const shown = Math.min(state.commits.length, state.summary ? 3 : 5)
  return (
    <>
      <div className="border-b border-border/70 px-3 py-2 text-[11.5px]">
        <div className="section-label">Upstream</div>
        <div className="text-muted-foreground">
          upstream/{branch} · {state.ahead} {state.ahead === 1 ? 'commit' : 'commits'} of the fork's
          own
        </div>
      </div>
      <div className="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        {!state.behind ? (
          <div>
            {checking ? (
              'Checking upstream for new commits…'
            ) : (
              <>
                {branch} has <span className="text-success">everything</span> from upstream/
                {branch}
              </>
            )}
          </div>
        ) : (
          <>
            <div>
              upstream/{branch} has {state.behind} new {state.behind === 1 ? 'commit' : 'commits'}
            </div>
            {state.summary && (
              <ul className="space-y-0.5 font-sans text-[12.5px] text-foreground">
                {state.summary.map((line) => (
                  <li className="flex gap-1.5" key={line}>
                    <span className="text-brand">•</span>
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ul>
            )}
            <ul className="space-y-0.5">
              {state.commits.slice(0, shown).map((commit) => (
                <li className="flex min-w-0 gap-2" key={commit.sha}>
                  <span className="shrink-0 text-muted-foreground">{commit.sha}</span>
                  <span className="truncate text-foreground/85" title={commit.subject}>
                    {commit.subject}
                  </span>
                </li>
              ))}
              {state.behind > shown && (
                <li className="text-muted-foreground">… {state.behind - shown} more</li>
              )}
            </ul>
            {state.compare && (
              <div>
                <a
                  className="text-muted-foreground hover:text-brand"
                  href={state.compare}
                  rel="noreferrer"
                  target="_blank"
                >
                  DiffsHub ↗
                </a>
              </div>
            )}
            {state.merge && (
              <div>
                @ultimate merges it on a branch with the merge-upstream skill, keeping the fork's
                divergences, and lands it once the checks pass.
              </div>
            )}
          </>
        )}
        {state.refused && (
          <div className="flex items-start gap-1.5 text-warning">
            <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
            <span>{state.refused}</span>
          </div>
        )}
        {state.error && (
          <div className="break-words text-error" title={state.error}>
            Last fetch failed: {state.error.split('\n')[0]}
          </div>
        )}
        {error && <div className="break-words text-error">{error}</div>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span className="text-[10.5px] text-muted-foreground">
          {state.fetchedAt !== undefined
            ? `checked ${formatAgo(state.fetchedAt, Date.now(), { ago: true })}`
            : ''}
        </span>
        <div className="flex items-center gap-1">
          <Button
            className="h-7 font-sans text-[12px] text-muted-foreground"
            disabled={checking}
            onClick={check}
            size="sm"
            variant="ghost"
          >
            {checking ? (
              <LoaderCircleIcon className="size-3 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3" />
            )}
            {checking ? 'Checking…' : 'Check now'}
          </Button>
          {state.merge && (
            <Button
              className="h-7 font-sans text-[12px]"
              data-upstream-merge
              disabled={busy}
              onClick={merge}
              size="sm"
              variant="outline"
            >
              {busy ? 'Asking…' : 'Update with @ultimate'}
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

/** The status-line item: shown only while upstream has commits the clone lacks, or a fetch failed. */
function Upstream() {
  const { data: state, refetch } = useAction(
    StateAction,
    null,
    // A failed poll keeps the last state; the next one tries again.
    { onError: () => {} },
  )
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const { showSurface, switchConversation } = useUltimate()
  useEffect(() => {
    const timer = setInterval(() => void refetch(), 60_000)
    return () => clearInterval(timer)
  }, [refetch])
  if (!state || state.off || (!state.behind && !state.error)) return null
  const check = () => {
    setChecking(true)
    setError(undefined)
    api
      .action(CheckAction)
      .catch((cause: unknown) => setError(failure(cause)))
      // The check leaves its answer as the server's state.
      .finally(() => void refetch().finally(() => setChecking(false)))
  }
  // Hands the merge to @ultimate and opens its conversation, where the branch it starts shows up.
  const merge = () => {
    setBusy(true)
    setError(undefined)
    api
      .action(MergeAction)
      .then(({ id }) => {
        events.emit('ultimate:sent', { conversationId: id })
        showSurface('agent')
        switchConversation(id)
      })
      .catch((cause: unknown) => setError(failure(cause)))
      .finally(() => setBusy(false))
  }
  const warn = !state.behind || !state.merge
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className={cn(statusButton, warn ? 'text-warning' : 'text-brand')}
          data-upstream-sync
          title="New commits on the upstream this fork came from"
          type="button"
        >
          {busy || checking ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : warn ? (
            <TriangleAlertIcon className="size-3" />
          ) : (
            <ArrowDownIcon className="size-3" />
          )}
          {state.behind ? (
            <>
              {state.behind}
              <span className="max-md:hidden"> upstream</span>
            </>
          ) : (
            'upstream'
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
        side="top"
      >
        <Popup
          busy={busy}
          check={check}
          checking={checking}
          error={error}
          merge={merge}
          state={state}
        />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Upstream, order: -2 }] },
})
