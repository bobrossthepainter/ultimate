/**
 * Caddy in the browser: the machine's Ultimates and which of them Caddy serves, the DNS-01 setup, and the actions that
 * change them. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** This server's own state behind Caddy; `url` once its route and origin are registered. */
export type Status = {
  state:
    | 'off'
    | 'unconfigured'
    | 'not-installed'
    | 'missing-module'
    | 'not-loopback'
    | 'preview'
    | 'starting'
    | 'ready'
    | 'error'
  url?: string
  hint?: string
}

/** `caddy` in `~/.ultimate/settings.json`, without the token (the `CADDY_DNS_API_TOKEN` secret). */
export type Config = {
  /** Every project is `https://<domain>:<its port>`; the certificate is for `<domain>`. */
  domain?: string
  /** The first HTTPS port Caddy gives a ticked project; each next one takes the next free port. 9443 by default. */
  port: number
  /** A caddy-dns provider (`cloudflare`) for DNS-01; or `cert` and `key` for a certificate of your own. */
  dns?: string
  cert?: string
  key?: string
}

export type Project = {
  root: string
  name: string
  current: boolean
  /** Its loopback URL while it runs. */
  running?: string
  /** Its HTTPS port on the domain while Caddy serves it (ticked). */
  port?: number
  /** Its Caddy address while ticked, live or not. */
  url?: string
  /** Whether its route is in Caddy now (its server runs and registered it). */
  routed: boolean
  /** Its tailnet address, when the tailscale extension gave it a port. */
  tailnet?: string
  /**
   * Its systemd user service `ultimate@<home>.service`, on Linux with a reachable user systemd: whether it is
   * installed, and whether systemd runs it now (a project started by hand runs without it).
   */
  service?: { installed: boolean; active: boolean }
}

export type Overview = {
  config: Config
  tokenSet: boolean
  caddy: { installed: boolean; version?: string; module?: boolean; running: boolean }
  status: Status
  projects: Project[]
}

/** No arguments → this server's status behind Caddy. */
export const StatusAction = actionRef<null, Status>('caddy', 'status')
/** No arguments → the panel's data: the setup, the binary, and every Ultimate of this machine. */
export const OverviewAction = actionRef<null, Overview>('caddy', 'overview')
/** User-only. The DNS-01 (or certificate) setup → the saved config; every Ultimate applies it. */
export const ConfigureAction = actionRef<
  { domain: string; port?: number; dns?: string; cert?: string; key?: string },
  Config
>('caddy', 'configure')
/**
 * User-only. `{ root, on }` → ticks or unticks "serve by Caddy" for that project, keeping the port it had, else taking
 * the first free one from the setup's port; its server applies it.
 */
export const ServeAction = actionRef<{ root: string; on: boolean }, { port?: number }>(
  'caddy',
  'serve',
)
/** User-only. Downloads Caddy with the configured DNS provider's module into `~/.ultimate/caddy/`. */
export const InstallAction = actionRef<null, { version: string }>('caddy', 'install')
/**
 * User-only. `{ root, run }` → starts or stops that project's service, or installs it (`pnpm setup:machine --project
 * <root>`), with `next` naming what the user still has to do (the project runs by hand, so the service waits for it to
 * stop). This project's own server is never stopped from here.
 */
export const ServiceAction = actionRef<
  { root: string; run: 'start' | 'stop' | 'install' },
  { next?: string }
>('caddy', 'service')
/** No arguments → applies the setup again (after a token change or a fix) and returns this server's status. */
export const RetryAction = actionRef<null, Status>('caddy', 'retry')
