import { ArrowRightIcon, CheckIcon, CircleAlertIcon, MessageSquareIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn, plural } from '@/sdk'
import { Address } from '../messages/ui.tsx'
import { Recipient } from '../review/ui.tsx'
import { limits } from './drafts.tsx'
import type { Drafts } from './drafts.tsx'

/**
 * The pending feedback under the diagram, as Review's: its count, an optional overall note, Discard, the recipient and
 * Send (N), and why the last send failed.
 */
export function Footer({
  drafts,
  update,
  to,
  sending,
  error,
  onSend,
}: {
  drafts: Drafts
  update: (change: (drafts: Drafts) => Drafts) => boolean
  to?: number
  sending: boolean
  error?: string
  onSend: () => void
}) {
  const [noting, setNoting] = useState(false)
  const [full, setFull] = useState(false)
  const count = drafts.comments.length
  if (count === 0) return null
  const over = count > limits.comments
  return (
    <div
      className="shrink-0 border-t border-border/70 bg-sidebar px-3 py-2 md:px-4"
      data-architect-footer=""
    >
      {(noting || drafts.note) && (
        <textarea
          aria-label="Overall note"
          className="mb-2 block max-h-40 min-h-12 w-full resize-y rounded-md border border-border/70 bg-background px-2.5 py-1.5 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50 focus:border-brand/50"
          onChange={(event) => {
            const note = event.target.value
            setFull(!update((all) => ({ ...all, note })))
          }}
          placeholder="An overall note (optional)"
          value={drafts.note}
        />
      )}
      {full && (
        <p className="mb-2 font-mono text-[11.5px] text-error" role="alert">
          Too long to keep as a draft: shorten the note, or send first
        </p>
      )}
      {error && (
        <p
          className="mb-2 flex items-start gap-1.5 font-mono text-[11.5px] text-error"
          role="alert"
        >
          <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0 break-words">Not sent: {error}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-muted-foreground">
          <MessageSquareIcon className="size-3.5 text-brand" />
          <span className={cn(over && 'text-error')}>
            {plural(count, 'comment')} pending
            {over && ` · at most ${limits.comments}`}
          </span>
        </span>
        {!noting && !drafts.note && (
          <button
            className="cursor-pointer font-mono text-[11.5px] text-muted-foreground hover:text-foreground"
            onClick={() => setNoting(true)}
            type="button"
          >
            + note
          </button>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <Button
            onClick={() => {
              setNoting(false)
              update((all) => ({ ...all, comments: [], note: '' }))
            }}
            size="xs"
            variant="ghost"
          >
            Discard
          </Button>
          <Recipient onChange={(id) => update((all) => ({ ...all, to: id }))} value={to} />
          <Button disabled={sending || over || to === undefined} onClick={onSend} size="xs">
            {sending ? 'Sending…' : `Send (${count})`}
            <ArrowRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Where the last feedback went, with a link to its conversation. */
export function Sent({
  conversation,
  onOpen,
  onClose,
}: {
  conversation: number
  onOpen: () => void
  onClose: () => void
}) {
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-t border-border/70 bg-sidebar px-3 py-2 font-mono text-[11.5px] md:px-4"
      data-architect-sent=""
      role="status"
    >
      <CheckIcon className="size-3.5 shrink-0 text-success" />
      <span className="shrink-0 text-muted-foreground">Sent to</span>
      <button
        className="flex min-w-0 cursor-pointer text-foreground/90 hover:underline"
        onClick={onOpen}
        type="button"
      >
        <Address id={conversation} />
      </button>
      <span className="flex-1" />
      <button
        aria-label="Dismiss"
        className="shrink-0 cursor-pointer text-muted-foreground/60 hover:text-foreground"
        onClick={onClose}
        type="button"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
