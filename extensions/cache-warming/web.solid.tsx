/** @jsxImportSource @solidjs/web */
import type { ConversationId } from '@earendil-works/pi-durable'
import { Flame, X } from '@lucide/solid'
import { For, Show, createMemo, createSignal } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { NumberInput } from '@/components/ui/number-input.solid.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.solid.tsx'
import { StatusPopoverTrigger } from '@/components/ui/status-trigger.solid.tsx'
import { Switch } from '@/components/ui/switch.solid.tsx'
import {
  api,
  cn,
  defineWebExtension,
  events,
  formatAgo,
  keepLast,
  ROOT,
  useAction,
  useConversationId,
  useConversationSummary,
  useDocOf,
  useNow,
} from '@/sdk/solid'
import { StandingDoc } from '../subagents/refs.ts'
import { duration } from './duration.ts'
import { CacheWarmingDoc, SetAction, StateAction } from './refs.ts'
import type { CacheWarmingState, Setting, Source } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

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
  if (!state.warmCost?.pings) return undefined
  const { pings, cost } = state.warmCost
  return `≈ ${dollars(cost)} for ${pings} ping${pings === 1 ? '' : 's'}, one every ${duration(state.pingAfter ?? 0)}`
}

function statusLines(state: CacheWarmingState, now: number) {
  const lines: string[] = []
  if (state.lastAt !== undefined && state.ttl !== undefined) {
    const expires = state.lastAt + state.ttl
    lines.push(expires > now ? `Runs out ${clock(expires)}` : `Cold since ${clock(expires)}`)
  }
  if (state.running && state.next?.step === 'ping') return [...lines, 'Working · kept warm']
  if (state.next)
    lines.push(
      `${state.next.step === 'ping' ? 'Next ping' : 'Compacts'} ${clock(Math.max(now, state.next.at))}`,
    )
  else if (state.warm.value || state.compact.value) lines.push(state.idle ?? 'Nothing due')
  if (state.warmUntil !== undefined && state.warmUntil > now)
    lines.push(`Warm until ${clock(state.warmUntil)}`)
  return lines
}

function Tag(props: { source: Source }) {
  return (
    <span
      class={cn(
        'w-14 shrink-0 text-right text-[10px] text-amber-500/80',
        props.source !== 'override' && 'invisible',
      )}
      data-source={props.source}
      title="Set for this chat only; reset goes back to the default"
    >
      this chat
    </span>
  )
}

function Reset(props: { label: string; shown: boolean; onReset: () => void }) {
  return (
    <Button
      aria-label={`Reset ${props.label}`}
      class={cn(
        'rounded-sm p-0.5 text-muted-foreground/60 hover:bg-accent hover:text-foreground',
        !props.shown && 'invisible',
      )}
      onClick={() => props.onReset()}
      size={null}
      title="Back to the agent's setting"
      variant={null}
    >
      <X class="size-3" />
    </Button>
  )
}

function SwitchRow(props: {
  label: string
  setting: Setting<boolean>
  onChange: (value: boolean | null) => void
}) {
  return (
    <div class="flex h-8 items-center gap-2 px-2 text-[12px]">
      <label class="flex flex-1 items-center gap-2">
        <span class="flex-1">{props.label}</span>
        <Tag source={props.setting.source} />
        <Switch bind={[() => props.setting.value, (on) => props.onChange(on)]} />
      </label>
      <Reset
        label={props.label}
        onReset={() => props.onChange(null)}
        shown={props.setting.source === 'override'}
      />
    </div>
  )
}

function MinutesRow(props: {
  setting: Setting<number>
  onSave: (value: number | null) => Promise<unknown>
}) {
  const label = 'Warm for'
  const [draft, setDraft] = createSignal<number | null>()
  const commit = (next: number | null) => {
    if (next === null || next === props.setting.value) setDraft(undefined)
    else
      void props.onSave(next).finally(() => {
        if (draft() === next) setDraft(undefined)
      })
  }
  return (
    <div class="flex h-7 items-center gap-2 px-2 text-[11.5px]">
      <span class="text-muted-foreground">{label}</span>
      <NumberInput
        aria-label={`${label} minutes`}
        class="h-5 w-14 text-right text-foreground"
        format={{ useGrouping: false }}
        min={0}
        onValueChange={(next, details) => {
          setDraft(next)
          if (details.source === 'agent') commit(next)
        }}
        onValueCommit={commit}
        value={draft() === undefined ? props.setting.value : draft()}
      />
      <span class="flex-1 text-muted-foreground/70">min</span>
      <Tag source={props.setting.source} />
      <Reset
        label={label}
        onReset={() => {
          setDraft(undefined)
          void props.onSave(null)
        }}
        shown={props.setting.source === 'override'}
      />
    </div>
  )
}

function Popup(props: {
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
      .action(SetAction, { id: props.id, ...change })
      .then(props.refresh)
      .catch((error: unknown) => console.warn('Cache warming', error))
  const state = () => props.state
  const warmCost = () => warmCostLine(state())
  const kept = () => {
    const value = state().kept
    return (
      value &&
      `Kept warm so far: ${dollars(value.cost)} (${value.pings} ping${value.pings === 1 ? '' : 's'})`
    )
  }
  const status = () => statusLines(state(), now())
  return (
    <PopoverContent align="end" class="w-80 p-1 font-mono" side="top">
      <div
        class="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground"
        title={state().provider ? `${state().provider}/${state().model}` : undefined}
      >
        <For each={lifetimeLines(state())}>{(line) => <div>{line}</div>}</For>
      </div>
      <SwitchRow
        label={`Keep ${props.name} warm`}
        onChange={(warm) => void set({ warm })}
        setting={state().warm}
      />
      <Show when={state().warm.value || state().compact.value}>
        <MinutesRow onSave={(minutes) => set({ minutes })} setting={state().minutes} />
      </Show>
      <Show when={state().warm.value && warmCost()}>
        {(line) => (
          <div class="px-2 pb-1 text-[11px] text-muted-foreground" data-warm-cost>
            {line()}
          </div>
        )}
      </Show>
      <Show when={state().kind === 'coordinator'}>
        <SwitchRow
          label="Compact before cold"
          onChange={(compact) => void set({ compact })}
          setting={state().compact}
        />
      </Show>
      <div class="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1.5 text-[11px] text-muted-foreground">
        <div class="text-foreground/80">
          <Show when={status().length} fallback="Off">
            <For each={status()}>{(line) => <div>{line}</div>}</For>
          </Show>
        </div>
        <Show when={kept()}>{(line) => <div>{line()}</div>}</Show>
        <Show when={state().last}>
          {(last) => (
            <div class={cn(failed(state()) && 'text-red-500')}>
              Last ping {formatAgo(last().at)}
              {last().error !== undefined
                ? `: ${last().error}`
                : ` · read ${tokens(last().read)}, wrote ${tokens(last().write)}`}
            </div>
          )}
        </Show>
        <Show when={state().compaction}>
          {(compaction) => (
            <div class={cn(compaction().error !== undefined && 'text-red-500')}>
              Compacted {clock(compaction().at)} · was {tokens(compaction().tokens)}
              {compaction().error !== undefined
                ? `: ${compaction().error}`
                : compaction().read !== undefined
                  ? ` · read ${tokens(compaction().read)}, wrote ${tokens(compaction().write)}`
                  : ''}
            </div>
          )}
        </Show>
        <Show when={state().agent}>
          {(agent) => (
            <Button
              class="h-auto justify-start p-0 text-[length:inherit] font-normal text-foreground/80 underline-offset-2 hover:underline"
              onClick={() => events.emit('subagents:open-definition', { name: agent() })}
              size={null}
              variant={null}
            >
              Defaults from Agents › {agent()}
            </Button>
          )}
        </Show>
      </div>
    </PopoverContent>
  )
}

function Chip(props: { id: ConversationId; name: string; label: string }) {
  const doc = useDocOf(() => props.id, CacheWarmingDoc)
  const summary = useConversationSummary(() => props.id)
  const { data, refetch } = useAction(
    StateAction,
    {
      get id() {
        return props.id
      },
    },
    { onError: keepLast, on: () => [doc(), summary()?.answerAt], every: 30_000 },
  )
  const now = useNow(30_000)
  return (
    <Show when={data()?.kind && data()}>
      {(state) => {
        const on = () => state().warm.value || state().compact.value
        const warm = () => isWarm(state(), now())
        const red = () => failed(state()) || state().compaction?.error !== undefined
        return (
          <Popover onOpenChange={(open) => void (open && refetch())}>
            <StatusPopoverTrigger
              aria-label={`${props.name}'s prompt cache`}
              class={cn(!on() && 'text-muted-foreground/60')}
              data-cache-warming={on() ? (warm() ? 'warm' : 'cold') : 'off'}
            >
              <Flame
                class={cn('size-3', on() && warm() && 'text-amber-500', red() && 'text-red-500')}
              />
              {props.label}
            </StatusPopoverTrigger>
            <Popup id={props.id} name={props.name} refresh={() => void refetch()} state={state()} />
          </Popover>
        )
      }}
    </Show>
  )
}

function UltimateChip() {
  const standing = useDocOf(() => ROOT, StandingDoc)
  return (
    <Show when={standing()?.ultimate}>
      {(ultimate) => <Chip id={ultimate()} label="@ultimate" name="@ultimate" />}
    </Show>
  )
}

function BranchChip() {
  const id = useConversationId()
  const summary = useConversationSummary(id)
  const coordinator = createMemo(() => {
    const row = summary()
    return row?.label === 'coordinator' && row.ownerTaskId === undefined ? id() : undefined
  })
  return (
    <Show when={coordinator()}>
      {(branch) => <Chip id={branch()} label="branch" name="this branch" />}
    </Show>
  )
}

export default defineWebExtension({
  slots: {
    'statusline.right': [
      { component: BranchChip, order: -2 },
      { component: UltimateChip, order: -1 },
    ],
  },
})
