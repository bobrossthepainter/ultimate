/** @jsxImportSource @solidjs/web */
import { ChartColumnStacked } from '@lucide/solid'
import type { JSX } from '@solidjs/web'
import { createMemo, For, Match, Show, Switch } from 'solid-js'
import type { Accessor } from 'solid-js'
import { Button } from '@/components/ui/button.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { SegmentedControl, SegmentedControlItem } from '@/components/ui/segmented-control.solid.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.solid.tsx'
import {
  cn,
  defineWebExtension,
  errorMessage,
  formatTokens,
  Header,
  showSurface,
  StatusLine,
  switchConversation,
  useAction,
  useExtensionUiState,
  useNow,
} from '@/sdk/solid'
import { FRAMES, isFrame, localDay, shiftDay, windowOf } from './frame.ts'
import type { Frame } from './frame.ts'
import { AllAction, ReportAction, SpokeAction, SpokesAction } from './refs.ts'
import type { Bucket, Instance, Kinds, RebuildCause, Report, Spoke } from './refs.ts'

const KINDS = [
  { key: 'cacheWrite', label: 'cache write', bar: 'bg-brand' },
  { key: 'cacheRead', label: 'cache read', bar: 'bg-brand/40' },
  { key: 'output', label: 'output', bar: 'bg-warning/70' },
  { key: 'input', label: 'input', bar: 'bg-muted-foreground/50' },
] as const satisfies { key: keyof Kinds; label: string; bar: string }[]
const STACK_BOTTOM_UP = KINDS.toReversed()

const CAUSES: Record<RebuildCause, string> = {
  expired: 'cache expired',
  system: 'system prompt changed',
  model: 'model switched',
  prefix: 'earlier context changed',
}

type Unit = '$' | 'tokens'
const isUnit = (value: string): value is Unit => value === '$' || value === 'tokens'

const total = (kinds: Kinds) => kinds.input + kinds.output + kinds.cacheRead + kinds.cacheWrite
const dollars = (value: number) =>
  value >= 100
    ? `≈$${value.toFixed(0)}`
    : value >= 1
      ? `≈$${value.toFixed(2)}`
      : `≈$${value.toFixed(3)}`
const percent = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)} %` : '–'
const amount = (bucket: Bucket, unit: Unit) =>
  unit === '$' ? total(bucket.cost) : total(bucket.tokens)
const show = (value: number, unit: Unit) => (unit === '$' ? dollars(value) : formatTokens(value))
const rebuildShare = (count: number, cost: number, of: Kinds) =>
  count ? `${count} · ${percent(cost, total(of))} of cost` : '–'
const cacheHit = (tokens: Kinds) =>
  percent(tokens.cacheRead, tokens.cacheRead + tokens.cacheWrite + tokens.input)
const byAmount = <T extends Bucket>(buckets: Record<string, T>, unit: Unit) =>
  Object.entries(buckets).toSorted(([, a], [, b]) => amount(b, unit) - amount(a, unit))
const perCall = (value: number, calls: number, format: (value: number) => string) =>
  calls ? format(value / calls) : '–'

function Chips<T extends string>(props: {
  value: T
  options: readonly { id: T; title: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <SegmentedControl<T>
      aria-label={props.label}
      bind={[() => props.value, (value) => props.onChange(value)]}
      class="gap-0.5 border-0 p-0"
    >
      <For each={props.options}>
        {(option) => (
          <SegmentedControlItem class="rounded-md px-2 focus-visible:ring-1" value={option.id}>
            {option.title}
          </SegmentedControlItem>
        )}
      </For>
    </SegmentedControl>
  )
}

function Section(props: { title: string; meta?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="min-w-0 rounded-lg border border-border/70 bg-card/40">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <span class="section-label">{props.title}</span>
        {props.meta}
      </div>
      <div class="px-3 py-2.5">{props.children}</div>
    </section>
  )
}

function Swatch(props: { bar: string }) {
  return <span class={cn('inline-block size-2 shrink-0 rounded-[2px]', props.bar)} />
}

function Legend() {
  return (
    <span class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
      <For each={KINDS}>
        {(kind) => (
          <span class="flex items-center gap-1.5">
            <Swatch bar={kind.bar} />
            {kind.label}
          </span>
        )}
      </For>
    </span>
  )
}

function Empty(props: { children: JSX.Element }) {
  return (
    <p class="py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">
      {props.children}
    </p>
  )
}

function DayBar(props: { day: Report['daily'][number]; max: number }) {
  const cost = () => total(props.day.cost)
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`Cost on ${props.day.day}`}
        class="flex h-full min-w-[3px] flex-1 flex-col justify-end hover:opacity-80"
        render={(trigger) => <div {...trigger} />}
      >
        <div
          class="flex flex-col-reverse overflow-hidden rounded-t-[2px]"
          style={{
            height: `${props.max > 0 ? (cost() / props.max) * 100 : 0}%`,
          }}
        >
          <For each={STACK_BOTTOM_UP}>
            {(kind) => (
              <div
                class={kind.bar}
                style={{
                  'flex-grow': props.day.cost[kind.key],
                  'flex-basis': 0,
                }}
              />
            )}
          </For>
        </div>
      </TooltipTrigger>
      <TooltipContent class="font-mono text-[11px]">
        <div>
          {props.day.day} · {dollars(cost())} · {props.day.calls} calls
        </div>
        <For each={KINDS}>
          {(kind) => (
            <div class="flex items-center gap-1.5">
              <Swatch bar={kind.bar} />
              {kind.label} {dollars(props.day.cost[kind.key])}
            </div>
          )}
        </For>
      </TooltipContent>
    </Tooltip>
  )
}

function Daily(props: { report: Report }) {
  const days = () => props.report.daily
  const max = () => Math.max(...days().map((day) => total(day.cost)))
  return (
    <Show fallback={<Empty>no calls in this range</Empty>} when={days().length > 0}>
      <div class="flex flex-col gap-1">
        <div class="flex h-32 items-end gap-px" data-usage-daily>
          <For each={days()} keyed={(day) => day.day}>
            {(day) => <DayBar day={day()} max={max()} />}
          </For>
        </div>
        <div class="flex justify-between font-mono text-[10.5px] text-muted-foreground/70">
          <span>{days()[0].day}</span>
          <span>peak {dollars(max())}</span>
          <span>{days().at(-1)!.day}</span>
        </div>
      </div>
    </Show>
  )
}

function CostTypes(props: { report: Report; unit: Unit }) {
  const kinds = () => (props.unit === '$' ? props.report.total.cost : props.report.total.tokens)
  const of = (key: keyof Kinds) => kinds()[key]
  const whole = () => total(kinds())
  return (
    <div class="flex flex-col gap-2.5">
      <div class="flex h-2 overflow-hidden rounded-full bg-muted">
        <For each={KINDS}>
          {(kind) => (
            <div class={kind.bar} style={{ 'flex-grow': of(kind.key), 'flex-basis': 0 }} />
          )}
        </For>
      </div>
      <div class="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11.5px]">
        <For each={KINDS}>
          {(kind) => (
            <span class="flex items-center gap-1.5">
              <Swatch bar={kind.bar} />
              <span class="text-muted-foreground">{kind.label}</span>
              <span class="ml-auto tabular-nums">{show(of(kind.key), props.unit)}</span>
              <span class="w-10 text-right tabular-nums">{percent(of(kind.key), whole())}</span>
            </span>
          )}
        </For>
      </div>
    </div>
  )
}

function Share(props: { value: number; whole: number }) {
  return (
    <span class="flex items-center justify-end gap-2">
      <span class="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:inline-block">
        <span
          class="block h-full bg-brand/70"
          style={{
            width: `${props.whole > 0 ? (props.value / props.whole) * 100 : 0}%`,
          }}
        />
      </span>
      <span class="w-10 text-right">{percent(props.value, props.whole)}</span>
    </span>
  )
}

function Sub(props: { model: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={`${props.model} is covered by a plan`}
        class="ml-1.5 rounded-sm border border-border/70 px-1 text-[10px] text-muted-foreground"
        render={(trigger) => <span {...trigger} />}
      >
        sub
      </TooltipTrigger>
      <TooltipContent class="max-w-64 text-[12px]">
        Covered by your plan: shown as what these tokens would cost at list price, not what you pay.
      </TooltipContent>
    </Tooltip>
  )
}

function Table(props: { head: string[]; textColumns?: number[]; children: JSX.Element }) {
  const textColumns = () => props.textColumns ?? [0]
  return (
    <div class="overflow-x-auto">
      <table class="w-full border-collapse font-mono text-[11.5px]">
        <thead>
          <tr class="text-muted-foreground">
            <For each={props.head}>
              {(title, index) => (
                <th
                  class={cn(
                    'px-2 py-1 font-normal whitespace-nowrap first:pl-0 last:pr-0',
                    textColumns().includes(index()) ? 'text-left' : 'text-right',
                  )}
                >
                  {title}
                </th>
              )}
            </For>
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  )
}

function Cell(props: { children: JSX.Element; left?: boolean; class?: string }) {
  return (
    <td
      class={cn(
        'px-2 py-1 whitespace-nowrap first:pl-0 last:pr-0',
        !props.left && 'text-right tabular-nums',
        props.class,
      )}
    >
      {props.children}
    </td>
  )
}

function Row(props: { children: JSX.Element; hover?: boolean }) {
  return (
    <tr class={cn('border-t border-border/40', props.hover && 'hover:bg-accent/50')}>
      {props.children}
    </tr>
  )
}

function Rebuilds(props: { report: Report }) {
  const causes = () =>
    (
      Object.entries(props.report.rebuilds.byCause) as [
        RebuildCause,
        { count: number; cost: number },
      ][]
    ).toSorted(([, a], [, b]) => b.cost - a.cost)
  return (
    <Show fallback={<Empty>no cache rebuilds in this range</Empty>} when={causes().length > 0}>
      <Table head={['cause', 'rebuilds', 'cost', 'share']}>
        <For each={causes()} keyed={(entry) => entry[0]}>
          {(entry) => (
            <Row>
              <Cell left>{CAUSES[entry()[0]]}</Cell>
              <Cell>{entry()[1].count}</Cell>
              <Cell>{dollars(entry()[1].cost)}</Cell>
              <Cell>
                <Share value={entry()[1].cost} whole={props.report.rebuilds.cost} />
              </Cell>
            </Row>
          )}
        </For>
      </Table>
    </Show>
  )
}

function Roles(props: { report: Report; unit: Unit }) {
  const whole = () => amount(props.report.total, props.unit)
  const roles = () => byAmount(props.report.byRole, props.unit)
  return (
    <Show fallback={<Empty>no calls in this range</Empty>} when={roles().length > 0}>
      <Table
        head={[
          'role',
          'calls',
          props.unit === '$' ? 'cost' : 'tokens',
          'share',
          'per call',
          'rebuilds',
        ]}
      >
        <For each={roles()} keyed={(entry) => entry[0]}>
          {(entry) => {
            const bucket = () => entry()[1]
            const value = () => amount(bucket(), props.unit)
            return (
              <Row>
                <Cell left>{entry()[0]}</Cell>
                <Cell>{bucket().calls.toLocaleString()}</Cell>
                <Cell>{show(value(), props.unit)}</Cell>
                <Cell>
                  <Share value={value()} whole={whole()} />
                </Cell>
                <Cell>{perCall(value(), bucket().calls, (each) => show(each, props.unit))}</Cell>
                <Cell>{rebuildShare(bucket().rebuilds, bucket().rebuildCost, bucket().cost)}</Cell>
              </Row>
            )
          }}
        </For>
      </Table>
    </Show>
  )
}

function Models(props: { report: Report; unit: Unit }) {
  const whole = () => amount(props.report.total, props.unit)
  const models = () => byAmount(props.report.byModel, props.unit)
  return (
    <Table
      head={[
        'model',
        'calls',
        props.unit === '$' ? 'cost' : 'tokens',
        'share',
        '$/call',
        'context/call',
        'fresh/call',
        'cache hit',
      ]}
    >
      <For each={models()} keyed={(entry) => entry[0]}>
        {(entry) => {
          const bucket = () => entry()[1]
          const value = () => amount(bucket(), props.unit)
          return (
            <Row>
              <Cell left>
                {entry()[0]}
                <Show when={bucket().subscription}>
                  <Sub model={entry()[0]} />
                </Show>
              </Cell>
              <Cell>{bucket().calls ? bucket().calls.toLocaleString() : '–'}</Cell>
              <Cell>{show(value(), props.unit)}</Cell>
              <Cell>
                <Share value={value()} whole={whole()} />
              </Cell>
              <Cell>{perCall(total(bucket().cost), bucket().calls, dollars)}</Cell>
              <Cell>
                {perCall(
                  bucket().tokens.input + bucket().tokens.cacheRead + bucket().tokens.cacheWrite,
                  bucket().calls,
                  formatTokens,
                )}
              </Cell>
              <Cell>
                {perCall(
                  bucket().tokens.input + bucket().tokens.cacheWrite,
                  bucket().calls,
                  formatTokens,
                )}
              </Cell>
              <Cell>{cacheHit(bucket().tokens)}</Cell>
            </Row>
          )
        }}
      </For>
    </Table>
  )
}

function branchRoles(branch: Report['branches'][number]) {
  const cost = total(branch.total.cost)
  return Object.entries(branch.roles)
    .toSorted(([, a], [, b]) => b - a)
    .filter(([, value]) => cost > 0 && value / cost >= 0.01)
    .map(([role, value]) => `${role} ${percent(value, cost)}`)
    .join(' · ')
}

function Branches(props: { report: Report; unit: Unit; local: boolean }) {
  const open = (id: Report['branches'][number]['id']) => {
    switchConversation(id)
    showSurface('agent')
  }
  return (
    <Show fallback={<Empty>no calls in this range</Empty>} when={props.report.branches.length > 0}>
      <Table
        head={[
          'branch',
          props.unit === '$' ? 'cost' : 'tokens',
          'calls',
          'cache hit',
          'rebuilds',
          'roles',
        ]}
        textColumns={[0, 5]}
      >
        <For each={props.report.branches} keyed={(branch) => `${branch.title ?? ''}#${branch.id}`}>
          {(branch) => (
            <Row hover={props.local}>
              <Cell class="max-w-72 truncate" left>
                <Show when={props.local} fallback={branch().title ?? `#${branch().id}`}>
                  <Button
                    aria-label={`Open branch #${branch().id}${branch().title ? ` · ${branch().title}` : ''}`}
                    class="h-auto max-w-full justify-start truncate p-0 text-[length:inherit] font-normal hover:underline"
                    onClick={() => open(branch().id)}
                    size={null}
                    variant={null}
                  >
                    {branch().title ?? `#${branch().id}`}
                  </Button>
                </Show>
              </Cell>
              <Cell>{show(amount(branch().total, props.unit), props.unit)}</Cell>
              <Cell>{branch().total.calls.toLocaleString()}</Cell>
              <Cell>{cacheHit(branch().total.tokens)}</Cell>
              <Cell>
                {rebuildShare(branch().rebuilds, branch().rebuildCost, branch().total.cost)}
              </Cell>
              <Cell class="text-left text-muted-foreground" left>
                {branchRoles(branch())}
              </Cell>
            </Row>
          )}
        </For>
      </Table>
    </Show>
  )
}

function Instances(props: { instances: Instance[]; unit: Unit }) {
  return (
    <Section title="Instances">
      <Table
        head={['instance', props.unit === '$' ? 'cost' : 'tokens', 'calls', 'state']}
        textColumns={[0, 3]}
      >
        <For each={props.instances} keyed={(instance) => instance.label}>
          {(instance) => (
            <Row>
              <Cell left>{instance().label}</Cell>
              <Cell>
                {instance().report
                  ? show(amount(instance().report!.total, props.unit), props.unit)
                  : '–'}
              </Cell>
              <Cell>
                {instance().report && !instance().report!.fallback
                  ? instance().report!.total.calls.toLocaleString()
                  : '–'}
              </Cell>
              <Cell
                class={cn(
                  'text-left',
                  instance().error !== undefined
                    ? 'text-error'
                    : instance().report?.fallback
                      ? 'text-warning'
                      : 'text-muted-foreground',
                )}
                left
              >
                {instance().error !== undefined
                  ? `unreachable · ${instance().error}`
                  : instance().report?.fallback
                    ? 'totals only, all time (no usage extension)'
                    : 'full'}
              </Cell>
            </Row>
          )}
        </For>
      </Table>
    </Section>
  )
}

function Body(props: { report: Report; unit: Unit; local: boolean; note?: string }) {
  const whole = () => amount(props.report.total, props.unit)
  const subscription = () => Object.values(props.report.byModel).some((model) => model.subscription)
  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <span class="text-2xl font-medium tabular-nums" data-usage-total>
          {show(whole(), props.unit)}
        </span>
        <span class="font-mono text-[11.5px] text-muted-foreground">
          {props.unit === '$' ? 'estimated at list price' : 'tokens'} ·{' '}
          {!props.report.fallback && `${props.report.total.calls.toLocaleString()} calls · `}
          cache hit {cacheHit(props.report.total.tokens)}
          {props.unit === '$' &&
            props.report.undated.cost > 0 &&
            ` · plus ${dollars(props.report.undated.cost)} for tools, titles and pings, all time`}
        </span>
        <Tooltip>
          <TooltipTrigger
            aria-label="Not an invoice"
            class="ml-auto cursor-default font-mono text-[11px] text-muted-foreground/80 underline decoration-dotted underline-offset-2"
            render={(trigger) => <span {...trigger} />}
          >
            not an invoice
          </TooltipTrigger>
          <TooltipContent class="max-w-72 text-[12px]">
            Pi's list prices for the tokens each call reported. A provider reached through a plan
            {subscription() ? ' (rows marked sub)' : ''} is billed by the plan, not per token.
          </TooltipContent>
        </Tooltip>
      </div>
      <Show when={props.note}>
        <p class="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 font-mono text-[11.5px] text-warning">
          {props.note}
        </p>
      </Show>
      <Show
        fallback={<Details local={props.local} report={props.report} unit={props.unit} />}
        when={props.report.fallback}
      >
        <Section title="Cost type">
          <CostTypes report={props.report} unit={props.unit} />
        </Section>
        <Section title="By model">
          <Models report={props.report} unit={props.unit} />
        </Section>
      </Show>
    </div>
  )
}

function Details(props: { report: Report; unit: Unit; local: boolean }) {
  return (
    <>
      <Section meta={<Legend />} title="Daily cost">
        <Daily report={props.report} />
      </Section>
      <div class="grid gap-3 md:grid-cols-2">
        <Section title="Cost type">
          <CostTypes report={props.report} unit={props.unit} />
        </Section>
        <Section
          meta={
            <span>
              {props.report.rebuilds.count} · {dollars(props.report.rebuilds.cost)} ·{' '}
              {percent(props.report.rebuilds.cost, total(props.report.total.cost))} of cost
            </span>
          }
          title="Cache rebuilds"
        >
          <Rebuilds report={props.report} />
        </Section>
      </div>
      <Section title="By role">
        <Roles report={props.report} unit={props.unit} />
      </Section>
      <Section title="By model">
        <Models report={props.report} unit={props.unit} />
      </Section>
      <Section
        meta={props.local ? <span>click a branch to open it</span> : undefined}
        title="By branch"
      >
        <Branches local={props.local} report={props.report} unit={props.unit} />
      </Section>
    </>
  )
}

function State<T>(props: {
  data: T | undefined
  error: unknown
  children: (data: Accessor<T>) => JSX.Element
}) {
  return (
    <Switch fallback={<Empty>loading…</Empty>}>
      <Match when={props.data}>{(data) => props.children(data)}</Match>
      <Match when={props.error !== undefined}>
        <p class="py-10 text-center font-mono text-[11.5px] text-error">
          {errorMessage(props.error)}
        </p>
      </Match>
    </Switch>
  )
}

type Range = { since?: number; until?: number }

const rangeArgs = (range: () => Range) => ({
  get since() {
    return range().since
  },
  get until() {
    return range().until
  },
})

function Here(props: { range: Range; unit: Unit }) {
  const state = useAction(
    ReportAction,
    rangeArgs(() => props.range),
    { every: 30000 },
  )
  return (
    <State data={state.data()} error={state.error()}>
      {(report) => <Body local report={report()} unit={props.unit} />}
    </State>
  )
}

function OneSpoke(props: { spoke: Spoke; range: Range; unit: Unit }) {
  const state = useAction(SpokeAction, {
    get url() {
      return props.spoke.url
    },
    get since() {
      return props.range.since
    },
    get until() {
      return props.range.until
    },
  })
  return (
    <State data={state.data()} error={state.error()}>
      {(report) => (
        <Body
          local={false}
          note={
            report().fallback
              ? 'This instance has no usage extension: totals by model from its pi.usage documents, all time, whatever the range.'
              : undefined
          }
          report={report()}
          unit={props.unit}
        />
      )}
    </State>
  )
}

function All(props: { range: Range; unit: Unit }) {
  const state = useAction(
    AllAction,
    rangeArgs(() => props.range),
  )
  return (
    <State data={state.data()} error={state.error()}>
      {(data) => (
        <div class="flex flex-col gap-3">
          <Instances instances={data().instances} unit={props.unit} />
          <Body
            local={false}
            note={
              data().instances.some((item) => item.report?.fallback)
                ? 'Instances with totals only are listed above and left out of the numbers below.'
                : undefined
            }
            report={data().merged}
            unit={props.unit}
          />
        </div>
      )}
    </State>
  )
}

const HERE = 'here'
const ALL = 'all'
const spokeId = (spoke: Spoke) => spoke.url

const dayInput =
  'h-6 w-auto rounded-md border-border/70 bg-transparent px-1.5 text-[11px] text-foreground focus-visible:ring-1 focus-visible:ring-ring [color-scheme:light] dark:[color-scheme:dark]'

function CustomDays(props: {
  from: string
  to: string
  onChange: (days: { from: string; to: string }) => void
}) {
  return (
    <span class="flex items-center gap-1">
      <Input
        aria-label="From"
        class={dayInput}
        onValueChange={(value) => {
          if (value) props.onChange({ from: value, to: props.to })
        }}
        type="date"
        value={props.from}
      />
      <span>–</span>
      <Input
        aria-label="To"
        class={dayInput}
        onValueChange={(value) => {
          if (value) props.onChange({ from: props.from, to: value })
        }}
        type="date"
        value={props.to}
      />
    </span>
  )
}

function UsageSurface() {
  const [scope, setScope] = useExtensionUiState('scope', HERE)
  const [storedFrame, setFrame] = useExtensionUiState<string>('range', '30d')
  const [storedUnit, setUnit] = useExtensionUiState<string>('unit', '$')
  const [storedFrom, setFrom] = useExtensionUiState('from', '')
  const [storedTo, setTo] = useExtensionUiState('to', '')
  const now = useNow(60_000)
  const today = createMemo(() => localDay(new Date(now())))
  const frame = (): Frame => {
    const stored = storedFrame()
    return isFrame(stored) ? stored : '30d'
  }
  const unit = (): Unit => {
    const stored = storedUnit()
    return isUnit(stored) ? stored : '$'
  }
  const from = () => storedFrom() || shiftDay(today(), -29)
  const to = () => storedTo() || today()
  const range = createMemo(() => windowOf(frame(), today(), { from: from(), to: to() }))
  const spokesState = useAction(SpokesAction, null)
  const spokes = () => spokesState.data()?.spokes ?? []
  const scopes = () => [
    { id: HERE, title: 'this instance' },
    ...spokes().map((spoke) => ({ id: spokeId(spoke), title: spoke.label })),
    ...(spokes().length ? [{ id: ALL, title: 'all' }] : []),
  ]
  const shown = () => (scopes().some((item) => item.id === scope()) ? scope() : HERE)
  const spoke = () => spokes().find((item) => spokeId(item) === shown())
  return (
    <>
      <Header>
        <span class="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <ChartColumnStacked class="size-4 text-muted-foreground" />
          Usage
        </span>
        <span class="min-w-0 overflow-x-auto">
          <Chips label="Instance" onChange={setScope} options={scopes()} value={shown()} />
        </span>
      </Header>
      <main class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-usage-surface>
        <section class="mx-auto flex max-w-6xl flex-col gap-3 px-3 py-3 md:px-5">
          <div class="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Chips<Frame>
              label="Range"
              onChange={setFrame}
              options={FRAMES.map((id) => ({ id, title: id }))}
              value={frame()}
            />
            <Show when={frame() === 'custom'}>
              <CustomDays
                from={from()}
                onChange={(days) => {
                  setFrom(days.from)
                  setTo(days.to)
                }}
                to={to()}
              />
            </Show>
            <span class="h-4 w-px bg-border" />
            <Chips<Unit>
              label="Unit"
              onChange={setUnit}
              options={[
                { id: '$', title: '$' },
                { id: 'tokens', title: 'tokens' },
              ]}
              value={unit()}
            />
            <For each={spokesState.data()?.errors ?? []}>
              {(error) => <span class="text-warning">{error}</span>}
            </For>
          </div>
          <Switch fallback={<Here range={range()} unit={unit()} />}>
            <Match when={shown() === ALL}>
              <All range={range()} unit={unit()} />
            </Match>
            <Match when={spoke()}>
              {(current) => <OneSpoke range={range()} spoke={current()} unit={unit()} />}
            </Match>
          </Switch>
        </section>
      </main>
      <StatusLine />
    </>
  )
}

export default defineWebExtension({
  surfaces: [
    {
      id: 'usage',
      title: 'Usage',
      icon: ChartColumnStacked,
      description: 'What model calls cost here and on the instances this one reaches',
      order: 40,
      component: UsageSurface,
    },
  ],
  commands: [
    {
      id: 'usage.open',
      title: 'Open Usage',
      run: (context) => context.showSurface('usage'),
    },
  ],
})
