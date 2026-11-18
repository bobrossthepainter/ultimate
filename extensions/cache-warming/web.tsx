import type { ConversationId } from '@earendil-works/pi-durable'
import { FlameIcon, XIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  api,
  cn,
  defineWebExtension,
  events,
  formatAgo,
  keepLast,
  ROOT,
  useAction,
  useConversation,
  useConversationSummary,
  useDocOf,
  useNow,
} from '@/sdk'
import { StandingDoc } from '../subagents/ui.tsx'
import { CacheWarmingDoc, SetAction, StateAction } from './refs.ts'
import type { CacheWarmingState, Setting, Source } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}

const failed = (state: CacheWarmingState) =>
  state.last?.error !== undefined && (state.lastAt === undefined || state.last.at >= state.lastAt)

const isWarm = (state: CacheWarmingState, now: number) =>
  state.lastAt !== undefined && state.ttl !== undefined && state.lastAt + state.ttl > now

const dollars = (amount: number) => `$${amount < 1 ? amount.toFixed(3) : amount.toFixed(2)}`

function lifetimeLines(state: CacheWarmingState) {
  if (state.ttl === undefined) return ['Cache lifetime unknown: not warmed']
  return [
    `Cache lasts ${duration(state.ttl)} · ${tokens(state.tokens)} context`,
    ...(state.rewriteCost === undefined
      ? []
      : [`Writing it again costs ≈ ${dollars(state.rewriteCost)}`]),
  ]
}

function warmCostLine(state: CacheWarmingState) {
  if (!state.warmCost) return undefined
  const { pings, cost } = state.warmCost
  return `≈ ${dollars(cost)} for ${pings} ping${pings === 1 ? '' : 's'}, one every ${duration(state.pingAfter ?? 0)}`
}

function statusLines(state: CacheWarmingState, now: number) {
  const lines: string[] = []
  if (state.lastAt !== undefined && state.ttl !== undefined) {
    const expires = state.lastAt + state.ttl
    lines.push(expires > now ? `Runs out ${clock(expires)}` : `Cold since ${clock(expires)}`)
  }
  if (state.next)
    lines.push(
      `${state.next.step === 'ping' ? 'Next ping' : 'Compacts'} ${clock(Math.max(now, state.next.at))}${state.running ? ' (in a run)' : ''}`,
    )
  else if (state.warm.value || state.compact.value) lines.push(state.idle ?? 'Nothing due')
  if (state.warmUntil !== undefined && state.warmUntil > now)
    lines.push(`Warm until ${clock(state.warmUntil)}`)
  return lines
}

function Tag({ source }: { source: Source }) {
  return (
    <span
      className={cn(
        'w-14 shrink-0 text-right text-[10px] text-orange-500/80',
        source !== 'override' && 'invisible',
      )}
      data-source={source}
      title="Set for this chat only; reset goes back to the default"
    >
      this chat
    </span>
  )
}

function Reset({ label, shown, onReset }: { label: string; shown: boolean; onReset: () => void }) {
  return (
    <button
      aria-label={`Reset ${label}`}
      className={cn(
        'rounded-sm p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground',
        !shown && 'invisible',
      )}
      onClick={onReset}
      title="Back to the agent's setting"
      type="button"
    >
      <XIcon className="size-3" />
    </button>
  )
}

function SwitchRow({
  label,
  setting,
  onChange,
}: {
  label: string
  setting: Setting<boolean>
  onChange: (value: boolean | null) => void
}) {
  return (
    <div className="flex h-8 items-center gap-2 px-2 text-[12px]">
      <label className="flex flex-1 cursor-pointer items-center gap-2">
        <span className="flex-1">{label}</span>
        <Tag source={setting.source} />
        <Switch checked={setting.value} onCheckedChange={onChange} />
      </label>
      <Reset label={label} onReset={() => onChange(null)} shown={setting.source === 'override'} />
    </div>
  )
}

function MinutesRow({
  setting,
  onSave,
}: {
  setting: Setting<number>
  onSave: (value: number | null) => void
}) {
  const label = 'Warm for'
  const shown = String(setting.value)
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    const value = Number(draft)
    if (draft.trim() === '' || !Number.isFinite(value) || value < 0) return setDraft(shown)
    if (value !== setting.value) onSave(value)
  }
  return (
    <div className="flex h-7 items-center gap-2 px-2 text-[11.5px]">
      <span className="text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        className="h-5 w-14 rounded-sm border border-border bg-transparent px-1 text-right tabular-nums text-foreground"
        min={0}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        type="number"
        value={draft}
      />
      <span className="flex-1 text-muted-foreground/70">min</span>
      <Tag source={setting.source} />
      <Reset label={label} onReset={() => onSave(null)} shown={setting.source === 'override'} />
    </div>
  )
}

function Popup({
  id,
  name,
  state,
  refresh,
}: {
  id: ConversationId
  name: string
  state: CacheWarmingState
  refresh: () => void
}) {
  const now = useNow(30_000)
  const set = (change: {
    warm?: boolean | null
    compact?: boolean | null
    minutes?: number | null
  }) =>
    api
      .action(SetAction, { id, ...change })
      .then(refresh)
      .catch((error: unknown) => console.warn('Cache warming', error))
  const status = statusLines(state, now)
  const kept =
    state.kept &&
    `Kept warm so far: ${dollars(state.kept.cost)} (${state.kept.pings} ping${state.kept.pings === 1 ? '' : 's'})`
  return (
    <PopoverContent align="end" className="w-80 p-1 font-mono" side="top">
      <div
        className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground"
        title={state.provider ? `${state.provider}/${state.model}` : undefined}
      >
        {lifetimeLines(state).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
      <SwitchRow
        label={`Keep ${name} warm`}
        onChange={(warm) => void set({ warm })}
        setting={state.warm}
      />
      {state.warm.value && (
        <>
          <MinutesRow onSave={(minutes) => void set({ minutes })} setting={state.minutes} />
          {warmCostLine(state) && (
            <div className="px-2 pb-1 text-[11px] text-muted-foreground" data-warm-cost>
              {warmCostLine(state)}
            </div>
          )}
        </>
      )}
      <SwitchRow
        label="Compact before cold"
        onChange={(compact) => void set({ compact })}
        setting={state.compact}
      />
      <div className="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1.5 text-[11px] text-muted-foreground">
        <div className="text-foreground/80">
          {status.length ? status.map((line) => <div key={line}>{line}</div>) : 'Off'}
        </div>
        {kept && <div>{kept}</div>}
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
        {state.agent && (
          <button
            className="text-foreground/80 underline-offset-2 hover:underline"
            onClick={() => events.emit('subagents:open-definition', { name: state.agent })}
            type="button"
          >
            Defaults from Agents › {state.agent}
          </button>
        )}
      </div>
    </PopoverContent>
  )
}

function Chip({ id, name, label }: { id: ConversationId; name: string; label: string }) {
  const doc = useDocOf(id, CacheWarmingDoc)
  const { data: state, refetch } = useAction(
    StateAction,
    { id },
    { onError: keepLast, on: doc, every: 30_000 },
  )
  const now = useNow(30_000)
  if (!state?.kind) return null
  const on = state.warm.value || state.compact.value
  const warm = isWarm(state, now)
  const red = failed(state) || state.compaction?.error !== undefined
  return (
    <Popover onOpenChange={(open) => open && void refetch()}>
      <PopoverTrigger asChild>
        <button
          aria-label={`${name}'s prompt cache`}
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            !on && 'text-muted-foreground/60',
          )}
          data-cache-warming={on ? (warm ? 'warm' : 'cold') : 'off'}
          type="button"
        >
          <FlameIcon
            className={cn(
              'size-3',
              on && (warm ? 'text-orange-500' : 'text-sky-500'),
              red && 'text-red-500',
            )}
          />
          {label}
        </button>
      </PopoverTrigger>
      <Popup id={id} name={name} refresh={() => void refetch()} state={state} />
    </Popover>
  )
}

function UltimateChip() {
  const ultimate = useDocOf(ROOT, StandingDoc)?.ultimate
  return ultimate === undefined ? null : <Chip id={ultimate} label="@ultimate" name="@ultimate" />
}

function BranchChip() {
  const id = useConversation((conversation) => conversation.id)
  const summary = useConversationSummary(id)
  const coordinator = summary?.label === 'coordinator' && summary.ownerTaskId === undefined
  return coordinator && id !== undefined ? <Chip id={id} label="branch" name="this branch" /> : null
}

export default defineWebExtension({
  slots: {
    'statusline.right': [
      { component: BranchChip, order: -2 },
      { component: UltimateChip, order: -1 },
    ],
  },
})
