import { LoaderIcon, MessagesSquareIcon, RotateCwIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  api,
  cn,
  Conversation,
  ConversationScope,
  errorMessage,
  useConversationSummary,
  useDocOf,
} from '@/sdk'
import { ChatAction, ChatDoc } from './refs.ts'

/** Whether the branch's chat is working, for the header button's dot while the panel is closed. */
export function useChatBusy(branch: number) {
  const chat = useDocOf(branch, ChatDoc)
  return useConversationSummary(chat?.id)?.busy ?? false
}

/** The header button that opens and closes the architecture chat. */
export function DiscussButton({
  branch,
  open,
  onToggle,
}: {
  branch: number
  open: boolean
  onToggle: () => void
}) {
  const busy = useChatBusy(branch)
  return (
    <Button
      aria-pressed={open}
      className={cn('relative font-mono', open && 'bg-accent text-foreground')}
      data-architect-discuss=""
      onClick={onToggle}
      size="xs"
      title={open ? 'Close the architecture chat' : 'Discuss the architecture with its architect'}
      variant="outline"
    >
      <MessagesSquareIcon />
      <span className="max-md:hidden">Discuss</span>
      {busy && !open && (
        <span className="absolute -top-0.5 -right-0.5 size-1.5 animate-pulse-dot rounded-full bg-brand" />
      )}
    </Button>
  )
}

/**
 * The architecture chat beside the diagrams: a copy of the branch's architect at its latest answer, made on first open.
 * It answers questions, sketches alternatives, and suggests comments into the pending list of the version it was opened
 * at. A newer version offers a new chat on it.
 */
export function ChatPanel({
  branch,
  latest,
  phone,
  onClose,
}: {
  branch: number
  latest: number
  phone: boolean
  onClose: () => void
}) {
  const chat = useDocOf(branch, ChatDoc)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string>()
  const start = (fresh: boolean) => {
    setStarting(true)
    setError(undefined)
    api
      .action(ChatAction, { branch, ...(fresh && { fresh }) })
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setStarting(false))
  }
  // Made lazily: the first open asks for it, once the branch's document has said there is none.
  const missing = chat !== undefined && chat?.id === undefined
  useEffect(() => {
    if (missing) start(false)
    // `start` is a new function each render; only a missing chat calls it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, branch])
  const stale = chat?.version !== undefined && chat.version < latest
  return (
    <aside
      aria-label="Architecture chat"
      className={cn(
        'flex flex-col bg-background',
        phone
          ? 'absolute inset-0 z-30'
          : 'relative w-[clamp(20rem,32vw,28rem)] shrink-0 border-l border-border/70',
      )}
      data-architect-chat={chat?.id}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/70 pr-1 pl-3 font-mono text-[11.5px] text-muted-foreground">
        <MessagesSquareIcon className="size-3.5 shrink-0 text-brand" />
        <span className="text-foreground/90">architecture chat</span>
        {chat?.version !== undefined && <span className="shrink-0">· on v{chat.version}</span>}
        <span className="flex-1" />
        {chat?.id !== undefined && !stale && (
          <button
            aria-label="New chat"
            className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground disabled:opacity-50"
            disabled={starting}
            onClick={() => start(true)}
            title="Start over: a new copy of the architect"
            type="button"
          >
            <RotateCwIcon className="size-3.5" />
          </button>
        )}
        <button
          aria-label="Close the chat"
          className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
          onClick={onClose}
          title={phone ? 'Back to the diagram' : 'Close the chat'}
          type="button"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {stale && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="min-w-0 flex-1">
            Opened at v{chat.version}; v{latest} is newer.
          </span>
          <Button disabled={starting} onClick={() => start(true)} size="xs" variant="outline">
            {starting && <LoaderIcon className="animate-spin" />}
            New chat on v{latest}
          </Button>
        </div>
      )}
      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="font-mono text-[11.5px] break-words text-error">{error}</p>
          <Button onClick={() => start(chat?.id !== undefined)} size="xs" variant="outline">
            Try again
          </Button>
        </div>
      ) : chat?.id === undefined || (starting && !stale) ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
          <p className="text-[12.5px] text-muted-foreground">Copying the architect…</p>
        </div>
      ) : (
        <ConversationScope id={chat.id} key={chat.id}>
          <Intro version={chat.version} />
          <Conversation variant="dock" />
        </ConversationScope>
      )}
    </aside>
  )
}

/** What the chat knows and can do, above its transcript. */
function Intro({ version }: { version?: number }) {
  return (
    <p className="shrink-0 border-b border-border/40 px-3 py-2 text-[12px] leading-snug text-muted-foreground">
      A copy of the architect that drew {version === undefined ? 'this' : `v${version}`}: ask why,
      or discuss a refactoring. It can suggest comments for the pending list.
    </p>
  )
}
