import { ChartColumnStackedIcon } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  cn,
  defineWebExtension,
  errorMessage,
  formatTokens,
  Header,
  StatusLine,
  useAction,
  useExtensionUiState,
  useUltimate,
} from '@/sdk'
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

const RANGES = { '7d': 7, '30d': 30, all: undefined } as const
type RangeName = keyof typeof RANGES
const isRange = (value: string): value is RangeName => Object.hasOwn(RANGES, value)
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
const perCall = (value: number, calls: number, format: (value: number) => string) =>
  calls ? format(value / calls) : '–'

function Chips<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly { id: T; title: string }[]
  onChange: (value: T) => void
  label: string
}) {
  return (
    <span
      aria-label={label}
      className="flex items-center gap-0.5 font-mono text-[11px]"
      role="group"
    >
      {options.map((option) => (
        <button
          aria-pressed={value === option.id}
          className={cn(
            'h-6 cursor-pointer rounded-md px-2 whitespace-nowrap transition-colors outline-none focus-visible:ring-1 focus-visible:ring-ring',
            value === option.id
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
          key={option.id}
          onClick={() => onChange(option.id)}
          type="button"
        >
          {option.title}
        </button>
      ))}
    </span>
  )
}

function Section({
  title,
  meta,
  children,
}: {
  title: string
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border/70 bg-card/40">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-3 py-2 font-mono text-[11px] text-muted-foreground">
        <span className="section-label">{title}</span>
        {meta}
      </div>
      <div className="px-3 py-2.5">{children}</div>
    </section>
  )
}

function Swatch({ bar }: { bar: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-[2px]', bar)} />
}

function Legend() {
  return (
    <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
      {KINDS.map((kind) => (
        <span className="flex items-center gap-1.5" key={kind.key}>
          <Swatch bar={kind.bar} />
          {kind.label}
        </span>
      ))}
    </span>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-6 text-center font-mono text-[11.5px] text-muted-foreground/70">{children}</p>
  )
}

function DayBar({ day, max }: { day: Report['daily'][number]; max: number }) {
  const cost = total(day.cost)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex h-full min-w-[3px] flex-1 flex-col justify-end hover:opacity-80">
          <div
            className="flex flex-col-reverse overflow-hidden rounded-t-[2px]"
            style={{ height: `${max > 0 ? (cost / max) * 100 : 0}%` }}
          >
            {STACK_BOTTOM_UP.map((kind) => (
              <div
                className={kind.bar}
                key={kind.key}
                style={{ flexGrow: day.cost[kind.key], flexBasis: 0 }}
              />
            ))}
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[11px]">
        <div>
          {day.day} · {dollars(cost)} · {day.calls} calls
        </div>
        {KINDS.map((kind) => (
          <div className="flex items-center gap-1.5" key={kind.key}>
            <Swatch bar={kind.bar} />
            {kind.label} {dollars(day.cost[kind.key])}
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

function Daily({ report }: { report: Report }) {
  const days = report.daily
  if (!days.length) return <Empty>no calls in this range</Empty>
  const max = Math.max(...days.map((day) => total(day.cost)))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-32 items-end gap-px" data-usage-daily>
        {days.map((day) => (
          <DayBar day={day} key={day.day} max={max} />
        ))}
      </div>
      <div className="flex justify-between font-mono text-[10.5px] text-muted-foreground/70">
        <span>{days[0].day}</span>
        <span>peak {dollars(max)}</span>
        <span>{days.at(-1)!.day}</span>
      </div>
    </div>
  )
}

function CostTypes({ report, unit }: { report: Report; unit: Unit }) {
  const of = (key: keyof Kinds) =>
    unit === '$' ? report.total.cost[key] : report.total.tokens[key]
  const whole = KINDS.reduce((sum, kind) => sum + of(kind.key), 0)
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {KINDS.map((kind) => (
          <div
            className={kind.bar}
            key={kind.key}
            style={{ flexGrow: of(kind.key), flexBasis: 0 }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11.5px]">
        {KINDS.map((kind) => (
          <span className="flex items-center gap-1.5" key={kind.key}>
            <Swatch bar={kind.bar} />
            <span className="text-muted-foreground">{kind.label}</span>
            <span className="ml-auto tabular-nums">{show(of(kind.key), unit)}</span>
            <span className="w-10 text-right tabular-nums">{percent(of(kind.key), whole)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function Share({ value, whole }: { value: number; whole: number }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:inline-block">
        <span
          className="block h-full bg-brand/70"
          style={{ width: `${whole > 0 ? (value / whole) * 100 : 0}%` }}
        />
      </span>
      <span className="w-10 text-right">{percent(value, whole)}</span>
    </span>
  )
}

function Sub() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-1.5 rounded-sm border border-border/70 px-1 text-[10px] text-muted-foreground">
          sub
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-[12px]">
        Covered by your plan: shown as what these tokens would cost at list price, not what you pay.
      </TooltipContent>
    </Tooltip>
  )
}

function Table({
  head,
  textColumns = [0],
  children,
}: {
  head: string[]
  textColumns?: number[]
  children: ReactNode
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[11.5px]">
        <thead>
          <tr className="text-muted-foreground">
            {head.map((title, index) => (
              <th
                className={cn(
                  'px-2 py-1 font-normal whitespace-nowrap first:pl-0 last:pr-0',
                  textColumns.includes(index) ? 'text-left' : 'text-right',
                )}
                key={title}
              >
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Cell({
  children,
  left,
  className,
}: {
  children: ReactNode
  left?: boolean
  className?: string
}) {
  return (
    <td
      className={cn(
        'px-2 py-1 whitespace-nowrap first:pl-0 last:pr-0',
        !left && 'text-right tabular-nums',
        className,
      )}
    >
      {children}
    </td>
  )
}

function Row({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <tr
      className={cn('border-t border-border/40', onClick && 'cursor-pointer hover:bg-accent/50')}
      onClick={onClick}
    >
      {children}
    </tr>
  )
}

function Rebuilds({ report }: { report: Report }) {
  const causes = (
    Object.entries(report.rebuilds.byCause) as [RebuildCause, { count: number; cost: number }][]
  ).toSorted(([, a], [, b]) => b.cost - a.cost)
  if (!causes.length) return <Empty>no cache rebuilds in this range</Empty>
  return (
    <Table head={['cause', 'rebuilds', 'cost', 'share']}>
      {causes.map(([cause, value]) => (
        <Row key={cause}>
          <Cell left>{CAUSES[cause]}</Cell>
          <Cell>{value.count}</Cell>
          <Cell>{dollars(value.cost)}</Cell>
          <Cell>
            <Share value={value.cost} whole={report.rebuilds.cost} />
          </Cell>
        </Row>
      ))}
    </Table>
  )
}

function Roles({ report, unit }: { report: Report; unit: Unit }) {
  const whole = amount(report.total, unit)
  const roles = Object.entries(report.byRole).toSorted(
    ([, a], [, b]) => amount(b, unit) - amount(a, unit),
  )
  if (!roles.length) return <Empty>no calls in this range</Empty>
  return (
    <Table
      head={['role', 'calls', unit === '$' ? 'cost' : 'tokens', 'share', 'per call', 'rebuilds']}
    >
      {roles.map(([role, bucket]) => (
        <Row key={role}>
          <Cell left>{role}</Cell>
          <Cell>{bucket.calls.toLocaleString()}</Cell>
          <Cell>{show(amount(bucket, unit), unit)}</Cell>
          <Cell>
            <Share value={amount(bucket, unit)} whole={whole} />
          </Cell>
          <Cell>{perCall(amount(bucket, unit), bucket.calls, (value) => show(value, unit))}</Cell>
          <Cell>
            {bucket.rebuilds
              ? `${bucket.rebuilds} · ${percent(bucket.rebuildCost, total(bucket.cost))} of cost`
              : '–'}
          </Cell>
        </Row>
      ))}
    </Table>
  )
}

function Models({ report, unit }: { report: Report; unit: Unit }) {
  const whole = amount(report.total, unit)
  const models = Object.entries(report.byModel).toSorted(
    ([, a], [, b]) => amount(b, unit) - amount(a, unit),
  )
  return (
    <Table
      head={[
        'model',
        'calls',
        unit === '$' ? 'cost' : 'tokens',
        'share',
        '$/call',
        'context/call',
        'fresh/call',
      ]}
    >
      {models.map(([model, bucket]) => (
        <Row key={model}>
          <Cell left>
            {model}
            {bucket.subscription && <Sub />}
          </Cell>
          <Cell>{bucket.calls ? bucket.calls.toLocaleString() : '–'}</Cell>
          <Cell>{show(amount(bucket, unit), unit)}</Cell>
          <Cell>
            <Share value={amount(bucket, unit)} whole={whole} />
          </Cell>
          <Cell>{perCall(total(bucket.cost), bucket.calls, dollars)}</Cell>
          <Cell>
            {perCall(
              bucket.tokens.input + bucket.tokens.cacheRead + bucket.tokens.cacheWrite,
              bucket.calls,
              formatTokens,
            )}
          </Cell>
          <Cell>
            {perCall(bucket.tokens.input + bucket.tokens.cacheWrite, bucket.calls, formatTokens)}
          </Cell>
        </Row>
      ))}
    </Table>
  )
}

function Branches({ report, unit, local }: { report: Report; unit: Unit; local: boolean }) {
  const { switchConversation, showSurface } = useUltimate()
  if (!report.branches.length) return <Empty>no calls in this range</Empty>
  return (
    <Table
      head={['branch', unit === '$' ? 'cost' : 'tokens', 'calls', 'roles']}
      textColumns={[0, 3]}
    >
      {report.branches.map((branch) => {
        const cost = total(branch.total.cost)
        const roles = Object.entries(branch.roles)
          .toSorted(([, a], [, b]) => b - a)
          .filter(([, value]) => cost > 0 && value / cost >= 0.01)
          .map(([role, value]) => `${role} ${percent(value, cost)}`)
          .join(' · ')
        return (
          <Row
            key={`${branch.title ?? ''}#${branch.id}`}
            onClick={
              local
                ? () => {
                    switchConversation(branch.id)
                    showSurface('agent')
                  }
                : undefined
            }
          >
            <Cell className="max-w-72 truncate" left>
              {branch.title ?? `#${branch.id}`}
            </Cell>
            <Cell>{show(amount(branch.total, unit), unit)}</Cell>
            <Cell>{branch.total.calls.toLocaleString()}</Cell>
            <Cell className="text-left text-muted-foreground" left>
              {roles}
            </Cell>
          </Row>
        )
      })}
    </Table>
  )
}

function Instances({ instances, unit }: { instances: Instance[]; unit: Unit }) {
  return (
    <Section title="Instances">
      <Table
        head={['instance', unit === '$' ? 'cost' : 'tokens', 'calls', 'state']}
        textColumns={[0, 3]}
      >
        {instances.map((instance) => (
          <Row key={instance.label}>
            <Cell left>{instance.label}</Cell>
            <Cell>{instance.report ? show(amount(instance.report.total, unit), unit) : '–'}</Cell>
            <Cell>
              {instance.report && !instance.report.fallback
                ? instance.report.total.calls.toLocaleString()
                : '–'}
            </Cell>
            <Cell
              className={cn(
                'text-left',
                instance.error !== undefined
                  ? 'text-error'
                  : instance.report?.fallback
                    ? 'text-warning'
                    : 'text-muted-foreground',
              )}
              left
            >
              {instance.error !== undefined
                ? `unreachable · ${instance.error}`
                : instance.report?.fallback
                  ? 'totals only, all time (no usage extension)'
                  : 'full'}
            </Cell>
          </Row>
        ))}
      </Table>
    </Section>
  )
}

function Body({
  report,
  unit,
  local,
  note,
}: {
  report: Report
  unit: Unit
  local: boolean
  note?: string
}) {
  const whole = amount(report.total, unit)
  const subscription = Object.values(report.byModel).some((model) => model.subscription)
  const prompt =
    report.total.tokens.cacheRead + report.total.tokens.cacheWrite + report.total.tokens.input
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
        <span className="text-2xl font-medium tabular-nums" data-usage-total>
          {show(whole, unit)}
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {unit === '$' ? 'estimated at list price' : 'tokens'} ·{' '}
          {!report.fallback && `${report.total.calls.toLocaleString()} calls · `}cache hit{' '}
          {percent(report.total.tokens.cacheRead, prompt)}
          {unit === '$' &&
            report.undated.cost > 0 &&
            ` · plus ${dollars(report.undated.cost)} for tools, titles and pings, all time`}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="ml-auto cursor-default font-mono text-[11px] text-muted-foreground/80 underline decoration-dotted underline-offset-2">
              not an invoice
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-72 text-[12px]">
            Pi's list prices for the tokens each call reported. A provider reached through a plan
            {subscription ? ' (rows marked sub)' : ''} is billed by the plan, not per token.
          </TooltipContent>
        </Tooltip>
      </div>
      {note && (
        <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 font-mono text-[11.5px] text-warning">
          {note}
        </p>
      )}
      {report.fallback ? (
        <Section title="Cost type">
          <CostTypes report={report} unit={unit} />
        </Section>
      ) : (
        <Details local={local} report={report} unit={unit} />
      )}
      {report.fallback && (
        <Section title="By model">
          <Models report={report} unit={unit} />
        </Section>
      )}
    </div>
  )
}

function Details({ report, unit, local }: { report: Report; unit: Unit; local: boolean }) {
  return (
    <>
      <Section meta={<Legend />} title="Daily cost">
        <Daily report={report} />
      </Section>
      <div className="grid gap-3 md:grid-cols-2">
        <Section title="Cost type">
          <CostTypes report={report} unit={unit} />
        </Section>
        <Section
          meta={
            <span>
              {report.rebuilds.count} · {dollars(report.rebuilds.cost)} ·{' '}
              {percent(report.rebuilds.cost, total(report.total.cost))} of cost
            </span>
          }
          title="Cache rebuilds"
        >
          <Rebuilds report={report} />
        </Section>
      </div>
      <Section title="By role">
        <Roles report={report} unit={unit} />
      </Section>
      <Section title="By model">
        <Models report={report} unit={unit} />
      </Section>
      <Section meta={local && <span>click a branch to open it</span>} title="By branch">
        <Branches local={local} report={report} unit={unit} />
      </Section>
    </>
  )
}

function State<T>({
  state,
  children,
}: {
  state: { data?: T; error?: unknown }
  children: (data: T) => ReactNode
}) {
  if (state.data !== undefined) return children(state.data)
  if (state.error !== undefined)
    return (
      <p className="py-10 text-center font-mono text-[11.5px] text-error">
        {errorMessage(state.error)}
      </p>
    )
  return <Empty>loading…</Empty>
}

type Range = { since?: number }

function Here({ range, unit }: { range: Range; unit: Unit }) {
  const state = useAction(ReportAction, range, { every: 30000 })
  return <State state={state}>{(report) => <Body local report={report} unit={unit} />}</State>
}

function OneSpoke({ spoke, range, unit }: { spoke: Spoke; range: Range; unit: Unit }) {
  const state = useAction(SpokeAction, { url: spoke.url, ...range })
  return (
    <State state={state}>
      {(report) => (
        <Body
          local={false}
          note={
            report.fallback
              ? 'This instance has no usage extension: totals by model from its pi.usage documents, all time, whatever the range.'
              : undefined
          }
          report={report}
          unit={unit}
        />
      )}
    </State>
  )
}

function All({ range, unit }: { range: Range; unit: Unit }) {
  const state = useAction(AllAction, range)
  return (
    <State state={state}>
      {({ instances, merged }) => (
        <div className="flex flex-col gap-3">
          <Instances instances={instances} unit={unit} />
          <Body
            local={false}
            note={
              instances.some((item) => item.report?.fallback)
                ? 'Instances with totals only are listed above and left out of the numbers below.'
                : undefined
            }
            report={merged}
            unit={unit}
          />
        </div>
      )}
    </State>
  )
}

const HERE = 'here'
const ALL = 'all'
const spokeId = (spoke: Spoke) => spoke.url

function useSince(days: number | undefined) {
  return useMemo(() => {
    if (days === undefined) return {}
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - days + 1)
    return { since: start.getTime() }
  }, [days])
}

function UsageSurface() {
  const [scope, setScope] = useExtensionUiState('scope', HERE)
  const [storedRange, setRange] = useExtensionUiState('range', '30d')
  const [storedUnit, setUnit] = useExtensionUiState('unit', '$')
  const rangeName: RangeName = isRange(storedRange) ? storedRange : '30d'
  const unit: Unit = isUnit(storedUnit) ? storedUnit : '$'
  const range = useSince(RANGES[rangeName])
  const spokesState = useAction(SpokesAction, null)
  const spokes = spokesState.data?.spokes ?? []
  const scopes = [
    { id: HERE, title: 'this instance' },
    ...spokes.map((spoke) => ({ id: spokeId(spoke), title: spoke.label })),
    ...(spokes.length ? [{ id: ALL, title: 'all' }] : []),
  ]
  const shown = scopes.some((item) => item.id === scope) ? scope : HERE
  const spoke = spokes.find((item) => spokeId(item) === shown)
  return (
    <>
      <Header>
        <span className="flex shrink-0 items-center gap-2 text-[13px] font-medium">
          <ChartColumnStackedIcon className="size-4 text-muted-foreground" />
          Usage
        </span>
        <span className="min-w-0 overflow-x-auto">
          <Chips label="Instance" onChange={setScope} options={scopes} value={shown} />
        </span>
      </Header>
      <main className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-usage-surface>
        <section className="mx-auto flex max-w-6xl flex-col gap-3 px-3 py-3 md:px-5">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Chips<RangeName>
              label="Range"
              onChange={setRange}
              options={(Object.keys(RANGES) as RangeName[]).map((id) => ({ id, title: id }))}
              value={rangeName}
            />
            <span className="h-4 w-px bg-border" />
            <Chips<Unit>
              label="Unit"
              onChange={setUnit}
              options={[
                { id: '$', title: '$' },
                { id: 'tokens', title: 'tokens' },
              ]}
              value={unit}
            />
            {spokesState.data?.errors.map((error) => (
              <span className="text-warning" key={error}>
                {error}
              </span>
            ))}
          </div>
          {shown === ALL ? (
            <All range={range} unit={unit} />
          ) : spoke ? (
            <OneSpoke range={range} spoke={spoke} unit={unit} />
          ) : (
            <Here range={range} unit={unit} />
          )}
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
      icon: ChartColumnStackedIcon,
      description: 'What model calls cost here and on the instances this one reaches',
      order: 40,
      component: UsageSurface,
    },
  ],
  commands: [
    { id: 'usage.open', title: 'Open Usage', run: (context) => context.showSurface('usage') },
  ],
})
