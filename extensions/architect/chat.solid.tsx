import type { ConversationId } from '@earendil-works/pi-durable'
import { LoaderIcon, MessagesSquareIcon, RotateCwIcon, XIcon } from '@lucide/solid'
import type { Accessor } from 'solid-js'
import { createEffect, createMemo, createSignal, Match, Show, Switch } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Toggle } from '@/components/ui/toggle.solid.tsx'
import {
  api,
  cn,
  Conversation,
  errorMessage,
  ScopedConversation,
  useConversationSummary,
  useDocOf,
} from '@/sdk/solid'
import { ChatAction, ChatDoc } from './refs.ts'

export function useChatBusy(branch: Accessor<ConversationId>) {
  const chat = useDocOf(branch, ChatDoc)
  const summary = useConversationSummary(() => chat()?.id)
  return () => summary()?.busy ?? false
}

export function DiscussButton(props: {
  branch: ConversationId
  open: boolean
  onToggle: (open: boolean) => void
}) {
  const busy = useChatBusy(() => props.branch)
  return (
    <Toggle
      aria-label="Discuss the architecture"
      bind={[() => props.open, (open) => props.onToggle(open)]}
      class="relative font-mono"
      data-architect-discuss=""
      size="xs"
      title={
        props.open ? 'Close the architecture chat' : 'Discuss the architecture with its architect'
      }
      variant="outline"
    >
      <MessagesSquareIcon />
      <span class="max-md:hidden">Discuss</span>
      {busy() && !props.open && (
        <span class="absolute -top-0.5 -right-0.5 size-1.5 animate-pulse-dot rounded-full bg-brand" />
      )}
    </Toggle>
  )
}

export function ChatPanel(props: {
  branch: ConversationId
  latest: number
  phone: boolean
  onClose: () => void
}) {
  const chat = useDocOf(() => props.branch, ChatDoc)
  const [starting, setStarting] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const start = (branch: ConversationId, fresh: boolean) => {
    setStarting(true)
    setError(undefined)
    return api
      .action(ChatAction, { branch, ...(fresh && { fresh }) })
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setStarting(false))
  }
  const missing = createMemo(() => {
    const current = chat()
    return current !== undefined && current?.id === undefined ? props.branch : undefined
  })
  createEffect(missing, (branch) => {
    if (branch !== undefined) void start(branch, false)
  })
  const stale = () => {
    const version = chat()?.version
    return version !== undefined && version < props.latest
  }
  return (
    <aside
      aria-label="Architecture chat"
      class={cn(
        'flex flex-col bg-background',
        props.phone
          ? 'absolute inset-0 z-30'
          : 'relative w-[clamp(20rem,32vw,28rem)] shrink-0 border-l border-border/70',
      )}
      data-architect-chat={chat()?.id}
    >
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 pr-1 pl-3 font-mono text-[11.5px] text-muted-foreground">
        <MessagesSquareIcon class="size-3.5 shrink-0 text-brand" />
        <span class="text-foreground/90">architecture chat</span>
        <Show when={chat()?.version}>
          {(version) => <span class="shrink-0">· on v{version()}</span>}
        </Show>
        <span class="flex-1" />
        {chat()?.id !== undefined && !stale() && (
          <Button
            aria-label="New chat"
            class="flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-50"
            disabled={starting()}
            onClick={() => start(props.branch, true)}
            size={null}
            title="Start over: a new copy of the architect"
            type="button"
            variant={null}
          >
            <RotateCwIcon class="size-3.5" />
          </Button>
        )}
        <Button
          aria-label="Close the chat"
          class="flex size-7 items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
          onClick={() => props.onClose()}
          size={null}
          title={props.phone ? 'Back to the diagram' : 'Close the chat'}
          type="button"
          variant={null}
        >
          <XIcon class="size-4" />
        </Button>
      </div>
      {stale() && (
        <div class="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <span class="min-w-0 flex-1">
            Opened at v{chat()?.version}; v{props.latest} is newer.
          </span>
          <Button
            disabled={starting()}
            onClick={() => start(props.branch, true)}
            size="xs"
            variant="outline"
          >
            {starting() && <LoaderIcon class="animate-spin" />}
            New chat on v{props.latest}
          </Button>
        </div>
      )}
      <Switch
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <LoaderIcon class="size-4 animate-spin text-muted-foreground" />
            <p class="text-[12.5px] text-muted-foreground">Copying the architect…</p>
          </div>
        }
      >
        <Match when={error()}>
          {(message) => (
            <div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p class="font-mono text-[11.5px] break-words text-error">{message()}</p>
              <Button
                onClick={() => start(props.branch, chat()?.id !== undefined)}
                size="xs"
                variant="outline"
              >
                Try again
              </Button>
            </div>
          )}
        </Match>
        <Match when={!(starting() && !stale()) && chat()?.id}>
          {(id) => (
            <ScopedConversation id={id()}>
              <Intro version={chat()?.version} />
              <Conversation variant="dock" />
            </ScopedConversation>
          )}
        </Match>
      </Switch>
    </aside>
  )
}

function Intro(props: { version?: number }) {
  return (
    <p class="shrink-0 border-b border-border/40 px-3 py-2 text-[12px] leading-snug text-muted-foreground">
      A copy of the architect that drew {props.version === undefined ? 'this' : `v${props.version}`}
      : ask why, or discuss a refactoring. It can suggest comments for the pending list.
    </p>
  )
}
