import {
  CheckIcon,
  ChevronDownIcon,
  GitCompareArrowsIcon,
  LoaderIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
  WorkflowIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  errorMessage,
  formatAgo,
  useConversations,
  useConversationSummary,
  useDocOf,
  useNow,
  useUltimate,
  useViewport,
} from '@/sdk'
import { ConversationRef } from '../conversations/ui.tsx'
import { Canvas, Composer, popoverAt } from './canvas.tsx'
import { ChatPanel, DiscussButton } from './chat.tsx'
import type { Writing } from './canvas.tsx'
import { useDrafts, where } from './drafts.tsx'
import type { Draft, Drafts } from './drafts.tsx'
import { Footer, Sent } from './footer.tsx'
import { clearMark, useChatOpen, useMark, useView } from './link.tsx'
import type { View } from './link.tsx'
import { Frame, Legend, Loading, Notice } from './frame.tsx'
import { changeCounts, changes } from './parts.tsx'
import { ArchitectureDoc, ArchitectureIndexDoc, DrawAction, SendAction } from './refs.ts'
import type { ArchitectureDiagram, ArchitectureVersion } from './refs.ts'

const tone = { added: 'bg-diff-add', changed: 'bg-warning', removed: 'bg-diff-del' } as const

/** The branch to show without a choice: the shown conversation (or the branch its architect draws), else the latest. */
function useDefaultBranch(branches: Record<string, { version: number; at: string }>) {
  const { conversationId } = useUltimate()
  const shown = useConversationSummary(conversationId)
  const own =
    shown?.label === 'architect' && shown.parentConversationId !== undefined
      ? shown.parentConversationId
      : conversationId
  if (own !== undefined && branches[own]) return own
  return Object.entries(branches)
    .toSorted(([, a], [, b]) => b.at.localeCompare(a.at))
    .map(([id]) => Number(id))[0]
}

/** The branch on screen as a button; it opens every branch with versions, newest first, to filter. */
function BranchPicker({
  branch,
  branches,
  onChange,
}: {
  branch: number
  branches: Record<string, { version: number; at: string }>
  onChange: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const conversations = useConversations()
  const now = useNow(60_000, open)
  const title = (id: number) => conversations.find((c) => c.id === id)?.title
  const needle = query.trim().toLowerCase()
  const list = Object.entries(branches)
    .map(([id, entry]) => ({ id: Number(id), ...entry }))
    .toSorted((a, b) => b.at.localeCompare(a.at))
    .filter(
      (item) =>
        !needle || `#${item.id}`.includes(needle) || title(item.id)?.toLowerCase().includes(needle),
    )
  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          className="flex h-7 max-w-80 min-w-0 shrink cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border max-md:max-w-28 border-border/70 px-2 text-[12.5px] hover:bg-accent/60"
          data-architect-branch={branch}
          title="Choose a branch"
          type="button"
        >
          <span className="flex min-w-0 text-foreground/90">
            <ConversationRef id={branch} />
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(28rem,calc(100vw-1rem))] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            className="font-mono text-[12.5px]"
            onValueChange={setQuery}
            placeholder="Branches with diagrams…"
            value={query}
          />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty className="py-6 text-center text-[12px] text-muted-foreground">
              No branch matches.
            </CommandEmpty>
            <CommandGroup>
              {list.map((item) => (
                <CommandItem
                  className="gap-2 py-1 text-[12.5px]"
                  key={item.id}
                  onSelect={() => {
                    setOpen(false)
                    setQuery('')
                    onChange(item.id)
                  }}
                  value={String(item.id)}
                >
                  <span className={cn('flex min-w-0 flex-1', item.id === branch && 'text-brand')}>
                    <ConversationRef id={item.id} />
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    v{item.version} · {formatAgo(Date.parse(item.at), now)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** A version picker: `label` on the button, the versions newest first in its menu, `none` to clear when given. */
function VersionMenu({
  label,
  title,
  versions,
  current,
  onPick,
  none,
  icon,
}: {
  label: ReactNode
  title: string
  versions: ArchitectureVersion[]
  current?: number
  onPick: (version: number | undefined) => void
  none?: string
  icon?: ReactNode
}) {
  const now = useNow(60_000)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[11.5px] hover:bg-accent/60',
          current === undefined ? 'text-muted-foreground' : 'text-foreground/90',
        )}
        title={title}
      >
        {icon}
        {label}
        <ChevronDownIcon className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-72 overflow-y-auto">
        {none && (
          <DropdownMenuItem
            className="font-mono text-[12px] text-muted-foreground"
            onSelect={() => onPick(undefined)}
          >
            {none}
          </DropdownMenuItem>
        )}
        {versions.toReversed().map((version) => (
          <DropdownMenuItem
            className="items-start gap-2 text-[12.5px]"
            key={version.version}
            onSelect={() => onPick(version.version)}
          >
            <span
              className={cn(
                'w-6 shrink-0 font-mono text-[11.5px]',
                version.version === current ? 'text-brand' : 'text-muted-foreground',
              )}
            >
              v{version.version}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{version.title}</span>
              <span className="block font-mono text-[10.5px] text-muted-foreground">
                {formatAgo(Date.parse(version.at), now, { ago: true })} ·{' '}
                {version.diagrams.length
                  ? `${version.diagrams.length} diagram${version.diagrams.length === 1 ? '' : 's'}`
                  : 'no change'}
              </span>
            </span>
            {version.version === current && <CheckIcon className="mt-0.5 size-3.5 text-brand" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Draw, or that the architect is drawing now. */
function Draw({ branch, architect }: { branch: number; architect?: number }) {
  const busy = useConversationSummary(architect)?.busy ?? false
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string>()
  const drawing = busy || asking
  return (
    <Button
      className="font-mono"
      disabled={drawing}
      onClick={() => {
        setAsking(true)
        setError(undefined)
        api
          .action(DrawAction, { conversation: branch })
          .catch((failure: unknown) => setError(errorMessage(failure)))
          .finally(() => setAsking(false))
      }}
      size="xs"
      title={error ? `Draw failed: ${error}` : 'Have the architect draw a new version'}
      variant="outline"
    >
      {drawing ? <LoaderIcon className="animate-spin" /> : <SparklesIcon />}
      {drawing ? 'drawing…' : error ? 'retry draw' : 'Draw'}
    </Button>
  )
}

/** The version's diagrams as a list, each with its change counts; the chosen one's notes and pending comments below. */
function DiagramList({
  diagrams,
  current,
  drafts,
  onPick,
  onEdit,
  onDelete,
}: {
  diagrams: ArchitectureDiagram[]
  current: ArchitectureDiagram
  drafts: Drafts
  onPick: (id: string) => void
  onEdit: (draft: Draft) => void
  onDelete: (draft: Draft) => void
}) {
  const mine = drafts.comments.filter((draft) => draft.diagram === current.id)
  return (
    <nav className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border/70 bg-sidebar py-1.5">
      {diagrams.map((diagram) => {
        const counts = changeCounts(diagram.mermaid)
        const pending = drafts.comments.filter((draft) => draft.diagram === diagram.id).length
        return (
          <button
            aria-current={diagram.id === current.id}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-[12.5px] hover:bg-accent/60',
              diagram.id === current.id ? 'bg-accent/70 text-foreground' : 'text-foreground/80',
            )}
            data-architect-diagram={diagram.id}
            key={diagram.id}
            onClick={() => onPick(diagram.id)}
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">{diagram.title}</span>
            {pending > 0 && (
              <span className="flex items-center gap-0.5 font-mono text-[10.5px] text-brand">
                <MessageSquareIcon className="size-3" />
                {pending}
              </span>
            )}
            <span className="flex shrink-0 items-center gap-0.5">
              {changes
                .filter((change) => counts[change] > 0)
                .map((change) => (
                  <span
                    className={cn('size-1.5 rounded-full', tone[change])}
                    key={change}
                    title={`${counts[change]} ${change}`}
                  />
                ))}
            </span>
          </button>
        )
      })}
      {current.notes.length > 0 && (
        <section className="mt-3 border-t border-border/60 px-3 pt-2.5">
          <h3 className="mb-1 section-label">notes</h3>
          <ul className="space-y-1.5 text-[12.5px] leading-snug text-foreground/85">
            {current.notes.map((note) => (
              <li className="flex gap-1.5" key={note}>
                <span className="text-muted-foreground/60">–</span>
                <span className="min-w-0">{note}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {mine.length > 0 && (
        <section className="mt-3 border-t border-border/60 px-3 pt-2.5">
          <h3 className="mb-1 section-label">pending</h3>
          <ul className="space-y-1.5">
            {mine.map((draft) => (
              <PendingItem
                draft={draft}
                key={draft.id}
                onDelete={() => onDelete(draft)}
                onEdit={() => onEdit(draft)}
              />
            ))}
          </ul>
        </section>
      )}
    </nav>
  )
}

function PendingItem({
  draft,
  onEdit,
  onDelete,
}: {
  draft: Draft
  onEdit: () => void
  onDelete: () => void
}) {
  return (
    <li
      className={cn(
        'group/draft rounded-md border border-border/70 border-l-2 bg-muted/30 px-2 py-1',
        draft.by === undefined ? 'border-l-brand/50' : 'border-dashed border-l-brand/50',
      )}
      data-architect-draft-item={draft.id}
      data-architect-suggested={draft.by}
    >
      <div className="flex items-center gap-1.5">
        {draft.by !== undefined && <Suggested />}
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
          {where(draft)}
        </span>
        <span className="flex items-center opacity-0 transition-opacity group-hover/draft:opacity-100 pointer-coarse:opacity-100">
          <button
            aria-label="Edit comment"
            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onEdit}
            type="button"
          >
            <PencilIcon className="size-3" />
          </button>
          <button
            aria-label="Delete comment"
            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-error"
            onClick={onDelete}
            type="button"
          >
            <Trash2Icon className="size-3" />
          </button>
        </span>
      </div>
      <p className="line-clamp-3 text-[12px] leading-snug whitespace-pre-wrap text-foreground/90">
        {draft.text}
      </p>
    </li>
  )
}

/** The mark of a comment the architecture chat suggested: the user's to keep, edit or delete. */
function Suggested() {
  return (
    <span
      className="flex shrink-0 items-center gap-0.5 rounded-sm bg-brand/12 px-1 font-mono text-[10px] text-brand"
      title="Suggested by the architecture chat"
    >
      <MessagesSquareIcon className="size-2.5" />
      chat
    </span>
  )
}

/** The diagram's title, a click away from a comment on the whole diagram, with its pending count. */
function DiagramTitle({
  diagram,
  version,
  onComment,
}: {
  diagram: ArchitectureDiagram
  version?: number
  onComment?: (at: { x: number; y: number }) => void
}) {
  return (
    <div className="mb-3 flex min-w-0 items-center gap-2">
      {version !== undefined && (
        <span className="shrink-0 rounded border border-border/70 px-1 font-mono text-[10.5px] text-muted-foreground">
          v{version}
        </span>
      )}
      {onComment ? (
        <button
          className="group/title flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-[13px] font-medium hover:text-brand"
          data-architect-title={diagram.id}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            const frame = event.currentTarget.closest('[data-architect-stage]')
            const origin = frame?.getBoundingClientRect()
            onComment({
              x: box.left - (origin?.left ?? 0) + 24,
              y: box.bottom - (origin?.top ?? 0) - 6,
            })
          }}
          title="Comment on the whole diagram"
          type="button"
        >
          <span className="truncate">{diagram.title}</span>
          <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 pointer-coarse:opacity-60" />
        </button>
      ) : (
        <span className="truncate text-[13px] font-medium text-muted-foreground">
          {diagram.title}
        </span>
      )}
    </div>
  )
}

/** A version with no diagrams: nothing architectural changed, calmly. */
function Unchanged({ version, previous }: { version: ArchitectureVersion; previous?: number }) {
  const now = useNow(60_000)
  return (
    <div className="flex flex-1 items-center justify-center p-6" data-architect-unchanged="">
      <div className="max-w-md text-center">
        <WorkflowIcon className="mx-auto mb-3 size-6 text-muted-foreground/50" />
        <p className="text-[14px] text-foreground/90">Nothing architectural changed</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground first-letter:uppercase">
          {version.summary.replace(/^Nothing architectural changed[:.,;\s–-]*/i, '') ||
            version.summary}
        </p>
        <p className="mt-3 font-mono text-[11px] text-muted-foreground/70">
          v{version.version} · {formatAgo(Date.parse(version.at), now, { ago: true })}
          {previous !== undefined && ` · v${previous} has diagrams`}
        </p>
      </div>
    </div>
  )
}

/** The Architecture surface: a branch's diagrams, one at a time, with comments on their parts. */
export default function ArchitectureSurface() {
  const index = useDocOf(1, ArchitectureIndexDoc)
  const branches = index?.branches ?? {}
  const [view, setView] = useView()
  const fallback = useDefaultBranch(branches)
  const branch = view.branch ?? fallback
  const doc = useDocOf(branch, ArchitectureDoc)
  const versions = doc?.versions ?? []
  const latest = versions.at(-1)
  const version = versions.find((item) => item.version === view.version) ?? latest
  const compare =
    view.compare !== undefined && view.compare !== version?.version
      ? versions.find((item) => item.version === view.compare)
      : undefined
  const change = (next: Partial<View>) => setView((previous) => ({ ...previous, ...next }))
  const phone = useViewport() === 'phone'
  const now = useNow(60_000)
  const [chatting, setChat] = useChatOpen()
  if (!index || (branch !== undefined && !doc))
    return (
      <Frame>
        <Loading />
      </Frame>
    )
  if (branch === undefined)
    return (
      <Frame>
        <NoBranch />
      </Frame>
    )
  return (
    <Frame
      controls={
        <>
          <BranchPicker
            branch={branch}
            branches={branches}
            onChange={(id) => setView({ branch: id })}
          />
          {version && (
            <VersionMenu
              current={version.version}
              label={
                <>
                  v{version.version}
                  <span className="text-muted-foreground max-md:hidden">
                    {' '}
                    · {formatAgo(Date.parse(version.at), now, { ago: true })}
                  </span>
                </>
              }
              onPick={(next) => change({ version: next === latest?.version ? undefined : next })}
              title="Choose a version"
              versions={versions}
            />
          )}
          {versions.length > 1 && version && version.diagrams.length > 0 && (
            <VersionMenu
              current={compare?.version}
              icon={<GitCompareArrowsIcon className="size-3.5" />}
              label={
                compare ? `v${compare.version}` : <span className="max-md:hidden">compare</span>
              }
              none={compare ? 'Stop comparing' : undefined}
              onPick={(next) => change({ compare: next })}
              title="Compare with another version"
              versions={versions.filter((item) => item.version !== version.version)}
            />
          )}
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border/70" />
          <Draw architect={doc?.architect} branch={branch} />
          {latest && (
            <DiscussButton branch={branch} onToggle={() => setChat(!chatting)} open={chatting} />
          )}
        </>
      }
    >
      {version ? (
        <Version
          branch={branch}
          compare={compare}
          key={`${branch}:${version.version}`}
          phone={phone}
          previous={
            versions.findLast((item) => item.version < version.version && item.diagrams.length > 0)
              ?.version
          }
          version={version}
          view={view}
          onView={change}
        />
      ) : (
        <Notice>No versions yet: Draw asks the architect for the first.</Notice>
      )}
      {chatting && latest && (
        <ChatPanel
          branch={branch}
          latest={latest.version}
          onClose={() => setChat(false)}
          phone={phone}
        />
      )}
    </Frame>
  )
}

function NoBranch() {
  const { conversationId } = useUltimate()
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-md text-center">
        <WorkflowIcon className="mx-auto mb-3 size-6 text-muted-foreground/50" />
        <p className="text-[14px] text-foreground/90">No architecture drawn yet</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          A coordinator has its architect draw once its plan is set. You can ask for one now for the
          conversation on screen.
        </p>
        {conversationId !== undefined && (
          <div className="mt-4 flex justify-center">
            <Draw branch={conversationId} />
          </div>
        )}
      </div>
    </div>
  )
}

/** One version: its summary, diagram list, the chosen diagram (beside its comparison), legend and footer. */
function Version({
  branch,
  version,
  compare,
  previous,
  phone,
  view,
  onView,
}: {
  branch: number
  version: ArchitectureVersion
  compare?: ArchitectureVersion
  previous?: number
  phone: boolean
  view: View
  onView: (next: Partial<View>) => void
}) {
  const [drafts, edit] = useDrafts(branch, version.version)
  const to = drafts.to ?? branch
  const [writing, setWriting] = useState<Writing>()
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ conversation: number } | { error: string }>()
  // A comparison flips between the two versions in place, at full size, where a change stands out; `both` puts them
  // side by side (not on a phone: too narrow).
  const [showing, setShowing] = useState<'this' | 'other' | 'both'>('this')
  const mark = useMark()
  const stage = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(800)
  const { switchConversation, showSurface } = useUltimate()
  useEffect(() => {
    const element = stage.current
    if (!element) return undefined
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => setShowing('this'), [compare?.version])
  const diagram = version.diagrams.find((item) => item.id === view.diagram) ?? version.diagrams[0]
  if (!diagram) return <Unchanged previous={previous} version={version} />
  const other = compare?.diagrams.find((item) => item.id === diagram.id)
  const pick = (id: string) => {
    setWriting(undefined)
    clearMark()
    onView({ diagram: id })
  }
  const editing = writing?.id ? drafts.comments.find((draft) => draft.id === writing.id) : undefined
  const save = async (text: string) => {
    if (!writing) return
    const { part } = writing
    if (editing) await edit({ op: 'update', id: editing.id, text })
    else
      await edit({
        op: 'add',
        comment: {
          diagram: diagram.id,
          kind: part.kind,
          ...(part.kind === 'diagram' ? {} : { part: part.part }),
          label: part.label,
          text,
        },
      })
    setWriting(undefined)
  }
  const send = async () => {
    setSending(true)
    setSent(undefined)
    try {
      setSent(await api.action(SendAction, { branch, version: version.version }))
    } catch (failure) {
      setSent({ error: errorMessage(failure) })
    } finally {
      setSending(false)
    }
  }
  const mode = compare ? (phone && showing === 'both' ? 'this' : showing) : 'this'
  const side = mode === 'both' && compare !== undefined
  const shown = mode === 'other' ? undefined : diagram
  const composer = writing && (
    <div className="absolute z-20" style={popoverAt(writing.x, writing.y, width)}>
      <Composer
        initial={editing?.text}
        key={writing.id ?? `${writing.part.kind}:${writing.part.part}`}
        label={
          writing.part.kind === 'diagram'
            ? undefined
            : (diagram.parts[writing.part.part] ?? writing.part.label)
        }
        onCancel={() => setWriting(undefined)}
        onSubmit={save}
        submit={editing ? 'Save' : 'Add'}
        title={
          writing.part.kind === 'diagram'
            ? diagram.title
            : writing.part.kind === 'edge'
              ? 'edge'
              : `${writing.part.kind} ${writing.part.part}`
        }
      />
    </div>
  )
  const startWriting = (next: Writing) => {
    clearMark()
    // A part with a draft opens that draft to edit.
    const existing = drafts.comments.find(
      (draft) =>
        draft.diagram === diagram.id &&
        draft.kind === next.part.kind &&
        (draft.kind === 'diagram' || draft.part === next.part.part),
    )
    setWriting(existing ? { ...next, id: existing.id } : next)
  }
  const footer =
    drafts.comments.length > 0 ? (
      <Footer
        drafts={drafts}
        error={sent && 'error' in sent ? sent.error : undefined}
        onSend={() => void send()}
        sending={sending}
        edit={edit}
        to={to}
      />
    ) : sent && !('error' in sent) ? (
      <Sent
        conversation={sent.conversation}
        onClose={() => setSent(undefined)}
        onOpen={() => {
          switchConversation(sent.conversation)
          showSurface('agent')
        }}
      />
    ) : null
  return (
    <>
      {!phone && (
        <DiagramList
          current={diagram}
          diagrams={version.diagrams}
          drafts={drafts}
          onDelete={(draft) => edit({ op: 'delete', id: draft.id })}
          onEdit={(draft) => setWriting({ part: partOf(draft), x: 24, y: 24, id: draft.id })}
          onPick={pick}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border/70 px-3 py-2 md:px-4">
          <p className="truncate text-[13px] text-foreground/90" title={version.title}>
            {version.title}
          </p>
          <p className="text-[12px] leading-snug text-muted-foreground max-md:line-clamp-2">
            {version.summary}
          </p>
        </div>
        {phone && <PhoneDiagrams current={diagram} diagrams={version.diagrams} onPick={pick} />}
        <div
          className="relative min-h-0 flex-1 overflow-auto p-3 md:p-5"
          data-architect-stage=""
          onClick={(event) => {
            if (event.target === event.currentTarget) setWriting(undefined)
          }}
          ref={stage}
        >
          {compare && (
            <div className="mb-3 flex w-fit items-center rounded-md border border-border/70 p-0.5">
              {(
                [
                  ['other', `v${compare.version}`],
                  ['this', `v${version.version}`],
                  ...(phone ? [] : [['both', 'both'] as const]),
                ] as const
              ).map(([name, label]) => (
                <button
                  aria-pressed={mode === name}
                  className={cn(
                    'h-6 cursor-pointer rounded-sm px-2 font-mono text-[11px] text-muted-foreground transition-colors',
                    mode === name ? 'bg-accent text-foreground' : 'hover:text-foreground',
                  )}
                  data-architect-showing={name}
                  key={name}
                  onClick={() => {
                    setWriting(undefined)
                    setShowing(name)
                  }}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className={cn(side && 'grid grid-cols-2 gap-4')}>
            {side && compare && (
              <div className="min-w-0 rounded-md border border-dashed border-border/70 p-3">
                <Compared diagram={other} version={compare.version} />
              </div>
            )}
            {shown ? (
              <div className={cn('min-w-0', side && 'rounded-md border border-border/70 p-3')}>
                <DiagramTitle
                  diagram={shown}
                  onComment={(at) =>
                    startWriting({
                      part: { kind: 'diagram', part: '', label: shown.title },
                      ...at,
                    })
                  }
                  version={compare ? version.version : undefined}
                />
                <Canvas
                  diagram={shown}
                  fit={!phone}
                  drafts={drafts.comments.filter((draft) => draft.diagram === shown.id)}
                  marked={mark && view.diagram === shown.id ? mark : undefined}
                  onPick={(part, at) => {
                    const box = stage.current?.getBoundingClientRect()
                    const canvas = stage.current
                      ?.querySelector(`[data-architect-canvas="${CSS.escape(shown.id)}"]`)
                      ?.parentElement?.getBoundingClientRect()
                    startWriting({
                      part,
                      x:
                        at.x +
                        (canvas?.left ?? 0) -
                        (box?.left ?? 0) +
                        (stage.current?.scrollLeft ?? 0),
                      y:
                        at.y +
                        (canvas?.top ?? 0) -
                        (box?.top ?? 0) +
                        (stage.current?.scrollTop ?? 0),
                    })
                  }}
                  svgId={`architect-${shown.id}-v${version.version}`}
                />
              </div>
            ) : (
              compare && <Compared diagram={other} fit={!phone} version={compare.version} />
            )}
          </div>
          {composer}
        </div>
        <Legend />
        {footer}
      </div>
    </>
  )
}

const partOf = (draft: Draft) => ({
  kind: draft.kind,
  part: draft.part ?? '',
  label: draft.label,
})

/** The same diagram in the version compared with, read-only, or that it has none. */
function Compared({
  diagram,
  version,
  fit = true,
}: {
  diagram?: ArchitectureDiagram
  version: number
  fit?: boolean
}) {
  if (!diagram)
    return (
      <p className="py-10 text-center font-mono text-[11.5px] text-muted-foreground/70">
        v{version} has no such diagram
      </p>
    )
  return (
    <div className="min-w-0 opacity-90">
      <DiagramTitle diagram={diagram} version={version} />
      <Canvas diagram={diagram} fit={fit} svgId={`architect-${diagram.id}-v${version}-compare`} />
    </div>
  )
}

/** The diagram list as a row of tabs, on a phone. */
function PhoneDiagrams({
  diagrams,
  current,
  onPick,
}: {
  diagrams: ArchitectureDiagram[]
  current: ArchitectureDiagram
  onPick: (id: string) => void
}) {
  return (
    <div className="shrink-0 border-b border-border/70 bg-sidebar">
      <div className="flex gap-1 overflow-x-auto px-2 py-1.5">
        {diagrams.map((diagram) => (
          <button
            aria-current={diagram.id === current.id}
            className={cn(
              'h-6 shrink-0 cursor-pointer rounded-md px-2 text-[12px]',
              diagram.id === current.id
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            key={diagram.id}
            onClick={() => onPick(diagram.id)}
            type="button"
          >
            {diagram.title}
          </button>
        ))}
      </div>
      {current.notes.length > 0 && (
        <ul className="space-y-0.5 px-3 pb-2 text-[12px] leading-snug text-muted-foreground">
          {current.notes.map((note) => (
            <li key={note}>– {note}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
