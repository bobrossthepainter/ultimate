/** @jsxImportSource @solidjs/web */
import { ExternalLink, MessageSquareCode } from '@lucide/solid'
import { createMemo, For, Show } from 'solid-js'
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolOutput,
  ToolSection,
} from '@/components/ai/tool.solid.tsx'
import { Markdown } from '@/components/markdown/markdown.solid.tsx'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  api,
  cn,
  defineWebExtension,
  Fold,
  keepLast,
  useAction,
  type SolidEntryProps,
  type SolidToolProps,
} from '@/sdk/solid'
import { InstallAction, OverviewAction, StartAction, StopAction } from './refs.ts'
import type { Session } from './refs.ts'

type Result = {
  title: string
  decision: 'approved' | 'annotated'
  message: string
  url?: string
}

const parse = (output: string): Session | undefined => {
  try {
    return JSON.parse(output) as Session
  } catch {
    return undefined
  }
}

const short = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref)

const tone: Record<Session['state'], string> = {
  starting: 'text-muted-foreground',
  running: 'text-brand',
  approved: 'text-success',
  annotated: 'text-brand',
  dismissed: 'text-muted-foreground',
  failed: 'text-error',
  stopped: 'text-muted-foreground',
}
const words: Record<Session['state'], string> = {
  starting: 'starting',
  running: 'waiting for you',
  approved: 'approved',
  annotated: 'feedback sent',
  dismissed: 'closed without feedback',
  failed: 'failed',
  stopped: 'stopped',
}
const modes: Record<Session['mode'], string> = {
  single: 'live',
  combined: 'combined patch',
  live: 'live, uncommitted and last commit',
}

function useSession(started: () => Session) {
  const find = (sessions: readonly Session[] | undefined) =>
    sessions?.find((item) => item.id === started().id)
  const { data } = useAction(OverviewAction, null, {
    onError: keepLast,
    every: (overview) =>
      (find(overview?.sessions) ?? started()).state === 'running' ? 3000 : undefined,
  })
  return createMemo(() => {
    const overview = data()
    if (!overview) return started()
    return find(overview.sessions) ?? { ...started(), state: 'stopped' as const }
  })
}

function Repo(props: { repo: Session['repos'][number] }) {
  return (
    <li class="flex min-w-0 gap-2">
      <span class="shrink-0 text-foreground/90">{props.repo.name}</span>
      <span class="min-w-0 truncate text-muted-foreground">{props.repo.path}</span>
      <Show when={props.repo.ref || props.repo.base}>
        <span
          class="ml-auto shrink-0 text-muted-foreground"
          title={[props.repo.ref, props.repo.base].filter(Boolean).join(' since ')}
        >
          <Show when={props.repo.ref}>
            {(ref) => <span class="text-foreground/80">{short(ref())}</span>}
          </Show>
          {props.repo.ref && props.repo.base && ' '}
          <Show when={props.repo.base}>{(base) => `since ${short(base())}`}</Show>
        </span>
      </Show>
    </li>
  )
}

function SessionCard(props: { call: SolidToolProps['call']; started: Session }) {
  const session = useSession(() => props.started)
  const open = () => session().state === 'running'
  return (
    <Tool defaultOpen>
      <ToolHeader
        action={
          open() && (
            <div class="flex items-center gap-1">
              <Button
                aria-label={`Open Plannotator review #${props.call.id}`}
                class="h-6 px-2 font-mono text-[11px]"
                render={(link) => (
                  <a {...link} href={session().url} rel="noreferrer" target="_blank">
                    Open <ExternalLink class="size-3" />
                  </a>
                )}
                size="xs"
              />
              <Button
                aria-label={`Stop Plannotator review #${props.call.id}`}
                class="h-6 px-2 font-mono text-[11px]"
                onClick={() => api.action(StopAction, { id: session().id })}
                size="xs"
                variant="ghost"
              >
                Stop
              </Button>
            </div>
          )
        }
        aria-label={`Plannotator review #${props.call.id}`}
        icon={MessageSquareCode}
        meta={<span class={tone[session().state]}>{words[session().state]}</span>}
        name="Plannotator"
        state={props.call.status}
        title={session().title}
      />
      <ToolContent>
        <ToolSection
          label={`${session().repos.length === 1 ? 'Repository' : 'Repositories'} · ${modes[session().mode]}`}
        >
          <ul class="space-y-0.5">
            <For each={session().repos} keyed={(repo) => repo.path}>
              {(repo) => <Repo repo={repo()} />}
            </For>
          </ul>
        </ToolSection>
        <Show when={session().url}>
          {(url) => (
            <ToolSection label="Address">
              <span class={cn(open() ? 'text-brand' : 'text-muted-foreground')}>{url()}</span>
            </ToolSection>
          )}
        </Show>
        <Show when={session().error}>{(error) => <ToolOutput isError output={error()} />}</Show>
      </ToolContent>
    </Tool>
  )
}

function ReviewCall(props: SolidToolProps) {
  const started = createMemo(() =>
    props.call.status === 'done' ? parse(props.call.output) : undefined,
  )
  return (
    <Show when={started()} fallback={props.core}>
      {(session) => <SessionCard call={props.call} started={session()} />}
    </Show>
  )
}

function Summary(props: Result) {
  return (
    <>
      <MessageSquareCode class="size-3 shrink-0 text-brand" />
      Plannotator · {props.decision === 'approved' ? 'approved' : 'feedback'} on{' '}
      <span class="text-foreground/85">{props.title}</span>
    </>
  )
}

function ResultCard(props: SolidEntryProps) {
  const result = () => props.entry.data as Result
  return (
    <div class="mt-3 flex justify-end first:mt-0">
      <Fold
        card={props.entry.id}
        keep
        label={`Toggle Plannotator result #${props.entry.id}`}
        summary={<Summary {...result()} />}
      >
        <section class="w-full max-w-2xl min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40">
          <header class="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <Summary {...result()} />
          </header>
          <div class="px-3 py-2 text-[13.5px]">
            <Markdown text={result().message} />
          </div>
        </section>
      </Fold>
    </div>
  )
}

export default defineWebExtension({
  tools: { review_with_plannotator: ReviewCall },
  entries: { 'plannotator.result': ResultCard },
  commands: [
    {
      id: 'plannotator.install',
      title: 'Install Plannotator',
      run: async () => void (await api.action(InstallAction)),
    },
    {
      id: 'plannotator.review',
      title: 'Review with Plannotator',
      run: async (context) => {
        const tab = window.open('about:blank', '_blank')
        try {
          const session = await api.action(
            StartAction,
            { items: [{ conversation: context.conversationId }] },
            { conversationId: context.conversationId },
          )
          if (tab && session.url) tab.location.href = session.url
        } catch (error) {
          tab?.close()
          throw error
        }
      },
    },
  ],
})
