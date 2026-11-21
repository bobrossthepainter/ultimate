/** @jsxImportSource @solidjs/web */
import { ArrowDown, LoaderCircle, RefreshCw, TriangleAlert } from '@lucide/solid'
import { createSignal, For, Show } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import {
  api,
  cn,
  defineWebExtension,
  events,
  formatAgo,
  keepLast,
  showSurface,
  switchConversation,
  useAction,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { CheckAction, MergeAction, StateAction } from './refs.ts'
import type { UpstreamState } from './refs.ts'

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error))

function Behind(props: { state: UpstreamState; branch: string }) {
  const shown = () => Math.min(props.state.commits.length, props.state.summary ? 3 : 5)
  return (
    <>
      <div>
        upstream/{props.branch} has {props.state.behind} new{' '}
        {props.state.behind === 1 ? 'commit' : 'commits'}
      </div>
      <Show when={props.state.summary}>
        {(summary) => (
          <ul class="space-y-0.5 font-sans text-[12.5px] text-foreground">
            <For each={summary()}>
              {(line) => (
                <li class="flex gap-1.5">
                  <span class="text-brand">•</span>
                  <span class="min-w-0">{line}</span>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <ul class="space-y-0.5">
        <For each={props.state.commits.slice(0, shown())} keyed={(commit) => commit.sha}>
          {(commit) => (
            <li class="flex min-w-0 gap-2">
              <span class="shrink-0 text-muted-foreground">{commit().sha}</span>
              <span class="truncate text-foreground/85" title={commit().subject}>
                {commit().subject}
              </span>
            </li>
          )}
        </For>
        <Show when={props.state.behind > shown()}>
          <li class="text-muted-foreground">… {props.state.behind - shown()} more</li>
        </Show>
      </ul>
      <Show when={props.state.compare}>
        {(compare) => (
          <div>
            <a
              class="text-muted-foreground hover:text-brand"
              href={compare()}
              rel="noreferrer"
              target="_blank"
            >
              DiffsHub ↗
            </a>
          </div>
        )}
      </Show>
      <Show when={props.state.merge}>
        <div>
          @ultimate merges it on a branch with the merge-upstream skill, keeping the fork's
          divergences, and lands it once the checks pass.
        </div>
      </Show>
    </>
  )
}

function Popup(props: {
  state: UpstreamState
  busy: boolean
  checking: boolean
  error?: string
  check: () => Promise<unknown>
  merge: () => Promise<unknown>
}) {
  const branch = () => props.state.branch ?? 'main'
  return (
    <>
      <div class="border-b border-border/70 px-3 py-2 text-[11.5px]">
        <div class="section-label">Upstream</div>
        <div class="text-muted-foreground">
          upstream/{branch()} · {props.state.ahead} {props.state.ahead === 1 ? 'commit' : 'commits'}{' '}
          of the fork's own
        </div>
      </div>
      <div class="space-y-2 px-3 py-2 text-[11.5px] leading-[1.55]">
        <Show
          when={props.state.behind}
          fallback={
            <div>
              <Show when={!props.checking} fallback={<>Checking upstream for new commits…</>}>
                {branch()} has <span class="text-success">everything</span> from upstream/
                {branch()}
              </Show>
            </div>
          }
        >
          <Behind branch={branch()} state={props.state} />
        </Show>
        <Show when={props.state.refused}>
          {(refused) => (
            <div class="flex items-start gap-1.5 text-warning">
              <TriangleAlert class="mt-0.5 size-3 shrink-0" />
              <span>{refused()}</span>
            </div>
          )}
        </Show>
        <Show when={props.state.error}>
          {(error) => (
            <div class="break-words text-error" title={error()}>
              Last fetch failed: {error().split('\n')[0]}
            </div>
          )}
        </Show>
        <Show when={props.error}>
          {(error) => <div class="break-words text-error">{error()}</div>}
        </Show>
      </div>
      <div class="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-1.5">
        <span class="text-[10.5px] text-muted-foreground">
          {props.state.fetchedAt !== undefined
            ? `checked ${formatAgo(props.state.fetchedAt, Date.now(), { ago: true })}`
            : ''}
        </span>
        <div class="flex items-center gap-1">
          <Button
            class="h-7 font-sans text-[12px] text-muted-foreground"
            disabled={props.checking}
            onClick={() => props.check()}
            size="sm"
            variant="ghost"
          >
            <Show when={props.checking} fallback={<RefreshCw class="size-3" />}>
              <LoaderCircle class="size-3 animate-spin" />
            </Show>
            {props.checking ? 'Checking…' : 'Check now'}
          </Button>
          <Show when={props.state.merge}>
            <Button
              aria-label="Update with @ultimate"
              class="h-7 font-sans text-[12px]"
              data-upstream-merge
              disabled={props.busy}
              onClick={() => props.merge()}
              size="sm"
              variant="outline"
            >
              {props.busy ? 'Asking…' : 'Update with @ultimate'}
            </Button>
          </Show>
        </div>
      </div>
    </>
  )
}

function Upstream() {
  const { data, refetch } = useAction(StateAction, null, {
    onError: keepLast,
    every: 60_000,
  })
  const [busy, setBusy] = createSignal(false)
  const [checking, setChecking] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const check = () => {
    setChecking(true)
    setError(undefined)
    return api
      .action(CheckAction)
      .catch((cause: unknown) => setError(failure(cause)))
      .finally(() => refetch().finally(() => setChecking(false)))
  }
  const merge = () => {
    const who = writerNow()
    setBusy(true)
    setError(undefined)
    return api
      .action(MergeAction)
      .then(({ id }) =>
        writingAs(who, () => {
          events.emit('ultimate:sent', { conversationId: id })
          showSurface('agent')
          switchConversation(id)
        }),
      )
      .catch((cause: unknown) => setError(failure(cause)))
      .finally(() => setBusy(false))
  }
  return (
    <Show when={data()?.off || !(data()?.behind || data()?.error) ? undefined : data()}>
      {(state) => {
        const warn = () => !state().behind || !state().merge
        return (
          <Popover>
            <StatusPopoverTrigger
              aria-label="Upstream"
              class={cn(warn() ? 'text-warning' : 'text-brand')}
              data-upstream-sync
              title="New commits on the upstream this fork came from"
            >
              <Show
                when={!(busy() || checking())}
                fallback={<LoaderCircle class="size-3 animate-spin" />}
              >
                <Show when={warn()} fallback={<ArrowDown class="size-3" />}>
                  <TriangleAlert class="size-3" />
                </Show>
              </Show>
              <Show when={state().behind} fallback="upstream">
                {state().behind}
                <span class="max-md:hidden"> upstream</span>
              </Show>
            </StatusPopoverTrigger>
            <PopoverContent
              align="end"
              class="w-[26rem] max-w-[calc(100vw-1rem)] p-0 font-mono"
              side="top"
            >
              <Popup
                busy={busy()}
                check={check}
                checking={checking()}
                error={error()}
                merge={merge}
                state={state()}
              />
            </PopoverContent>
          </Popover>
        )
      }}
    </Show>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Upstream, order: -2 }] },
})
