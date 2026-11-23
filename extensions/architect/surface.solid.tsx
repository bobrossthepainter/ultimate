import { parseConversationId } from '../../lib/ids.ts'
import type { ConversationId } from '@earendil-works/pi-durable'
import {
  CheckIcon,
  ChevronDownIcon,
  CodeIcon,
  GitCompareArrowsIcon,
  LoaderIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PencilIcon,
  SparklesIcon,
  Trash2Icon,
  WorkflowIcon,
} from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onSettled,
  Show,
  Switch,
} from 'solid-js'
import type { Accessor } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command.solid.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.solid.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.solid.tsx'
import { Toggle, ToggleGroup } from '@/components/ui/toggle.solid.tsx'
import {
  api,
  cn,
  errorMessage,
  formatAgo,
  ROOT,
  showSurface,
  switchConversation,
  useConversationId,
  useConversations,
  useConversationSummary,
  useDocOf,
  useNow,
  useViewport,
  writerNow,
  writingAs,
} from '@/sdk/solid'
import { ConversationRef } from '../conversations/ui.solid.tsx'
import { branchOf, useNotDrawable } from './branch.solid.tsx'
import { Canvas, Composer, popoverAt } from './canvas.solid.tsx'
import type { Writing } from './canvas.solid.tsx'
import { ChatPanel, DiscussButton } from './chat.solid.tsx'
import { PartSource } from './code.solid.tsx'
import { useDrafts, where } from './drafts.solid.tsx'
import type { Draft, Drafts } from './drafts.solid.tsx'
import { Footer, Sent } from './footer.solid.tsx'
import { Frame, Legend, Loading, Notice } from './frame.solid.tsx'
import { clearMark, useChatOpen, useMark, useView } from './link.solid.tsx'
import type { View } from './link.solid.tsx'
import { changeCounts, changes } from './parts.solid.tsx'
import { ArchitectureDoc, ArchitectureIndexDoc, AskAction, DrawAction, SendAction } from './refs.ts'
import type { ArchitectureDiagram, ArchitectureVersion } from './refs.ts'

const tone = { added: 'bg-diff-add', changed: 'bg-warning', removed: 'bg-diff-del' } as const

type Branches = Record<string, { version: number; at: string }>

function useShownBranch() {
  const id = useConversationId()
  const shown = useConversationSummary(id)
  return () => {
    const current = id()
    return current === undefined ? undefined : branchOf(shown(), current)
  }
}

function BranchPicker(props: {
  branch: ConversationId
  branches: Branches
  onChange: (id: ConversationId) => void
}) {
  const [open, setOpen] = createSignal(false)
  const [query, setQuery] = createSignal('')
  const [highlight, setHighlight] = createSignal<string>()
  const conversations = useConversations()
  const now = useNow(60_000, open)
  const title = (id: number) => conversations().find((c) => c.id === id)?.title
  const list = createMemo(() => {
    const needle = query().trim().toLowerCase()
    return Object.entries(props.branches)
      .map(([id, entry]) => ({ id: parseConversationId(Number(id)), ...entry }))
      .toSorted((a, b) => b.at.localeCompare(a.at))
      .filter(
        (item) =>
          !needle ||
          `#${item.id}`.includes(needle) ||
          title(item.id)?.toLowerCase().includes(needle),
      )
  })
  const startAt = () => {
    const first = list()[0]
    return first === undefined ? undefined : String(first.id)
  }
  const changeQuery = (next: string) => {
    setQuery(next)
    setHighlight(undefined)
  }
  return (
    <Popover onOpenChange={setOpen} open={open()}>
      <PopoverTrigger
        aria-label="Choose an architecture branch"
        class="flex h-7 max-w-80 min-w-0 shrink items-center gap-1.5 overflow-hidden rounded-md border border-border/70 px-2 text-[12.5px] hover:bg-accent/60 max-md:max-w-28"
        data-architect-branch={props.branch}
        title="Choose a branch"
      >
        <span class="flex min-w-0 text-foreground/90">
          <ConversationRef id={props.branch} />
        </span>
        <ChevronDownIcon class="size-3 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align="start" class="w-[min(28rem,calc(100vw-1rem))] p-0">
        <Command
          autoHighlight={false}
          filter={false}
          onAction={(value) => {
            const item = list().find((entry) => String(entry.id) === value)
            if (!item) return
            setOpen(false)
            changeQuery('')
            props.onChange(item.id)
          }}
          onQueryChange={changeQuery}
          onValueChange={setHighlight}
          query={query()}
          value={highlight() ?? startAt()}
        >
          <CommandInput
            aria-label="Find a branch with diagrams"
            class="font-mono text-[12.5px]"
            placeholder="Branches with diagrams…"
          />
          <CommandList class="max-h-[60vh]">
            <Show when={!list().length}>
              <CommandEmpty class="py-6 text-center text-[12px] text-muted-foreground">
                No branch matches.
              </CommandEmpty>
            </Show>
            <CommandGroup>
              <For each={list()} keyed={(item) => item.id}>
                {(item) => (
                  <CommandItem
                    aria-label={`Show architecture of #${item().id}`}
                    class="gap-2 py-1 text-[12.5px]"
                    value={String(item().id)}
                  >
                    <span
                      class={cn('flex min-w-0 flex-1', item().id === props.branch && 'text-brand')}
                    >
                      <ConversationRef id={item().id} />
                    </span>
                    <span class="shrink-0 font-mono text-[11px] text-muted-foreground">
                      v{item().version} · {formatAgo(Date.parse(item().at), now())}
                    </span>
                  </CommandItem>
                )}
              </For>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function VersionMenu(props: {
  label: JSX.Element
  name: string
  title: string
  versions: ArchitectureVersion[]
  current?: number
  onPick: (version: number | undefined) => void
  none?: string
  icon?: JSX.Element
}) {
  const now = useNow(60_000)
  return (
    <DropdownMenu onAction={(value) => props.onPick(value === 'none' ? undefined : Number(value))}>
      <DropdownMenuTrigger
        aria-label={props.name}
        class={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2 font-mono text-[11.5px] hover:bg-accent/60',
          props.current === undefined ? 'text-muted-foreground' : 'text-foreground/90',
        )}
        title={props.title}
      >
        {props.icon}
        {props.label}
        <ChevronDownIcon class="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" class="max-h-[60vh] w-72 overflow-y-auto">
        <Show when={props.none}>
          {(none) => (
            <DropdownMenuItem class="font-mono text-[12px] text-muted-foreground" value="none">
              {none()}
            </DropdownMenuItem>
          )}
        </Show>
        <For each={props.versions.toReversed()} keyed={(version) => version.version}>
          {(version) => (
            <DropdownMenuItem
              class="items-start gap-2 text-[12.5px]"
              value={String(version().version)}
            >
              <span
                class={cn(
                  'w-6 shrink-0 font-mono text-[11.5px]',
                  version().version === props.current ? 'text-brand' : 'text-muted-foreground',
                )}
              >
                v{version().version}
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate">{version().title}</span>
                <span class="block font-mono text-[10.5px] text-muted-foreground">
                  {formatAgo(Date.parse(version().at), now(), { ago: true })} ·{' '}
                  {version().diagrams.length
                    ? `${version().diagrams.length} diagram${version().diagrams.length === 1 ? '' : 's'}`
                    : 'no change'}
                </span>
              </span>
              <Show when={version().version === props.current}>
                <CheckIcon class="mt-0.5 size-3.5 text-brand" />
              </Show>
            </DropdownMenuItem>
          )}
        </For>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Draw(props: { branch: ConversationId; architect?: ConversationId }) {
  const architect = useConversationSummary(() => props.architect)
  const [asking, setAsking] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const drawing = () => (architect()?.busy ?? false) || asking()
  return (
    <Button
      aria-label="Draw architecture"
      class="font-mono"
      disabled={drawing()}
      onClick={() => {
        setAsking(true)
        setError(undefined)
        return api
          .action(DrawAction, { conversation: props.branch })
          .catch((failure: unknown) => setError(errorMessage(failure)))
          .finally(() => setAsking(false))
      }}
      size="xs"
      title={error() ? `Draw failed: ${error()}` : 'Have the architect draw a new version'}
      variant="outline"
    >
      {drawing() ? <LoaderIcon class="animate-spin" /> : <SparklesIcon />}
      {drawing() ? 'drawing…' : error() ? 'retry draw' : 'Draw'}
    </Button>
  )
}

function DiagramRow(props: {
  diagram: ArchitectureDiagram
  current: boolean
  pending: number
  onPick: (id: string) => void
}) {
  const counts = createMemo(() => changeCounts(props.diagram.mermaid))
  const nested = () => props.diagram.level === 'implementation'
  return (
    <Button
      aria-current={props.current ? 'true' : undefined}
      aria-label={`Show diagram ${props.diagram.useCase ?? props.diagram.title}`}
      class={cn(
        'flex h-auto w-full justify-start gap-2 rounded-none py-1 pr-3 text-left text-[12.5px] font-normal whitespace-normal hover:bg-accent/60',
        nested() ? 'pl-5' : 'pl-3',
        props.current ? 'bg-accent/70 text-foreground' : 'text-foreground/80',
      )}
      data-architect-diagram={props.diagram.id}
      onClick={() => props.onPick(props.diagram.id)}
      size={null}
      title={props.diagram.useCase}
      type="button"
      variant={null}
    >
      <Show when={nested()}>
        <CodeIcon class="size-3 shrink-0 text-muted-foreground" />
      </Show>
      <span class="min-w-0 flex-1 truncate">{props.diagram.useCase ?? props.diagram.title}</span>
      <Show when={props.pending > 0}>
        <span class="flex items-center gap-0.5 font-mono text-[10.5px] text-brand">
          <MessageSquareIcon class="size-3" />
          {props.pending}
        </span>
      </Show>
      <span class="flex shrink-0 items-center gap-0.5">
        <For each={changes.filter((change) => counts()[change] > 0)}>
          {(change) => (
            <span
              class={cn('size-1.5 rounded-full', tone[change])}
              title={`${counts()[change]} ${change}`}
            />
          )}
        </For>
      </span>
    </Button>
  )
}

function DiagramList(props: {
  diagrams: ArchitectureDiagram[]
  current: ArchitectureDiagram
  drafts: Drafts
  onPick: (id: string) => void
  onEdit: (draft: Draft) => void
  onDelete: (draft: Draft) => void
}) {
  const mine = () => props.drafts.comments.filter((draft) => draft.diagram === props.current.id)
  const overview = () => props.diagrams.filter((diagram) => diagram.level !== 'implementation')
  const implementation = () =>
    props.diagrams.filter((diagram) => diagram.level === 'implementation')
  const row = (diagram: Accessor<ArchitectureDiagram>) => (
    <DiagramRow
      current={diagram().id === props.current.id}
      diagram={diagram()}
      onPick={props.onPick}
      pending={props.drafts.comments.filter((draft) => draft.diagram === diagram().id).length}
    />
  )
  return (
    <nav class="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-border/70 bg-sidebar py-1.5">
      <For each={overview()} keyed={(diagram) => diagram.id}>
        {row}
      </For>
      <Show when={implementation().length > 0}>
        <h3
          class="mt-2.5 mb-0.5 px-3 section-label"
          title="How the code collaborates, one use case at a time"
        >
          implementation
        </h3>
        <For each={implementation()} keyed={(diagram) => diagram.id}>
          {row}
        </For>
      </Show>
      <Show when={props.current.notes.length > 0}>
        <section class="mt-3 border-t border-border/60 px-3 pt-2.5">
          <h3 class="mb-1 section-label">notes</h3>
          <ul class="space-y-1.5 text-[12.5px] leading-snug text-foreground/85">
            <For each={props.current.notes}>
              {(note) => (
                <li class="flex gap-1.5">
                  <span class="text-muted-foreground/60">–</span>
                  <span class="min-w-0">{note}</span>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={mine().length > 0}>
        <section class="mt-3 border-t border-border/60 px-3 pt-2.5">
          <h3 class="mb-1 section-label">pending</h3>
          <ul class="space-y-1.5">
            <For each={mine()} keyed={(draft) => draft.id}>
              {(draft) => (
                <PendingItem
                  draft={draft()}
                  onDelete={() => props.onDelete(draft())}
                  onEdit={() => props.onEdit(draft())}
                />
              )}
            </For>
          </ul>
        </section>
      </Show>
    </nav>
  )
}

function PendingItem(props: { draft: Draft; onEdit: () => void; onDelete: () => void }) {
  return (
    <li
      class={cn(
        'group/draft rounded-md border border-border/70 border-l-2 bg-muted/30 px-2 py-1',
        props.draft.by === undefined ? 'border-l-brand/50' : 'border-dashed border-l-brand/50',
      )}
      data-architect-draft-item={props.draft.id}
      data-architect-suggested={props.draft.by}
    >
      <div class="flex items-center gap-1.5">
        <Show when={props.draft.by !== undefined}>
          <Suggested />
        </Show>
        <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
          {where(props.draft)}
        </span>
        <span class="flex items-center opacity-0 transition-opacity group-hover/draft:opacity-100 pointer-coarse:opacity-100">
          <Button
            aria-label={`Edit architecture comment ${props.draft.id}`}
            class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => props.onEdit()}
            size={null}
            type="button"
            variant={null}
          >
            <PencilIcon class="size-3" />
          </Button>
          <Button
            aria-label={`Delete architecture comment ${props.draft.id}`}
            class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-error"
            data-agent-confirm="Deletes this pending architecture comment."
            onClick={() => props.onDelete()}
            size={null}
            type="button"
            variant={null}
          >
            <Trash2Icon class="size-3" />
          </Button>
        </span>
      </div>
      <p class="line-clamp-3 text-[12px] leading-snug whitespace-pre-wrap text-foreground/90">
        {props.draft.text}
      </p>
    </li>
  )
}

function Suggested() {
  return (
    <span
      class="flex shrink-0 items-center gap-0.5 rounded-sm bg-brand/12 px-1 font-mono text-[10px] text-brand"
      title="Suggested by the architecture chat"
    >
      <MessagesSquareIcon class="size-2.5" />
      chat
    </span>
  )
}

function DiagramTitle(props: {
  diagram: ArchitectureDiagram
  version?: number
  onComment?: (at: { x: number; y: number }) => void
}) {
  return (
    <div class="mb-3 flex min-w-0 items-center gap-2">
      <Show when={props.version}>
        {(version) => (
          <span class="shrink-0 rounded border border-border/70 px-1 font-mono text-[10.5px] text-muted-foreground">
            v{version()}
          </span>
        )}
      </Show>
      <Show
        when={props.onComment}
        fallback={
          <span class="truncate text-[13px] font-medium text-muted-foreground">
            {props.diagram.title}
          </span>
        }
      >
        {(onComment) => (
          <Button
            aria-label={`Comment on diagram ${props.diagram.title}`}
            class="group/title flex h-auto min-w-0 justify-start gap-1.5 text-left text-[13px] font-medium hover:text-brand"
            data-architect-title={props.diagram.id}
            onClick={(event) => {
              const target = event.currentTarget
              const box = target.getBoundingClientRect()
              const origin = target.closest('[data-architect-stage]')?.getBoundingClientRect()
              onComment()({
                x: box.left - (origin?.left ?? 0) + 24,
                y: box.bottom - (origin?.top ?? 0) - 6,
              })
            }}
            size={null}
            title="Comment on the whole diagram"
            type="button"
            variant={null}
          >
            <span class="truncate">{props.diagram.title}</span>
            <Show when={props.diagram.level === 'implementation'}>
              <span
                class="shrink-0 rounded border border-border/70 px-1 font-mono text-[10.5px] font-normal text-muted-foreground"
                title={`The call path of “${props.diagram.useCase}” through the code`}
              >
                implementation
              </span>
            </Show>
            <MessageSquareIcon class="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 pointer-coarse:opacity-60" />
          </Button>
        )}
      </Show>
    </div>
  )
}

function Unchanged(props: { version: ArchitectureVersion; previous?: number }) {
  const now = useNow(60_000)
  return (
    <div class="flex flex-1 items-center justify-center p-6" data-architect-unchanged="">
      <div class="max-w-md text-center">
        <WorkflowIcon class="mx-auto mb-3 size-6 text-muted-foreground/50" />
        <p class="text-[14px] text-foreground/90">Nothing architectural changed</p>
        <p class="mt-1.5 text-[13px] leading-relaxed text-muted-foreground first-letter:uppercase">
          {props.version.summary.replace(/^Nothing architectural changed[:.,;\s–-]*/i, '') ||
            props.version.summary}
        </p>
        <p class="mt-3 font-mono text-[11px] text-muted-foreground/70">
          v{props.version.version} · {formatAgo(Date.parse(props.version.at), now(), { ago: true })}
          {props.previous !== undefined && ` · v${props.previous} has diagrams`}
        </p>
      </div>
    </div>
  )
}

export default function ArchitectureSurface() {
  const index = useDocOf(() => ROOT, ArchitectureIndexDoc)
  const notDrawable = useNotDrawable()
  const branches = createMemo<Branches>(() =>
    Object.fromEntries(
      Object.entries(index()?.branches ?? {}).filter(
        ([id]) => !notDrawable(parseConversationId(Number(id))),
      ),
    ),
  )
  const [view, setView] = useView()
  const shownBranch = useShownBranch()
  const branch = createMemo(() => {
    const wanted = view().branch
    if (wanted !== undefined && !notDrawable(wanted)) return wanted
    const own = shownBranch()
    if (own !== undefined && branches()[own]) return own
    return Object.entries(branches())
      .toSorted(([, a], [, b]) => b.at.localeCompare(a.at))
      .map(([id]) => parseConversationId(Number(id)))[0]
  })
  const doc = useDocOf(branch, ArchitectureDoc)
  const versions = () => doc()?.versions ?? []
  const latest = () => versions().at(-1)
  const version = createMemo(
    () => versions().find((item) => item.version === view().version) ?? latest(),
  )
  const compare = createMemo(() => {
    const wanted = view().compare
    return wanted !== undefined && wanted !== version()?.version
      ? versions().find((item) => item.version === wanted)
      : undefined
  })
  const change = (next: Partial<View>) => setView((previous) => ({ ...previous, ...next }))
  const viewport = useViewport()
  const phone = () => viewport() === 'phone'
  const now = useNow(60_000)
  const [chatting, setChat] = useChatOpen()
  const versionKey = createMemo(() => {
    const id = branch()
    const shown = version()
    return id === undefined || !shown ? undefined : `${id}:${shown.version}`
  })
  return (
    <Switch>
      <Match when={!index() || (branch() !== undefined && !doc())}>
        <Frame>
          <Loading />
        </Frame>
      </Match>
      <Match when={branch() === undefined}>
        <Frame>
          <NoBranch />
        </Frame>
      </Match>
      <Match when={branch()}>
        {(id) => (
          <Frame
            controls={
              <>
                <BranchPicker
                  branch={id()}
                  branches={branches()}
                  onChange={(next) => setView({ branch: next })}
                />
                <Show when={version()}>
                  {(shown) => (
                    <VersionMenu
                      current={shown().version}
                      label={
                        <>
                          v{shown().version}
                          <span class="text-muted-foreground max-md:hidden">
                            {' '}
                            · {formatAgo(Date.parse(shown().at), now(), { ago: true })}
                          </span>
                        </>
                      }
                      name="Choose an architecture version"
                      onPick={(next) =>
                        change({ version: next === latest()?.version ? undefined : next })
                      }
                      title="Choose a version"
                      versions={versions()}
                    />
                  )}
                </Show>
                <Show
                  when={versions().length > 1 && version()?.diagrams.length ? version() : undefined}
                >
                  {(shown) => (
                    <VersionMenu
                      current={compare()?.version}
                      icon={<GitCompareArrowsIcon class="size-3.5" />}
                      label={
                        <Show
                          when={compare()}
                          fallback={<span class="max-md:hidden">compare</span>}
                        >
                          {(other) => `v${other().version}`}
                        </Show>
                      }
                      name="Compare with another architecture version"
                      none={compare() ? 'Stop comparing' : undefined}
                      onPick={(next) => change({ compare: next })}
                      title="Compare with another version"
                      versions={versions().filter((item) => item.version !== shown().version)}
                    />
                  )}
                </Show>
                <span class="mx-0.5 h-4 w-px shrink-0 bg-border/70" />
                <Draw architect={doc()?.architect} branch={id()} />
                <Show when={latest()}>
                  <DiscussButton
                    branch={id()}
                    onToggle={(open) => setChat(open)}
                    open={chatting()}
                  />
                </Show>
              </>
            }
          >
            <Show
              when={versionKey()}
              keyed
              fallback={<Notice>No versions yet: Draw asks the architect for the first.</Notice>}
            >
              {(_key) => (
                <Show when={version()}>
                  {(shown) => (
                    <Version
                      branch={id()}
                      compare={compare()}
                      onView={change}
                      phone={phone()}
                      previous={
                        versions().findLast(
                          (item) => item.version < shown().version && item.diagrams.length > 0,
                        )?.version
                      }
                      version={shown()}
                      view={view()}
                    />
                  )}
                </Show>
              )}
            </Show>
            <Show when={chatting() && latest()}>
              {(last) => (
                <ChatPanel
                  branch={id()}
                  latest={last().version}
                  onClose={() => setChat(false)}
                  phone={phone()}
                />
              )}
            </Show>
          </Frame>
        )}
      </Match>
    </Switch>
  )
}

function NoBranch() {
  const branch = useShownBranch()
  const notDrawable = useNotDrawable()
  const reason = () => {
    const id = branch()
    return id === undefined ? 'No conversation on screen' : notDrawable(id)
  }
  return (
    <div class="flex flex-1 items-center justify-center p-6">
      <div class="max-w-md text-center">
        <WorkflowIcon class="mx-auto mb-3 size-6 text-muted-foreground/50" />
        <p class="text-[14px] text-foreground/90">No architecture drawn yet</p>
        <p class="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          The architect draws a branch only when you ask.{' '}
          {reason()
            ? `${reason()}: open a branch to draw it.`
            : 'Draw one now for the conversation on screen.'}
        </p>
        <Show when={reason() === undefined && branch()}>
          {(id) => (
            <div class="mt-4 flex justify-center">
              <Draw branch={id()} />
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

type SentOutcome = { conversation: ConversationId } | { error: string }

const partOf = (draft: Draft) => ({
  kind: draft.kind,
  part: draft.part ?? '',
  label: draft.label,
})

type VersionProps = {
  branch: ConversationId
  version: ArchitectureVersion
  compare?: ArchitectureVersion
  previous?: number
  phone: boolean
  view: View
  onView: (next: Partial<View>) => void
}

function Version(props: VersionProps) {
  const diagram = createMemo(
    () =>
      props.version.diagrams.find((item) => item.id === props.view.diagram) ??
      props.version.diagrams[0],
  )
  return (
    <Show
      when={diagram()}
      fallback={<Unchanged previous={props.previous} version={props.version} />}
    >
      {(current) => <VersionBody diagram={current} own={props} />}
    </Show>
  )
}

const showings = [
  ['other', 'the compared version'],
  ['this', 'this version'],
  ['both', 'both versions'],
] as const

type Showing = (typeof showings)[number][0]

function VersionBody(props: { diagram: Accessor<ArchitectureDiagram>; own: VersionProps }) {
  const diagram = () => props.diagram()
  const [drafts, edit] = useDrafts(
    () => props.own.branch,
    () => props.own.version.version,
  )
  const to = () => drafts().to ?? props.own.branch
  const [writing, setWriting] = createSignal<Writing>()
  const [sending, setSending] = createSignal(false)
  const [sent, setSent] = createSignal<SentOutcome>()
  const [showing, setShowing] = createSignal<Showing>('this')
  const mark = useMark()
  const [width, setWidth] = createSignal(800)
  const [, setChat] = useChatOpen()
  let stage: HTMLDivElement | undefined
  onSettled(() => {
    const element = stage
    if (!element) return undefined
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    return () => observer.disconnect()
  })
  createEffect(
    () => props.own.compare?.version,
    () => {
      setShowing('this')
    },
  )
  const pick = (id: string) => {
    setWriting(undefined)
    clearMark()
    props.own.onView({ diagram: id })
  }
  const editing = () => {
    const id = writing()?.id
    return id ? drafts().comments.find((draft) => draft.id === id) : undefined
  }
  const commentOf = (part: Writing['part'], text: string) => ({
    diagram: diagram().id,
    kind: part.kind,
    ...(part.kind === 'diagram' ? {} : { part: part.part }),
    label: part.label,
    text,
  })
  const save = async (text: string) => {
    const current = writing()
    if (!current) return
    const existing = editing()
    if (existing) await edit({ op: 'update', id: existing.id, text })
    else await edit({ op: 'add', comment: commentOf(current.part, text) })
    setWriting(undefined)
  }
  const ask = async (text: string) => {
    const current = writing()
    if (!current) return
    const who = writerNow()
    try {
      await api.action(AskAction, {
        branch: props.own.branch,
        version: props.own.version.version,
        comment: commentOf(current.part, text),
      })
      setWriting(undefined)
    } finally {
      writingAs(who, () => setChat(true))
    }
  }
  const send = async () => {
    setSending(true)
    setSent(undefined)
    try {
      setSent(
        await api.action(SendAction, {
          branch: props.own.branch,
          version: props.own.version.version,
        }),
      )
    } catch (failure) {
      setSent({ error: errorMessage(failure) })
    } finally {
      setSending(false)
    }
  }
  const mode = (): Showing =>
    props.own.compare ? (props.own.phone && showing() === 'both' ? 'this' : showing()) : 'this'
  const side = () => mode() === 'both' && props.own.compare !== undefined
  const shown = () => (mode() === 'other' ? undefined : diagram())
  const other = () => props.own.compare?.diagrams.find((item) => item.id === diagram().id)
  const startWriting = (next: Writing) => {
    clearMark()
    const existing = drafts().comments.find(
      (draft) =>
        draft.diagram === diagram().id &&
        draft.kind === next.part.kind &&
        (draft.kind === 'diagram' || draft.part === next.part.part),
    )
    setWriting(existing ? { ...next, id: existing.id } : next)
  }
  const composerKey = createMemo(() => {
    const current = writing()
    return current && (current.id ?? `${current.part.kind}:${current.part.part}`)
  })
  const pickAt = (part: Writing['part'], at: { x: number; y: number }, id: string) => {
    const box = stage?.getBoundingClientRect()
    const canvas = stage
      ?.querySelector(`[data-architect-canvas="${CSS.escape(id)}"]`)
      ?.parentElement?.getBoundingClientRect()
    startWriting({
      part,
      x: at.x + (canvas?.left ?? 0) - (box?.left ?? 0) + (stage?.scrollLeft ?? 0),
      y: at.y + (canvas?.top ?? 0) - (box?.top ?? 0) + (stage?.scrollTop ?? 0),
    })
  }
  const sentTo = () => {
    const outcome = sent()
    return outcome && 'conversation' in outcome ? outcome.conversation : undefined
  }
  const sentError = () => {
    const outcome = sent()
    return outcome && 'error' in outcome ? outcome.error : undefined
  }
  return (
    <>
      <Show when={!props.own.phone}>
        <DiagramList
          current={diagram()}
          diagrams={props.own.version.diagrams}
          drafts={drafts()}
          onDelete={(draft) => edit({ op: 'delete', id: draft.id })}
          onEdit={(draft) => setWriting({ part: partOf(draft), x: 24, y: 24, id: draft.id })}
          onPick={pick}
        />
      </Show>
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="shrink-0 border-b border-border/70 px-3 py-2 md:px-4">
          <p class="truncate text-[13px] text-foreground/90" title={props.own.version.title}>
            {props.own.version.title}
          </p>
          <p class="text-[12px] leading-snug text-muted-foreground max-md:line-clamp-2">
            {props.own.version.summary}
          </p>
        </div>
        <Show when={props.own.phone}>
          <PhoneDiagrams current={diagram()} diagrams={props.own.version.diagrams} onPick={pick} />
        </Show>
        <div
          class="relative min-h-0 flex-1 overflow-auto p-3 md:p-5"
          data-architect-stage=""
          ref={(element) => {
            stage = element
            element.addEventListener('click', (event) => {
              if (event.target === element) setWriting(undefined)
            })
          }}
        >
          <Show when={props.own.compare}>
            {(compared) => (
              <ToggleGroup
                aria-label="Which architecture version to show"
                bind={[
                  () => [mode()],
                  ([next]) => {
                    if (!next) return
                    setWriting(undefined)
                    setShowing(next)
                  },
                ]}
                class="mb-3 flex w-fit items-center gap-0 rounded-md border border-border/70 p-0.5"
                deselectable={false}
              >
                <For each={showings.filter(([name]) => !props.own.phone || name !== 'both')}>
                  {([name, label]) => (
                    <Toggle
                      aria-label={`Show ${label}`}
                      class="h-6 rounded-sm px-2 font-mono text-[11px] font-normal text-muted-foreground transition-colors hover:text-foreground"
                      data-architect-showing={name}
                      size={null}
                      value={name}
                      variant={null}
                    >
                      {name === 'other'
                        ? `v${compared().version}`
                        : name === 'this'
                          ? `v${props.own.version.version}`
                          : 'both'}
                    </Toggle>
                  )}
                </For>
              </ToggleGroup>
            )}
          </Show>
          <div class={cn(side() && 'grid grid-cols-2 gap-4')}>
            <Show when={side() && props.own.compare}>
              {(compared) => (
                <div class="min-w-0 rounded-md border border-dashed border-border/70 p-3">
                  <Compared diagram={other()} version={compared().version} />
                </div>
              )}
            </Show>
            <Show
              when={shown()}
              fallback={
                <Show when={props.own.compare}>
                  {(compared) => (
                    <Compared
                      diagram={other()}
                      fit={!props.own.phone}
                      version={compared().version}
                    />
                  )}
                </Show>
              }
            >
              {(current) => (
                <div class={cn('min-w-0', side() && 'rounded-md border border-border/70 p-3')}>
                  <DiagramTitle
                    diagram={current()}
                    onComment={(at) =>
                      startWriting({
                        part: { kind: 'diagram', part: '', label: current().title },
                        ...at,
                      })
                    }
                    version={props.own.compare ? props.own.version.version : undefined}
                  />
                  <Canvas
                    diagram={current()}
                    drafts={drafts().comments.filter((draft) => draft.diagram === current().id)}
                    fit={!props.own.phone}
                    marked={mark() && props.own.view.diagram === current().id ? mark() : undefined}
                    onPick={(part, at) => pickAt(part, at, current().id)}
                    svgId={`architect-${current().id}-v${props.own.version.version}`}
                  />
                </div>
              )}
            </Show>
          </div>
          <Show when={composerKey()} keyed>
            {(_key) => (
              <Show when={writing()}>
                {(current) => (
                  <div class="absolute z-20" style={popoverAt(current().x, current().y, width())}>
                    <Composer
                      details={
                        <Show
                          when={
                            current().part.kind !== 'diagram' &&
                            diagram().code?.[current().part.part]
                          }
                        >
                          {(code) => <PartSource code={code()} where={props.own.version.code} />}
                        </Show>
                      }
                      initial={editing()?.text}
                      label={
                        current().part.kind === 'diagram'
                          ? undefined
                          : (diagram().parts[current().part.part] ?? current().part.label)
                      }
                      onAsk={ask}
                      onCancel={() => setWriting(undefined)}
                      onSubmit={save}
                      submit={editing() ? 'Save' : 'Add'}
                      title={
                        current().part.kind === 'diagram'
                          ? diagram().title
                          : current().part.kind === 'edge'
                            ? 'edge'
                            : `${current().part.kind} ${current().part.part}`
                      }
                    />
                  </div>
                )}
              </Show>
            )}
          </Show>
        </div>
        <Legend
          proposed={Object.values(diagram().code ?? {}).some((code) => code.status === 'proposed')}
        />
        <Show
          when={drafts().comments.length > 0}
          fallback={
            <Show when={sentTo()}>
              {(id) => (
                <Sent
                  conversation={id()}
                  onClose={() => setSent(undefined)}
                  onOpen={() => {
                    switchConversation(id())
                    showSurface('agent')
                  }}
                />
              )}
            </Show>
          }
        >
          <Footer
            drafts={drafts()}
            edit={edit}
            error={sentError()}
            onSend={() => void send()}
            sending={sending()}
            to={to()}
          />
        </Show>
      </div>
    </>
  )
}

function Compared(props: { diagram?: ArchitectureDiagram; version: number; fit?: boolean }) {
  return (
    <Show
      when={props.diagram}
      fallback={
        <p class="py-10 text-center font-mono text-[11.5px] text-muted-foreground/70">
          v{props.version} has no such diagram
        </p>
      }
    >
      {(diagram) => (
        <div class="min-w-0 opacity-90">
          <DiagramTitle diagram={diagram()} version={props.version} />
          <Canvas
            diagram={diagram()}
            fit={props.fit ?? true}
            svgId={`architect-${diagram().id}-v${props.version}-compare`}
          />
        </div>
      )}
    </Show>
  )
}

function PhoneDiagrams(props: {
  diagrams: ArchitectureDiagram[]
  current: ArchitectureDiagram
  onPick: (id: string) => void
}) {
  return (
    <div class="shrink-0 border-b border-border/70 bg-sidebar">
      <div class="flex gap-1 overflow-x-auto px-2 py-1.5">
        <For each={props.diagrams} keyed={(diagram) => diagram.id}>
          {(diagram) => (
            <Button
              aria-current={diagram().id === props.current.id ? 'true' : undefined}
              aria-label={`Show diagram ${diagram().useCase ?? diagram().title}`}
              class={cn(
                'h-6 shrink-0 rounded-md px-2 text-[12px] font-normal',
                diagram().id === props.current.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => props.onPick(diagram().id)}
              size={null}
              type="button"
              variant={null}
            >
              {diagram().useCase ?? diagram().title}
            </Button>
          )}
        </For>
      </div>
      <Show when={props.current.notes.length > 0}>
        <ul class="space-y-0.5 px-3 pb-2 text-[12px] leading-snug text-muted-foreground">
          <For each={props.current.notes}>{(note) => <li>– {note}</li>}</For>
        </ul>
      </Show>
    </div>
  )
}
