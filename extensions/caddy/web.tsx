import { ExternalLinkIcon, GlobeLockIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  useAction,
  useEvent,
  useSystem,
  useUltimate,
} from '@/sdk'
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
const dot = (tone: string) => <span className={cn('size-1.5 shrink-0 rounded-full', tone)} />
const small = 'h-7 gap-1.5 px-2 font-mono text-[11.5px]'
const field =
  'h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[12px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40'
const problem = (state?: Status['state']) =>
  !!state && !['off', 'starting', 'ready', 'preview'].includes(state)

function Heading({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-3 section-label">
      {children}
      {meta !== undefined && <span className="ml-auto flex items-center gap-1.5">{meta}</span>}
    </div>
  )
}

/**
 * The overview, read on mount, every 5 s while the panel shows (other Ultimates start, stop and register their
 * routes on their own), and when this server's extensions reload after a settings change.
 */
function useOverview() {
  const system = useSystem()
  const overview = useAction(OverviewAction, null, { onError: () => {} })
  const { refetch } = overview
  const signature = JSON.stringify([
    system?.access.origins,
    system?.extensions.find((extension) => extension.name === 'caddy')?.server?.loadedAt,
  ])
  const seen = useRef(signature)
  useEffect(() => {
    if (signature === seen.current) return
    seen.current = signature
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [signature, refetch])
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    const timer = setInterval(() => void refetch(), 5000)
    return () => clearInterval(timer)
  }, [refetch])
  useEvent('secrets:changed', () => void refetch())
  return overview
}

/** Runs `act`, then refetches; shows its failure under the button. */
function useRun(after: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
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

/** Domain, port, and either a DNS provider (with its token in Secrets) or a certificate of your own. */
function Setup({ data, refetch }: { data: Overview; refetch: () => Promise<unknown> }) {
  const { config } = data
  const [domain, setDomain] = useState(config.domain ?? '')
  const [port, setPort] = useState(String(config.port))
  const [mode, setMode] = useState<'dns' | 'cert'>(config.cert ? 'cert' : 'dns')
  const [dns, setDns] = useState(config.dns ?? 'cloudflare')
  const [cert, setCert] = useState(config.cert ?? '')
  const [key, setKey] = useState(config.key ?? '')
  const { busy, error, run } = useRun(refetch)
  const changed =
    domain !== (config.domain ?? '') ||
    port !== String(config.port) ||
    (mode === 'dns'
      ? dns !== (config.dns ?? '')
      : cert !== (config.cert ?? '') || key !== (config.key ?? ''))
  const save = () =>
    run(() =>
      api.action(ConfigureAction, {
        domain: domain.trim(),
        port: Number(port),
        ...(mode === 'dns' ? { dns: dns.trim() } : { cert: cert.trim(), key: key.trim() }),
      }),
    )
  const row = (label: string, control: ReactNode) => (
    <label className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[12px] text-muted-foreground">{label}</span>
      {control}
    </label>
  )
  return (
    <div className="mt-2.5 flex flex-col gap-1.5 px-3">
      {row(
        'Domain',
        <input
          className={field}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="ultimate.example.com"
          spellCheck={false}
          value={domain}
        />,
      )}
      {row(
        'Port',
        <input
          className={cn(field, 'max-w-20 flex-none')}
          inputMode="numeric"
          onChange={(event) => setPort(event.target.value)}
          value={port}
        />,
      )}
      {row(
        'Certificate',
        <div className="flex gap-1">
          {(['dns', 'cert'] as const).map((option) => (
            <Button
              className={cn(small, mode !== option && 'text-muted-foreground')}
              key={option}
              onClick={() => setMode(option)}
              size="sm"
              type="button"
              variant={mode === option ? 'outline' : 'ghost'}
            >
              {option === 'dns' ? 'DNS-01' : 'Own files'}
            </Button>
          ))}
        </div>,
      )}
      {mode === 'dns' ? (
        <>
          {row(
            'Provider',
            <input
              className={field}
              onChange={(event) => setDns(event.target.value)}
              placeholder="cloudflare"
              spellCheck={false}
              value={dns}
            />,
          )}
          {row(
            'API token',
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                className={cn(
                  'flex items-center gap-1.5 font-mono text-[11px]',
                  data.tokenSet ? 'text-muted-foreground' : 'text-warning',
                )}
              >
                {dot(data.tokenSet ? 'bg-success' : 'bg-warning')}
                {data.tokenSet ? 'set' : 'missing'}
              </span>
              <button
                className="text-[12px] text-brand outline-none hover:underline focus-visible:underline disabled:text-muted-foreground disabled:no-underline"
                disabled={!config.dns}
                onClick={() => events.emit('secrets:open', { name: TOKEN })}
                title={config.dns ? `${TOKEN} in Secrets` : 'Save a DNS provider first'}
                type="button"
              >
                {data.tokenSet ? 'Replace in Secrets' : 'Add in Secrets'}
              </button>
            </span>,
          )}
        </>
      ) : (
        <>
          {row(
            'Cert',
            <input
              className={field}
              onChange={(event) => setCert(event.target.value)}
              placeholder="/etc/ssl/wildcard.crt"
              spellCheck={false}
              value={cert}
            />,
          )}
          {row(
            'Key',
            <input
              className={field}
              onChange={(event) => setKey(event.target.value)}
              placeholder="/etc/ssl/wildcard.key"
              spellCheck={false}
              value={key}
            />,
          )}
        </>
      )}
      <div className="mt-1 flex items-center gap-1.5">
        <Button
          className={small}
          disabled={!changed || busy || !domain.trim()}
          onClick={() => void save()}
          size="sm"
          type="button"
        >
          {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          Save
        </Button>
      </div>
      {error && <p className="font-mono text-[11px] leading-snug text-error">{error}</p>}
    </div>
  )
}

/** The Caddy binary: missing, lacking the provider's module, or installed; one button downloads it. */
function Binary({ data, refetch }: { data: Overview; refetch: () => Promise<unknown> }) {
  const { caddy, config } = data
  const { busy, error, run } = useRun(refetch)
  const needs = !caddy.installed || caddy.module === false
  return (
    <div className="mt-2 px-3">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="w-16 shrink-0 text-muted-foreground">Caddy</span>
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-[11px]',
            needs ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          {dot(needs ? 'bg-warning' : caddy.running ? 'bg-success' : 'bg-muted-foreground/50')}
          {!caddy.installed
            ? 'not installed'
            : caddy.module === false
              ? `${caddy.version} · lacks ${config.dns}`
              : `${caddy.version} · ${caddy.running ? `serving :${config.port}` : 'stopped'}`}
        </span>
        <Button
          className={small}
          disabled={busy}
          onClick={() => void run(() => api.action(InstallAction))}
          size="sm"
          type="button"
          variant={needs ? 'default' : 'ghost'}
        >
          {busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
          {caddy.installed ? 'Reinstall' : 'Install'}
        </Button>
      </div>
      {busy && (
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          Downloading Caddy{config.dns ? ` with caddy-dns/${config.dns}` : ''}, about 50 MB…
        </p>
      )}
      {error && <p className="mt-1 font-mono text-[11px] leading-snug text-error">{error}</p>}
    </div>
  )
}

/** Where a row's link goes from this page: Caddy when it serves, else the tailnet from a tailnet page, else loopback. */
function href(project: Project) {
  if (project.url && project.routed) return project.url
  if (!project.running) return undefined
  const local =
    ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ||
    location.hostname.endsWith('.localhost')
  if (local) return project.running
  return project.tailnet
}

function Row({
  project,
  status,
  refetch,
}: {
  project: Project
  status: Status
  refetch: () => Promise<unknown>
}) {
  const { busy, error, run } = useRun(refetch)
  const service = useRun(refetch)
  const [output, setOutput] = useState<string>()
  const on = !!project.subdomain
  const link = href(project)
  // Start a stopped service, stop one systemd runs (never this server's own), install one that is missing.
  const act = !project.service
    ? undefined
    : !project.service.installed
      ? ({ run: 'install', label: 'Install as service' } as const)
      : !project.running
        ? ({ run: 'start', label: 'Start' } as const)
        : project.service.active && !project.current
          ? ({ run: 'stop', label: 'Stop' } as const)
          : undefined
  const state = project.current
    ? status.state === 'ready'
      ? { tone: 'bg-success', text: 'served' }
      : problem(status.state)
        ? { tone: 'bg-warning', text: status.hint ?? status.state }
        : on
          ? { tone: 'bg-muted-foreground/50', text: status.hint ?? 'starting…' }
          : undefined
    : on && project.routed
      ? { tone: 'bg-success', text: 'served' }
      : on && project.running
        ? { tone: 'bg-muted-foreground/50', text: 'registering…' }
        : on
          ? { tone: 'bg-muted-foreground/50', text: 'served once it runs' }
          : undefined
  return (
    <li aria-label={project.name} className="px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Checkbox
          aria-label={`Serve ${project.name} by Caddy`}
          checked={on}
          disabled={busy}
          onCheckedChange={(checked) =>
            void run(() => api.action(ServeAction, { root: project.root, on: checked === true }))
          }
          title="Serve by Caddy"
        />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground">
          {project.name}
          {project.current && <span className="ml-1.5 text-muted-foreground/70">· this</span>}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          {dot(project.running ? 'bg-success' : 'bg-muted-foreground/40')}
          {project.running ? `:${new URL(project.running).port}` : 'stopped'}
        </span>
        {act && (
          <Button
            className={cn(small, 'text-muted-foreground')}
            disabled={service.busy}
            onClick={() =>
              void service.run(async () => {
                setOutput(undefined)
                setOutput(
                  (await api.action(ServiceAction, { root: project.root, run: act.run })).output,
                )
              })
            }
            size="sm"
            title={
              act.run === 'install'
                ? 'Run it as a systemd user service (pnpm setup:machine --project …)'
                : `systemctl --user ${act.run} ultimate@…`
            }
            type="button"
            variant="ghost"
          >
            {service.busy && <LoaderCircleIcon className="size-3.5 animate-spin" />}
            {act.label}
          </Button>
        )}
        {link && !project.current ? (
          <a
            aria-label={`Open ${project.name}`}
            className="inline-flex shrink-0 items-center text-brand outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
            href={link}
            rel="noreferrer"
            target="_blank"
            title={link}
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
      </div>
      <p
        className="mt-0.5 truncate pl-6 font-mono text-[11px] text-muted-foreground/75"
        title={project.root}
      >
        {project.url ?? project.root}
      </p>
      {state && (
        <p
          className={cn(
            'mt-0.5 flex items-start gap-1.5 pl-6 text-[11.5px] leading-snug',
            state.tone === 'bg-warning' ? 'text-warning' : 'text-muted-foreground',
          )}
        >
          <span className="mt-1.5">{dot(state.tone)}</span>
          <span className="min-w-0 break-words">{state.text}</span>
        </p>
      )}
      {(error ?? service.error) && (
        <p className="mt-1 pl-6 font-mono text-[11px] leading-snug text-error">
          {error ?? service.error}
        </p>
      )}
      {output && (
        <pre className="mt-1 ml-6 max-h-32 overflow-auto font-mono text-[11px] leading-snug whitespace-pre-wrap text-muted-foreground">
          {output}
        </pre>
      )}
    </li>
  )
}

function HostingPanel() {
  const { data, error, loading, refetch } = useOverview()
  const [checking, setChecking] = useState(false)
  const served = data?.projects.filter((project) => project.subdomain).length ?? 0
  const meta =
    loading && !data ? (
      <LoaderCircleIcon className="size-3 animate-spin" />
    ) : data ? (
      <span className="text-muted-foreground/70">
        {served} of {data.projects.length} served
      </span>
    ) : undefined
  return (
    <section className="pt-3 pb-3.5">
      <Heading meta={meta}>Caddy</Heading>
      {error && !data && (
        <p className="mx-3 mt-2.5 font-mono text-[11px] leading-snug break-words text-error">
          {errorMessage(error)}
        </p>
      )}
      {data && (
        <>
          <Setup data={data} refetch={refetch} />
          <Binary data={data} refetch={refetch} />
          <div className="mt-4">
            <Heading
              meta={
                <Button
                  aria-label="Apply again"
                  className="size-6 text-muted-foreground"
                  disabled={checking}
                  onClick={async () => {
                    setChecking(true)
                    try {
                      await api.action(RetryAction)
                      await refetch()
                    } finally {
                      setChecking(false)
                    }
                  }}
                  size="icon-sm"
                  title="Apply again"
                  type="button"
                  variant="ghost"
                >
                  <RefreshCwIcon className={cn('size-3.5', checking && 'animate-spin')} />
                </Button>
              }
            >
              Ultimates on this machine
            </Heading>
            <ul className="mt-2 divide-y divide-border/70 border-y border-border/70">
              {data.projects.map((project) => (
                <Row key={project.root} project={project} refetch={refetch} status={data.status} />
              ))}
            </ul>
          </div>
          <p className="mx-3 mt-3 text-[11.5px] leading-snug text-muted-foreground/80">
            No login: anyone who reaches these addresses can run commands. Publish{' '}
            <span className="font-mono">*.{data.config.domain ?? 'your-domain'}</span> only in LAN
            or VPN DNS.
          </p>
        </>
      )}
    </section>
  )
}

/** "caddy" in the status line while this Ultimate is ticked: green when served, amber when it needs a fix. */
function Indicator() {
  const ui = useUltimate()
  const system = useSystem()
  // Failures show in the panel, not as notices: the status line reads it on every page.
  const status = useAction(StatusAction, null, { onError: () => {} })
  const { refetch } = status
  const signature = JSON.stringify([
    system?.access.origins,
    system?.extensionDiagnostics,
    system?.extensions.find((extension) => extension.name === 'caddy')?.server?.loadedAt,
  ])
  const seen = useRef(signature)
  useEffect(() => {
    if (signature === seen.current) return
    seen.current = signature
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    void refetch()
  }, [signature, refetch])
  const state = status.data?.state
  const trouble = problem(state)
  if (state !== 'ready' && !trouble) return null
  return (
    <button
      className={cn(
        '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground',
        trouble && 'text-warning',
      )}
      data-caddy={state}
      onClick={() => ui.openPanel('caddy')}
      title={trouble ? (status.data?.hint ?? 'Caddy needs a fix') : status.data?.url}
      type="button"
    >
      {dot(trouble ? 'bg-warning' : 'bg-success')}
      caddy
    </button>
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
