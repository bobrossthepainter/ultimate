import { FlameIcon } from 'lucide-react'
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
import { failing, IDLE_STOP, TTL } from './due.ts'
import { BranchCacheDoc, SetAction, StateAction } from './refs.ts'
import type { BranchCacheState } from './refs.ts'

const tokens = (count = 0) => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count))

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const failed = (state: BranchCacheState) =>
  state.last?.error !== undefined && failing(state.last.at, state.lastRequest)

function cacheLine(state: BranchCacheState, now: number) {
  if (state.lastRequest === undefined) return `No warm cache · ${tokens(state.tokens)} context`
  const until = state.lastRequest + TTL
  return `${until > now ? `Warm until ${clock(until)}` : `Cold since ${clock(until)}`} · ${tokens(state.tokens)} context`
}

function nextLine(state: BranchCacheState, now: number) {
  if (!state.warm && !state.compact) return 'Off'
  if (state.next)
    return `${state.next.step === 'ping' ? 'Next ping' : 'Compacts at'} ${clock(Math.max(now, state.next.at))}`
  if (state.idle) return state.idle
  if (state.lastRequest !== undefined && state.lastRequest + TTL <= now) return 'Cache is cold'
  if (state.warm && state.inputAt !== undefined && now - state.inputAt >= IDLE_STOP)
    return 'Stopped: no activity for 8 h'
  return 'Nothing due'
}

function Chip() {
  const id = useConversation((conversation) => conversation.id)
  const summary = useConversationSummary(id)
  const coordinator = summary?.label === 'coordinator' && summary.ownerTaskId === undefined
  const doc = useDocOf(coordinator ? id : undefined, BranchCacheDoc)
  const { data: state } = useAction(
    StateAction,
    { id: id! },
    { onError: keepLast, on: doc, every: 60_000, enabled: coordinator && id !== undefined },
  )
  const now = useNow(60_000)
  if (!coordinator || id === undefined || !state) return null
  const on = state.warm || state.compact
  const warm = state.lastRequest !== undefined && state.lastRequest + TTL > now
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
      <PopoverContent align="end" className="w-72 p-1 font-mono" side="top">
        <label className="flex h-8 cursor-pointer items-center justify-between px-2 text-[12px]">
          Keep this branch warm
          <Switch checked={state.warm} onCheckedChange={(value) => void set({ warm: value })} />
        </label>
        <label className="flex h-8 cursor-pointer items-center justify-between px-2 text-[12px]">
          Compact before it goes cold
          <Switch
            checked={state.compact}
            onCheckedChange={(value) => void set({ compact: value })}
          />
        </label>
        <div className="space-y-1 border-t border-border/70 px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
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
          <div className="pt-1 text-muted-foreground/70">
            Pings 55 min after the last request while the branch saw activity in 8 h; compacts
            instead once that ends, from {tokens(state.minCompactTokens)} context.
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2 }] },
})
