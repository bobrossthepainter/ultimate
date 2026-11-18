import { FlameIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  defineWebExtension,
  formatAgo,
  keepLast,
  useAction,
  useConversation,
  useConversationSummary,
  useDocOf,
  useNow,
} from '@/sdk'
import { BranchCacheDoc, SetAction, SetModelAction, StateAction } from './refs.ts'
import type { BranchCacheState, ModelPolicyChange, Setting, Source } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const duration = (ms: number) => {
  const minutes = ms / 60_000
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}

const failed = (state: BranchCacheState) =>
  state.last?.error !== undefined && (state.lastAt === undefined || state.last.at >= state.lastAt)

function cacheLine(state: BranchCacheState, now: number) {
  if (state.lastAt === undefined || state.ttl === undefined)
    return `No warm cache · ${tokens(state.tokens)} context`
  const until = state.lastAt + state.ttl
  return `${until > now ? `Warm until ${clock(until)}` : `Cold since ${clock(until)}`} · ${tokens(state.tokens)} context`
}

function nextLine(state: BranchCacheState, now: number) {
  if (!state.warm.value && !state.compact.value) return 'Off'
  if (state.next)
    return `${state.next.step === 'ping' ? 'Next ping' : 'Compacts at'} ${clock(Math.max(now, state.next.at))}${state.running ? ' · in a run' : ''}`
  return state.idle ?? 'Nothing due'
}

function Tag({ source }: { source: Source }) {
  return (
    <span
      className={cn(
        'w-12 shrink-0 text-right text-[10px] text-muted-foreground/60',
        source === 'yours' && 'text-orange-500/80',
        source === 'branch' && 'text-foreground/70',
      )}
      data-source={source}
    >
      {source}
    </span>
  )
}

function SwitchRow({
  label,
  setting,
  onChange,
}: {
  label: string
  setting: Setting<boolean>
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex h-8 cursor-pointer items-center gap-2 px-2 text-[12px]">
      <span className="flex-1">{label}</span>
      <Tag source={setting.source} />
      <Switch checked={setting.value} onCheckedChange={onChange} />
    </label>
  )
}

function NumberRow({
  label,
  unit,
  setting,
  scale = 1,
  onSave,
}: {
  label: string
  unit: string
  setting: Setting<number>
  scale?: number
  onSave: (value: number | null) => void
}) {
  const shown = String(setting.value / scale)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const lockedByProject = setting.source === 'project'
  const commit = () => {
    const value = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(value) || value < 0) return setDraft(shown)
    if (value * scale !== setting.value) onSave(value * scale)
  }
  return (
    <div className="flex h-7 items-center gap-2 px-2 text-[11.5px]">
      <span className="flex-1 text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        className="h-5 w-14 rounded-sm border border-border bg-transparent px-1 text-right tabular-nums text-foreground disabled:opacity-60"
        disabled={lockedByProject}
        min={0}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        title={lockedByProject ? "Set in the project's .ultimate/settings.json" : undefined}
        type="number"
        value={draft}
      />
      <span className="w-6 text-muted-foreground/70">{unit}</span>
      <Tag source={setting.source} />
      <button
        aria-label={`Reset ${label}`}
        className={cn(
          'rounded-sm p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground',
          setting.source !== 'yours' && 'invisible',
        )}
        onClick={() => onSave(null)}
        title="Back to the default"
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}

function ModelPolicy({ state, refresh }: { state: BranchCacheState; refresh: () => void }) {
  const { provider, model, policy } = state
  if (!provider || !model || !policy) return null
  const save = (change: Omit<ModelPolicyChange, 'provider' | 'model'>) =>
    api
      .action(SetModelAction, { provider, model, ...change })
      .then(refresh)
      .catch((error: unknown) => console.warn('Branch cache', error))
  return (
    <div className="border-t border-border/70 pt-1.5 pb-1" data-branch-cache-model>
      <div className="flex items-center gap-2 px-2 text-[11.5px]">
        <span className="min-w-0 flex-1 truncate text-foreground/80" title={`${provider}/${model}`}>
          {provider}/{model}
        </span>
      </div>
      <div className="flex h-6 items-center gap-2 px-2 text-[11.5px] text-muted-foreground">
        <span className="flex-1">Cache</span>
        <span className="text-foreground/80">
          {state.ttl === undefined
            ? 'lifetime unknown'
            : `${duration(state.ttl)} · ping at ${duration(state.pingAfter ?? 0)}`}
        </span>
        <Tag source="model" />
        <span className="w-4" />
      </div>
      {state.ttl !== undefined && (
        <>
          <NumberRow
            label="Keep warm for"
            onSave={(value) => void save({ warmMinutes: value })}
            setting={policy.warmMinutes}
            unit="min"
          />
          <NumberRow
            label="Compact from"
            onSave={(value) => void save({ minCompactTokens: value })}
            scale={1000}
            setting={policy.minCompactTokens}
            unit="k"
          />
        </>
      )}
    </div>
  )
}

function Chip() {
  const id = useConversation((conversation) => conversation.id)
  const summary = useConversationSummary(id)
  const coordinator = summary?.label === 'coordinator' && summary.ownerTaskId === undefined
  const doc = useDocOf(coordinator ? id : undefined, BranchCacheDoc)
  const { data: state, refetch } = useAction(
    StateAction,
    { id: id! },
    { onError: keepLast, on: doc, every: 30_000, enabled: coordinator && id !== undefined },
  )
  const now = useNow(30_000)
  if (!coordinator || id === undefined || !state) return null
  const on = state.warm.value || state.compact.value
  const warm =
    state.lastAt !== undefined && state.ttl !== undefined && state.lastAt + state.ttl > now
  const red = failed(state) || state.compaction?.error !== undefined
  const set = (change: { warm?: boolean; compact?: boolean }) =>
    api
      .action(SetAction, { id, ...change })
      .catch((error: unknown) => console.warn('Branch cache', error))
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          aria-label="This branch's prompt cache"
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            !on && 'text-muted-foreground/60',
          )}
          data-branch-cache={on ? (warm ? 'warm' : 'cold') : 'off'}
          type="button"
        >
          <FlameIcon
            className={cn(
              'size-3',
              on && (warm ? 'text-orange-500' : 'text-sky-500'),
              red && 'text-red-500',
            )}
          />
          branch
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-1 font-mono" side="top">
        <SwitchRow
          label="Keep this branch warm"
          onChange={(value) => void set({ warm: value })}
          setting={state.warm}
        />
        <SwitchRow
          label="Compact before it goes cold"
          onChange={(value) => void set({ compact: value })}
          setting={state.compact}
        />
        <div className="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1.5 text-[11px] text-muted-foreground">
          <div className="text-foreground/80">{cacheLine(state, now)}</div>
          <div>{nextLine(state, now)}</div>
          {state.last && (
            <div className={cn(failed(state) && 'text-red-500')}>
              Last ping {formatAgo(state.last.at)}
              {state.last.error !== undefined
                ? `: ${state.last.error}`
                : ` · read ${tokens(state.last.read)}, wrote ${tokens(state.last.write)}`}
            </div>
          )}
          {state.compaction && (
            <div className={cn(state.compaction.error !== undefined && 'text-red-500')}>
              Compacted {clock(state.compaction.at)} · was {tokens(state.compaction.tokens)}
              {state.compaction.error !== undefined
                ? `: ${state.compaction.error}`
                : state.compaction.read !== undefined
                  ? ` · read ${tokens(state.compaction.read)}, wrote ${tokens(state.compaction.write)}`
                  : ''}
            </div>
          )}
        </div>
        <ModelPolicy refresh={() => void refetch()} state={state} />
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2 }] },
})
