/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { ArrowRightIcon, CheckIcon, CircleAlertIcon, MessageSquareIcon, XIcon } from '@lucide/solid'
import { createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Textarea } from '@/components/ui/input.solid.tsx'
import { cn, errorMessage, plural } from '@/sdk/solid'
import { Address } from '../messages/ui.solid.tsx'
import { Recipient } from '../review/ui.solid.tsx'
import { limits } from './drafts.solid.tsx'
import type { Drafts } from './drafts.solid.tsx'
import type { DraftEdit } from './refs.ts'

export function Footer(props: {
  drafts: Drafts
  edit: (change: DraftEdit) => Promise<unknown>
  to?: ConversationId
  sending: boolean
  error?: string
  onSend: () => void
}) {
  const [noting, setNoting] = createSignal(false)
  const [note, setNote] = createSignal<string>()
  const [failed, setFailed] = createSignal<string>()
  const run = (change: DraftEdit) => {
    setFailed(undefined)
    props.edit(change).catch((failure: unknown) => setFailed(errorMessage(failure)))
  }
  const count = () => props.drafts.comments.length
  const over = () => count() > limits.comments
  return (
    <div
      class="shrink-0 border-t border-border/70 bg-sidebar px-3 py-2 md:px-4"
      data-architect-footer=""
    >
      {(noting() || props.drafts.note) && (
        <Textarea
          aria-label="Overall note"
          class="mb-2 block max-h-40 min-h-12 w-full resize-y rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus:border-brand/50 focus-visible:ring-0"
          onBlur={() => {
            const next = note()
            if (next !== undefined && next !== props.drafts.note) run({ op: 'note', note: next })
            setNote(undefined)
          }}
          onValueChange={setNote}
          placeholder="An overall note (optional)"
          value={note() ?? props.drafts.note}
        />
      )}
      {(props.error || failed()) && (
        <p class="mb-2 flex items-start gap-1.5 font-mono text-[11.5px] text-error" role="alert">
          <CircleAlertIcon class="mt-px size-3.5 shrink-0" />
          <span class="min-w-0 break-words">
            {props.error ? `Not sent: ${props.error}` : `Not saved: ${failed()}`}
          </span>
        </p>
      )}
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span class="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
          <MessageSquareIcon class="size-3.5 text-brand" />
          <span class={cn(over() && 'text-error')}>
            {plural(count(), 'comment')} pending
            {over() && ` · at most ${limits.comments}`}
          </span>
        </span>
        {!noting() && !props.drafts.note && (
          <Button
            aria-label="Add an overall architecture note"
            class="font-mono text-[11.5px] font-normal text-muted-foreground hover:text-foreground"
            onClick={() => setNoting(true)}
            size={null}
            type="button"
            variant={null}
          >
            + note
          </Button>
        )}
        <div class="ml-auto flex min-w-0 items-center gap-1.5">
          <Button
            aria-label="Discard architecture comments"
            data-agent-confirm="Discards all pending architecture comments for this version."
            onClick={() => {
              setNoting(false)
              run({ op: 'clear' })
            }}
            size="xs"
            variant="ghost"
          >
            Discard
          </Button>
          <Recipient onChange={(id) => run({ op: 'to', to: id })} value={props.to} />
          <Button
            disabled={props.sending || over() || props.to === undefined}
            onClick={() => props.onSend()}
            size="xs"
          >
            {props.sending ? 'Sending…' : `Send (${count()})`}
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}

export function Sent(props: {
  conversation: ConversationId
  onOpen: () => void
  onClose: () => void
}) {
  return (
    <output
      class="flex shrink-0 items-center gap-2 border-t border-border/70 bg-sidebar px-3 py-2 font-mono text-[11.5px] md:px-4"
      data-architect-sent=""
    >
      <CheckIcon class="size-3.5 shrink-0 text-success" />
      <span class="shrink-0 text-muted-foreground">Sent to</span>
      <Button
        aria-label={`Open architecture comments recipient #${props.conversation}`}
        class="flex min-w-0 font-normal text-foreground/90 hover:underline"
        onClick={() => props.onOpen()}
        size={null}
        type="button"
        variant={null}
      >
        <Address id={props.conversation} />
      </Button>
      <span class="flex-1" />
      <Button
        aria-label="Dismiss architecture send result"
        class="shrink-0 text-muted-foreground/60 hover:text-foreground"
        onClick={() => props.onClose()}
        size={null}
        type="button"
        variant={null}
      >
        <XIcon class="size-3.5" />
      </Button>
    </output>
  )
}
