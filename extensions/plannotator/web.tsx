import type { EntryRecord } from '@earendil-works/pi-durable'
import { ExternalLinkIcon, MessageSquareCodeIcon } from 'lucide-react'
import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { MessageResponse } from '@/components/ai/message'
import { Tool, ToolContent, ToolHeader, ToolOutput, ToolSection } from '@/components/ai/tool'
import { Button } from '@/components/ui/button'
import { api, cn, defineWebExtension, Fold, useAction } from '@/sdk'
import type { ToolCallView } from '@/sdk'
import { InstallAction, OverviewAction, StartAction, StopAction } from './refs.ts'
import type { Session } from './refs.ts'

/** `PlannotatorResult` in server.ts. */
type Result = { title: string; decision: 'approved' | 'annotated'; message: string; url?: string }

const parse = (output: string): Session | undefined => {
  try {
    return JSON.parse(output) as Session
  } catch {
    return undefined
  }
}

/** A ref as the card shows it: a full commit hash shortened to 7 characters, branch names as they are. */
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

/** The session as the server knows it now; polled while it runs, so the card follows its state. */
function useSession(started: Session | undefined) {
  const { data, refetch } = useAction(OverviewAction, null, {
    enabled: !!started,
    // A failed poll keeps the last state; the next one tries again.
    onError: () => {},
  })
  const session = data?.sessions.find((item) => item.id === started?.id)
  const running = (session ?? started)?.state === 'running'
  useEffect(() => {
    if (!running) return undefined
    const timer = setInterval(() => void refetch(), 3000)
    return () => clearInterval(timer)
  }, [running, refetch])
  // A session this server no longer knows (it restarted) ended with it.
  return session ?? (data && started ? { ...started, state: 'stopped' as const } : started)
}

/** One `review_with_plannotator` call: what is reviewed, where to open it, and how it ended. */
function ReviewCall({ call, core }: { call: ToolCallView; core: ReactNode }) {
  const started = call.status === 'done' ? parse(call.output) : undefined
  const session = useSession(started)
  if (!session) return core
  const open = session.state === 'running'
  return (
    <Tool defaultOpen>
      <ToolHeader
        action={
          open && (
            <div className="flex items-center gap-1">
              <Button asChild className="h-6 px-2 font-mono text-[11px]" size="xs">
                <a href={session.url} rel="noreferrer" target="_blank">
                  Open <ExternalLinkIcon className="size-3" />
                </a>
              </Button>
              <Button
                className="h-6 px-2 font-mono text-[11px]"
                onClick={() => void api.action(StopAction, { id: session.id })}
                size="xs"
                variant="ghost"
              >
                Stop
              </Button>
            </div>
          )
        }
        icon={MessageSquareCodeIcon}
        meta={<span className={tone[session.state]}>{words[session.state]}</span>}
        name="Plannotator"
        state={call.status}
        title={session.title}
      />
      <ToolContent>
        <ToolSection
          label={`${session.repos.length === 1 ? 'Repository' : 'Repositories'} · ${modes[session.mode]}`}
        >
          <ul className="space-y-0.5">
            {session.repos.map((repo) => (
              <li className="flex min-w-0 gap-2" key={repo.path}>
                <span className="shrink-0 text-foreground/90">{repo.name}</span>
                <span className="min-w-0 truncate text-muted-foreground">{repo.path}</span>
                {(repo.ref || repo.base) && (
                  <span
                    className="ml-auto shrink-0 text-muted-foreground"
                    title={[repo.ref, repo.base].filter(Boolean).join(' since ')}
                  >
                    {repo.ref && <span className="text-foreground/80">{short(repo.ref)}</span>}
                    {repo.ref && repo.base && ' '}
                    {repo.base && `since ${short(repo.base)}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </ToolSection>
        {session.url && (
          <ToolSection label="Address">
            <span className={cn(open ? 'text-brand' : 'text-muted-foreground')}>{session.url}</span>
          </ToolSection>
        )}
        {session.error && <ToolOutput isError output={session.error} />}
      </ToolContent>
    </Tool>
  )
}

/** The user's Plannotator decision, in the transcript of the conversation that asked: on their side, like a review. */
function ResultCard({ entry }: { entry: EntryRecord }) {
  const { title, decision, message } = entry.data as Result
  const summary = (
    <>
      <MessageSquareCodeIcon className="size-3 shrink-0 text-brand" />
      Plannotator · {decision === 'approved' ? 'approved' : 'feedback'} on{' '}
      <span className="text-foreground/85">{title}</span>
    </>
  )
  return (
    <div className="mt-3 flex justify-end first:mt-0">
      <Fold card={entry.id} keep summary={summary}>
        <section className="w-full max-w-2xl min-w-0 overflow-hidden rounded-lg border border-border/70 border-l-2 border-l-brand/50 bg-secondary/40">
          <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            {summary}
          </header>
          <div className="px-3 py-2 text-[13.5px]">
            <MessageResponse>{message}</MessageResponse>
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
      // This conversation's worktree, else the project's checkout, opened in a new tab; the result comes back here. The
      // tab opens before the await, while the click still allows it, and follows the session once it serves.
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
