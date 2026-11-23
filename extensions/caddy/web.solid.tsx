import { ExternalLink, GlobeLockIcon, LoaderCircle, RefreshCw } from '@lucide/solid'
import { For, Show, createMemo, createSignal, untrack } from 'solid-js'
import type { JSX } from '@solidjs/web'
import { Button } from '@/components/ui/button.solid.tsx'
import { Checkbox } from '@/components/ui/checkbox.solid.tsx'
import { Input } from '@/components/ui/input.solid.tsx'
import { StatusButton } from '@/components/ui/status-trigger.solid.tsx'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  keepLast,
  openPanel,
  useAction,
  useEvent,
  useSystem,
} from '@/sdk/solid'
import {
  ConfigureAction,
  InstallAction,
  OverviewAction,
  RetryAction,
  ServeAction,
  ServiceAction,
  StatusAction,
} from './refs.ts'
import type { Overview, Project, Status } from './refs.ts'

const TOKEN = 'CADDY_DNS_API_TOKEN'
const Dot = (props: { tone: string }) => (
  <span class={cn('size-1.5 shrink-0 rounded-full', props.tone)} />
)
const small = 'h-7 gap-1.5 px-2 font-mono text-[11.5px]'
const problem = (state?: Status['state']) =>
  !!state && !['off', 'starting', 'ready', 'preview'].includes(state)

function Heading(props: { children: JSX.Element; meta?: JSX.Element }) {
  return (
    <div class="flex items-center gap-2 px-3 section-label">
      {props.children}
      <Show when={props.meta !== undefined}>
        <span class="ml-auto flex items-center gap-1.5">{props.meta}</span>
      </Show>
    </div>
  )
}

function useOverview() {
  const system = useSystem()
  const overview = useAction(OverviewAction, null, {
    onError: keepLast,
    every: 5000,
    on: () => [
      system()?.access.origins,
      system()?.extensions.find((extension) => extension.name === 'caddy')?.server?.loadedAt,
    ],
  })
  useEvent('secrets:changed', () => void overview.refetch())
  return overview
}

function useRun(after: () => Promise<unknown>) {
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const run = async (act: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await act()
      await after()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex items-center gap-2">
      <span class="w-16 shrink-0 text-[12px] text-muted-foreground">{props.label}</span>
      {props.children}
    </label>
  )
}

function Setup(props: { data: Overview; refetch: () => Promise<unknown> }) {
  const config = () => props.data.config
  const initial = untrack(() => props.data.config)
  const [domain, setDomain] = createSignal(initial.domain ?? '')
  const [port, setPort] = createSignal(String(initial.port))
  const [mode, setMode] = createSignal<'dns' | 'cert'>(initial.cert ? 'cert' : 'dns')
  const [dns, setDns] = createSignal(initial.dns ?? 'cloudflare')
  const [cert, setCert] = createSignal(initial.cert ?? '')
  const [key, setKey] = createSignal(initial.key ?? '')
  const { busy, error, run } = useRun(() => props.refetch())
  const changed = () =>
    domain() !== (config().domain ?? '') ||
    port() !== String(config().port) ||
    (mode() === 'dns'
      ? dns() !== (config().dns ?? '')
      : cert() !== (config().cert ?? '') || key() !== (config().key ?? ''))
  const save = () => {
    const args = {
      domain: domain().trim(),
      port: Number(port()),
      ...(mode() === 'dns' ? { dns: dns().trim() } : { cert: cert().trim(), key: key().trim() }),
    }
    return run(() => api.action(ConfigureAction, args))
  }
  return (
    <div class="mt-2.5 flex flex-col gap-1.5 px-3">
      <Field label="Domain">
        <Input
          class="flex-1"
          onValueChange={setDomain}
          placeholder="ultimate.example.com"
          value={domain()}
        />
      </Field>
      <Field label="Ports">
        <Input
          class="max-w-20 flex-none"
          inputmode="numeric"
          onValueChange={setPort}
          title="The first project's HTTPS port; each next one takes the next free port"
          value={port()}
        />
        <span class="text-[11.5px] text-muted-foreground">and up, one per project</span>
      </Field>
      <div class="flex items-center gap-2">
        <span class="w-16 shrink-0 text-[12px] text-muted-foreground">Certificate</span>
        <div class="flex gap-1">
          <For each={['dns', 'cert'] as const}>
            {(option) => (
              <Button
                class={cn(small, mode() !== option && 'text-muted-foreground')}
                onClick={() => setMode(option)}
                size="sm"
                variant={mode() === option ? 'outline' : 'ghost'}
              >
                {option === 'dns' ? 'DNS-01' : 'Own files'}
              </Button>
            )}
          </For>
        </div>
      </div>
      <Show
        when={mode() === 'dns'}
        fallback={
          <>
            <Field label="Cert">
              <Input
                class="flex-1"
                onValueChange={setCert}
                placeholder="/etc/ssl/ultimate.crt"
                value={cert()}
              />
            </Field>
            <Field label="Key">
              <Input
                class="flex-1"
                onValueChange={setKey}
                placeholder="/etc/ssl/ultimate.key"
                value={key()}
              />
            </Field>
          </>
        }
      >
        <Field label="Provider">
          <Input class="flex-1" onValueChange={setDns} placeholder="cloudflare" value={dns()} />
        </Field>
        <div class="flex items-center gap-2">
          <span class="w-16 shrink-0 text-[12px] text-muted-foreground">API token</span>
          <span class="flex min-w-0 flex-1 items-center gap-2">
            <span
              class={cn(
                'flex items-center gap-1.5 font-mono text-[11px]',
                props.data.tokenSet ? 'text-muted-foreground' : 'text-warning',
              )}
            >
              <Dot tone={props.data.tokenSet ? 'bg-success' : 'bg-warning'} />
              {props.data.tokenSet ? 'set' : 'missing'}
            </span>
            <Button
              class="h-auto text-[12px] font-normal text-brand outline-none hover:underline focus-visible:underline disabled:text-muted-foreground disabled:no-underline data-disabled:text-muted-foreground data-disabled:no-underline"
              disabled={!config().dns}
              onClick={() => events.emit('secrets:open', { name: TOKEN })}
              size={null}
              title={config().dns ? `${TOKEN} in Secrets` : 'Save a DNS provider first'}
              variant={null}
            >
              {props.data.tokenSet ? 'Replace in Secrets' : 'Add in Secrets'}
            </Button>
          </span>
        </div>
      </Show>
      <div class="mt-1 flex items-center gap-1.5">
        <Button
          class={small}
          disabled={!changed() || busy() || !domain().trim()}
          onClick={() => void save()}
          size="sm"
        >
          <Show when={busy()}>
            <LoaderCircle class="size-3.5 animate-spin" />
          </Show>
          Save
        </Button>
      </div>
      <Show when={error()}>
        <p class="font-mono text-[11px] leading-snug text-error">{error()}</p>
      </Show>
    </div>
  )
}

function Binary(props: { data: Overview; refetch: () => Promise<unknown> }) {
  const caddy = () => props.data.caddy
  const config = () => props.data.config
  const { busy, error, run } = useRun(() => props.refetch())
  const needs = () => !caddy().installed || caddy().module === false
  return (
    <div class="mt-2 px-3">
      <div class="flex items-center gap-2 text-[12px]">
        <span class="w-16 shrink-0 text-muted-foreground">Caddy</span>
        <span
          class={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-[11px]',
            needs() ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          <Dot
            tone={
              needs() ? 'bg-warning' : caddy().running ? 'bg-success' : 'bg-muted-foreground/50'
            }
          />
          {!caddy().installed
            ? 'not installed'
            : caddy().module === false
              ? `${caddy().version} · lacks ${config().dns}`
              : `${caddy().version} · ${caddy().running ? `serving :${config().port}` : 'stopped'}`}
        </span>
        <Button
          class={small}
          disabled={busy()}
          onClick={() => void run(() => api.action(InstallAction))}
          size="sm"
          variant={needs() ? 'default' : 'ghost'}
        >
          <Show when={busy()}>
            <LoaderCircle class="size-3.5 animate-spin" />
          </Show>
          {caddy().installed ? 'Reinstall' : 'Install'}
        </Button>
      </div>
      <Show when={busy()}>
        <p class="mt-1 text-[11.5px] text-muted-foreground">
          Downloading Caddy{config().dns ? ` with caddy-dns/${config().dns}` : ''}, about 50 MB…
        </p>
      </Show>
      <Show when={error()}>
        <p class="mt-1 font-mono text-[11px] leading-snug text-error">{error()}</p>
      </Show>
    </div>
  )
}

function href(project: Project) {
  if (project.url && project.routed) return project.url
  if (!project.running) return undefined
  const local =
    ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ||
    location.hostname.endsWith('.localhost')
  if (local) return project.running
  return project.tailnet
}

function serviceAct(project: Project) {
  if (!project.service) return undefined
  if (!project.service.installed) return { run: 'install', label: 'Install as service' } as const
  if (project.service.active)
    return project.current ? undefined : ({ run: 'stop', label: 'Stop' } as const)
  return !project.running ? ({ run: 'start', label: 'Start' } as const) : undefined
}

function stateOf(project: Project, status: Status) {
  const on = !!project.port
  if (project.current) {
    if (status.state === 'ready') return { tone: 'bg-success', text: 'served' }
    if (problem(status.state)) return { tone: 'bg-warning', text: status.hint ?? status.state }
    return on ? { tone: 'bg-muted-foreground/50', text: status.hint ?? 'starting…' } : undefined
  }
  if (on && project.routed) return { tone: 'bg-success', text: 'served' }
  if (on && project.running) return { tone: 'bg-muted-foreground/50', text: 'registering…' }
  return on ? { tone: 'bg-muted-foreground/50', text: 'served once it runs' } : undefined
}

function Row(props: { project: Project; status: Status; refetch: () => Promise<unknown> }) {
  const project = () => props.project
  const { busy, error, run } = useRun(() => props.refetch())
  const service = useRun(() => props.refetch())
  const [output, setOutput] = createSignal<string>()
  const link = () => href(project())
  const act = createMemo(() => serviceAct(project()))
  const state = () => stateOf(project(), props.status)
  const problemText = () => error() ?? service.error()
  return (
    <li aria-label={project().name} class="px-3 py-2.5">
      <div class="flex items-center gap-2">
        <Checkbox
          aria-label={`Serve ${project().name} by Caddy`}
          bind={[
            () => !!project().port,
            (on) => {
              const root = project().root
              void run(() => api.action(ServeAction, { root, on }))
            },
          ]}
          disabled={busy()}
          title="Serve by Caddy"
        />
        <span class="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {project().name}
          <Show when={project().current}>
            <span class="ml-1.5 text-muted-foreground/70">· this</span>
          </Show>
        </span>
        <span class="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Dot tone={project().running ? 'bg-success' : 'bg-muted-foreground/40'} />
          {project().running ? `:${new URL(project().running!).port}` : 'stopped'}
        </span>
        <Show when={act()}>
          {(next) => (
            <Button
              aria-label={`${next().label} ${project().name}`}
              class={cn(small, 'text-muted-foreground')}
              disabled={service.busy()}
              onClick={() => {
                const args = { root: project().root, run: next().run }
                void service.run(async () => {
                  setOutput(undefined)
                  setOutput((await api.action(ServiceAction, args)).next)
                })
              }}
              size="sm"
              title={
                next().run === 'install'
                  ? 'Run it as a systemd user service (pnpm setup:machine --project …)'
                  : `systemctl --user ${next().run} ultimate@…`
              }
              variant="ghost"
            >
              <Show when={service.busy()}>
                <LoaderCircle class="size-3.5 animate-spin" />
              </Show>
              {next().label}
            </Button>
          )}
        </Show>
        <Show when={!project().current && link()} fallback={<span class="w-3.5 shrink-0" />}>
          {(url) => (
            <a
              aria-label={`Open ${project().name}`}
              class="inline-flex shrink-0 items-center text-brand outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
              href={url()}
              rel="noreferrer"
              target="_blank"
              title={url()}
            >
              <ExternalLink class="size-3.5" />
            </a>
          )}
        </Show>
      </div>
      <p
        class="mt-0.5 truncate pl-6 font-mono text-[11px] text-muted-foreground/75"
        title={project().root}
      >
        {project().url ?? project().root}
      </p>
      <Show when={state()}>
        {(shown) => (
          <p
            class={cn(
              'mt-0.5 flex items-start gap-1.5 pl-6 text-[11.5px] leading-snug',
              shown().tone === 'bg-warning' ? 'text-warning' : 'text-muted-foreground',
            )}
          >
            <span class="mt-1.5">
              <Dot tone={shown().tone} />
            </span>
            <span class="min-w-0 break-words">{shown().text}</span>
          </p>
        )}
      </Show>
      <Show when={problemText()}>
        <p class="mt-1 pl-6 font-mono text-[11px] leading-snug text-error">{problemText()}</p>
      </Show>
      <Show when={output()}>
        <p class="mt-1 pl-6 text-[11.5px] leading-snug break-words text-warning">{output()}</p>
      </Show>
    </li>
  )
}

function HostingPanel() {
  const { data, error, loading, refetch } = useOverview()
  const [checking, setChecking] = createSignal(false)
  const served = () => data()?.projects.filter((project) => project.port).length ?? 0
  const retry = async () => {
    setChecking(true)
    try {
      await api.action(RetryAction)
      await refetch()
    } finally {
      setChecking(false)
    }
  }
  return (
    <section class="pt-3 pb-3.5">
      <Heading
        meta={
          loading() && !data() ? (
            <LoaderCircle class="size-3 animate-spin" />
          ) : data() ? (
            <span class="text-muted-foreground/70">
              {served()} of {data()!.projects.length} served
            </span>
          ) : undefined
        }
      >
        Caddy
      </Heading>
      <Show when={error() && !data()}>
        <p class="mx-3 mt-2.5 font-mono text-[11px] leading-snug break-words text-error">
          {errorMessage(error())}
        </p>
      </Show>
      <Show when={data()}>
        {(overview) => (
          <>
            <Setup data={overview()} refetch={refetch} />
            <Binary data={overview()} refetch={refetch} />
            <div class="mt-4">
              <Heading
                meta={
                  <Button
                    aria-label="Apply again"
                    class="size-6 text-muted-foreground"
                    disabled={checking()}
                    onClick={retry}
                    size="icon-sm"
                    title="Apply again"
                    variant="ghost"
                  >
                    <RefreshCw class={cn('size-3.5', checking() && 'animate-spin')} />
                  </Button>
                }
              >
                Ultimates on this machine
              </Heading>
              <ul class="mt-2 divide-y divide-border/70 border-y border-border/70">
                <For each={overview().projects} keyed={(project) => project.root}>
                  {(project) => (
                    <Row project={project()} refetch={refetch} status={overview().status} />
                  )}
                </For>
              </ul>
            </div>
            <p class="mx-3 mt-3 text-[11.5px] leading-snug text-muted-foreground/80">
              No login: anyone who reaches these addresses can run commands. Publish{' '}
              <span class="font-mono">{overview().config.domain ?? 'your-domain'}</span> only in LAN
              or VPN DNS, and keep these ports closed to the internet.
            </p>
          </>
        )}
      </Show>
    </section>
  )
}

function Indicator() {
  const system = useSystem()
  const status = useAction(StatusAction, null, {
    onError: keepLast,
    on: () => [
      system()?.access.origins,
      system()?.extensionDiagnostics,
      system()?.extensions.find((extension) => extension.name === 'caddy')?.server?.loadedAt,
    ],
  })
  const state = () => status.data()?.state
  const trouble = () => problem(state())
  return (
    <Show when={state() === 'ready' || trouble()}>
      <StatusButton
        aria-label="Show Hosting panel"
        class={cn(trouble() && 'text-warning')}
        data-caddy={state()}
        onClick={() => openPanel('caddy')}
        title={trouble() ? (status.data()?.hint ?? 'Caddy needs a fix') : status.data()?.url}
      >
        <Dot tone={trouble() ? 'bg-warning' : 'bg-success'} />
        caddy
      </StatusButton>
    </Show>
  )
}

export default defineWebExtension({
  slots: { 'statusline.right': [Indicator] },
  panels: [
    {
      id: 'caddy',
      title: 'Hosting',
      icon: GlobeLockIcon,
      component: HostingPanel,
      order: 10,
      tab: false,
    },
  ],
  commands: [
    {
      id: 'caddy.panel',
      title: 'Hosting (Caddy)…',
      run: (context) => context.openPanel('caddy'),
    },
  ],
})
