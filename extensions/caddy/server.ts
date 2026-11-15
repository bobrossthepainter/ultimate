import { meansNone, overshadowed } from '../../lib/errors.ts'
import { createHash, randomUUID } from 'node:crypto'
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants, existsSync } from 'node:fs'
import { request } from 'node:http'
import { basename, isAbsolute, join } from 'node:path'
import { defineExtension } from '@earendil-works/pi-durable'
import { acquireLock, alive } from '../../lib/lock.ts'
import { projectHome } from '../../lib/project-paths.ts'
import { exec } from '../../lib/exec.ts'
import { spawn } from '../../lib/spawn.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { readSecret } from '../../lib/secrets.ts'
import { readSettings, updateSettings, userSettingsPath } from '../../lib/settings.ts'
import { implementAction } from '../../lib/actions.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { ExtensionAction } from '../../server/actions.ts'
import { TailscaleApi } from '../tailscale/api.ts'
import { CaddyApi } from './api.ts'
import {
  ConfigureAction,
  InstallAction,
  OverviewAction,
  RetryAction,
  ServeAction,
  ServiceAction,
  StatusAction,
} from './refs.ts'
import type { Config, Overview, Project, Status } from './refs.ts'

export const TOKEN = 'CADDY_DNS_API_TOKEN'
type Settings = Partial<Config> & { serve?: Record<string, { port: number }> }
type Route = { root: string; target: string; owner: string; published?: true }
type Registry = { routes: Record<string, Route>; token?: string }

const paths = (userHome: string) => {
  const dir = join(userHome, '.ultimate/caddy')
  return {
    dir,
    binary: process.env.CADDY_COMMAND ?? join(dir, 'caddy'),
    socket: join(dir, 'admin.sock'),
    boot: join(dir, 'admin.caddyfile'),
    caddyfile: join(dir, 'Caddyfile'),
    registry: join(dir, 'routes.json'),
    log: join(dir, 'caddy.log'),
  }
}
type Paths = ReturnType<typeof paths>

async function settingsOf(userHome: string): Promise<Settings> {
  const value = (await readSettings(userSettingsPath(userHome))).caddy
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
const DOMAIN = /^(?=.{1,200}$)([a-z0-9-]+\.)+[a-z]{2,}$/
const PROVIDER = /^[a-z0-9_]+$/
const PORT = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
const file = (value: unknown) =>
  typeof value === 'string' && isAbsolute(value) && !/["\\\n\r{}]/.test(value)

export function configOf(settings: Settings): Config {
  const { domain, port = 9443, dns, cert, key } = settings
  const invalid = (field: string) =>
    new Error(`Invalid caddy.${field} in ~/.ultimate/settings.json`)
  if (domain !== undefined && (typeof domain !== 'string' || !DOMAIN.test(domain)))
    throw invalid('domain')
  if (!PORT(port)) throw invalid('port')
  if (dns !== undefined && (typeof dns !== 'string' || !PROVIDER.test(dns))) throw invalid('dns')
  if (cert !== undefined && !file(cert)) throw invalid('cert')
  if (key !== undefined && !file(key)) throw invalid('key')
  return {
    port,
    ...(domain && { domain }),
    ...(dns && { dns }),
    ...(!dns && cert && key && { cert, key }),
  }
}
const originOf = (port: number, config: Config) =>
  new URL(`https://${config.domain}:${port}`).origin

const globals = (files: Paths) =>
  [`\tadmin "unix/${files.socket}|0600"`, '\tpersist_config off'].join('\n')

export function caddyfile(config: Config, routes: Record<string, Route>, files: Paths) {
  const tls = config.dns
    ? `\ttls {\n\t\tdns ${config.dns} {env.${TOKEN}}\n\t\tresolvers 1.1.1.1 8.8.8.8\n\t}`
    : `\ttls "${config.cert}" "${config.key}"`
  const sites = Object.keys(routes)
    .toSorted((a, b) => Number(a) - Number(b))
    .map(
      (port) =>
        `${config.domain}:${port} {\n${tls}\n\treverse_proxy ${new URL(routes[port].target).host}\n}\n`,
    )
  return `{
${globals(files)}
\tauto_https disable_redirects
\tlog {
\t\toutput file "${files.log}"
\t}
}
${sites.join('')}`
}

function admin(socket: string, method: string, path: string, body?: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const call = request(
      {
        socketPath: socket,
        method,
        path,
        headers: body === undefined ? {} : { 'Content-Type': 'text/caddyfile' },
        timeout: 15000,
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (text += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
      },
    )
    call.on('timeout', () => call.destroy(new Error('Caddy admin timed out')))
    call.on('error', reject)
    call.end(body)
  })
}
const running = (files: Paths) =>
  admin(files.socket, 'GET', '/config/').then(
    (response) => response.status === 200,
    () => false,
  )

async function probe(files: Paths, dns?: string) {
  try {
    await access(files.binary, constants.X_OK)
  } catch {
    return undefined
  }
  const version = (await exec(files.binary, ['version'], { timeout: 10000 })).stdout.split(' ')[0]
  if (!dns) return { version }
  const modules = (await exec(files.binary, ['list-modules'], { timeout: 10000 })).stdout
  return { version, module: modules.split('\n').includes(`dns.providers.${dns}`) }
}

async function start(files: Paths, token: string | undefined) {
  await writeFile(files.boot, `{\n${globals(files)}\n}\n`)
  const child = spawn(files.binary, ['start', '--config', files.boot, '--adapter', 'caddyfile'], {
    stdio: 'ignore',
    env: { ...process.env, ...(token && { [TOKEN]: token }) },
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`caddy start exited with ${code}; see ${files.log}`)
}

const stop = (files: Paths) =>
  admin(files.socket, 'POST', '/stop').then(
    () => undefined,
    () => {},
  )

const digest = (token: string | undefined) =>
  token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : undefined

const holds = (port: string, route: Route, settings: Settings) =>
  alive(Number(route.owner.split(':')[0])) &&
  (route.published || String(settings.serve?.[route.root]?.port) === port)

async function withRegistry<T>(
  files: Paths,
  userHome: string,
  use: (registry: Registry) => Promise<T>,
) {
  await mkdir(files.dir, { recursive: true, mode: 0o700 })
  const lock = await acquireLock(`${files.registry}.lock`, { pid: process.pid }, 120000)
  try {
    const registry = await readJson<Registry>(files.registry, { routes: {} })
    const settings = await settingsOf(userHome)
    for (const [port, route] of Object.entries(registry.routes))
      if (!holds(port, route, settings)) delete registry.routes[port]
    const result = await use(registry)
    await writeJson(files.registry, registry, { mode: 0o600 })
    return result
  } finally {
    await lock.close()
  }
}

async function apply(files: Paths, config: Config, registry: Registry, token: string | undefined) {
  const text = caddyfile(config, registry.routes, files)
  await writeFile(files.caddyfile, text)
  const live = await running(files)
  const hash = digest(token) ?? 'none'
  const stale = live && registry.token !== hash
  if (stale) await stop(files)
  if (!live || stale) {
    if (!Object.keys(registry.routes).length) return
    await start(files, token)
    registry.token = hash
  }
  const loaded = await admin(files.socket, 'POST', '/load', text)
  if (loaded.status !== 200) {
    let message: string | undefined
    try {
      message = (JSON.parse(loaded.body) as { error?: string }).error
    } catch (error) {
      overshadowed(error)
    }
    throw new Error(message ?? `Caddy refused the config (${loaded.status})`)
  }
}

async function updateCaddy(
  userHome: string,
  change: (previous: Settings, published: Set<number>) => Settings,
) {
  await allocating(userHome, async (published) => {
    await updateSettings(userSettingsPath(userHome), (settings) => {
      settings.caddy = change((settings.caddy ?? {}) as Settings, published)
    })
  })
}

async function allocating<T>(userHome: string, use: (published: Set<number>) => Promise<T>) {
  const files = paths(userHome)
  await mkdir(files.dir, { recursive: true, mode: 0o700 })
  const lock = await acquireLock(join(files.dir, 'settings.lock'), { pid: process.pid }, 30000)
  try {
    const registry = await readJson<Registry>(files.registry, { routes: {} })
    const published = Object.entries(registry.routes)
      .filter(([, route]) => route.published && alive(Number(route.owner.split(':')[0])))
      .map(([key]) => Number(key))
    return await use(new Set(published))
  } finally {
    await lock.close()
  }
}

const scratch = (host: ExtensionHost) => host.home !== projectHome(host.projectRoot, host.userHome)

const unitOf = (home: string) => `ultimate@${basename(home)}.service`

async function services(homes: string[]): Promise<Map<string, NonNullable<Project['service']>>> {
  if (process.platform !== 'linux' || !homes.length) return new Map()
  const { stdout } = await exec(
    'systemctl',
    ['--user', 'show', '-p', 'LoadState,ActiveState', ...homes.map(unitOf)],
    { timeout: 10000 },
  ).catch(() => {
    return { stdout: '' }
  })
  const blocks = stdout.trim() ? stdout.trim().split('\n\n') : []
  return new Map(
    blocks.flatMap((block, index) => {
      const home = homes[index]
      const field = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(block)?.[1]
      return home
        ? [
            [
              home,
              {
                installed: field('LoadState') === 'loaded' && existsSync(join(home, 'service.env')),
                active: ['active', 'activating', 'reloading'].includes(field('ActiveState') ?? ''),
              },
            ],
          ]
        : []
    }),
  )
}

function nextPort(base: number, taken: Set<number>) {
  let port = base
  while (taken.has(port)) port++
  if (port > 65535) throw new Error(`No free port from ${base} up`)
  return port
}

const statuses = new WeakMap<ExtensionHost, Status>()
const retries = new WeakMap<ExtensionHost, () => Promise<void>>()
export const reloadOnSettings = true

export async function secrets(host: ExtensionHost) {
  return (await settingsOf(host.userHome)).dns
    ? [
        {
          name: TOKEN,
          description: 'DNS provider API token for the Caddy certificate (DNS-01)',
        },
      ]
    : []
}

export const actions: Record<string, ExtensionAction> = {
  status: implementAction(
    StatusAction,
    (_args, { host }): Status => statuses.get(host) ?? { state: 'off' },
  ),
  retry: implementAction(RetryAction, async (_args, { host }): Promise<Status> => {
    await retries.get(host)?.()
    return statuses.get(host) ?? { state: 'off' }
  }),
  overview: implementAction(OverviewAction, async (_args, { host }): Promise<Overview> => {
    const files = paths(host.userHome)
    const settings = await settingsOf(host.userHome)
    const config = configOf(settings)
    const [binary, live, token, registry, ports, projects] = await Promise.all([
      probe(files, config.dns).catch(meansNone),
      running(files),
      readSecret(host.userHome, TOKEN),
      readJson<Registry>(files.registry, { routes: {} }),
      readJson<{ ports?: Record<string, { port: number }> }>(
        join(host.userHome, '.ultimate/tailscale.json'),
        {},
      ),
      host.projects(),
    ])
    const units = await services(
      scratch(host) ? [] : projects.flatMap((project) => (project.root ? [project.home] : [])),
    )
    const tailnet = host.want(TailscaleApi)?.status().url
    const routed = new Set(
      Object.entries(registry.routes)
        .filter(([port, route]) => !route.published && holds(port, route, settings))
        .map(([, route]) => route.root),
    )
    return {
      config,
      tokenSet: !!token,
      caddy: {
        installed: !!binary,
        ...(binary?.version && { version: binary.version }),
        ...(binary && 'module' in binary && { module: binary.module }),
        running: live,
      },
      status: statuses.get(host) ?? { state: 'off' },
      projects: projects.flatMap((project) => {
        if (!project.root) return []
        const served = settings.serve?.[project.root]?.port
        const port = ports.ports?.[project.root]?.port
        const current = project.current
        const url = current ? host.system().process.url : project.running?.url
        const service = units.get(project.home)
        return [
          {
            root: project.root,
            name: project.name,
            current,
            ...(url && { running: url }),
            ...(served && { port: served }),
            ...(served && config.domain && { url: originOf(served, config) }),
            routed: routed.has(project.root),
            ...(tailnet && port && { tailnet: `https://${new URL(tailnet).hostname}:${port}` }),
            ...(service && { service }),
          },
        ]
      }),
    }
  }),
  configure: implementAction(ConfigureAction, async (args, { host }) => {
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
    const { domain, port = 9443, dns, cert, key } = input as Record<string, unknown>
    if (typeof domain !== 'string' || !DOMAIN.test(domain))
      throw new Error('domain must be a DNS name such as ultimate.example.com')
    if (!PORT(port)) throw new Error('port must be between 1 and 65535')
    if (dns !== undefined && (typeof dns !== 'string' || !PROVIDER.test(dns)))
      throw new Error('dns must be a caddy-dns provider name such as cloudflare')
    if (!dns && (!file(cert) || !file(key)))
      throw new Error('Give a DNS provider, or absolute paths to a certificate and key')
    await updateCaddy(host.userHome, (previous) => ({
      domain,
      port,
      ...(dns ? { dns } : { cert: cert as string, key: key as string }),
      ...(previous.serve && { serve: previous.serve }),
    }))
    return configOf(await settingsOf(host.userHome))
  }),
  serve: implementAction(ServeAction, async (args, { host }): Promise<{ port?: number }> => {
    const { root, on } = (args ?? {}) as { root?: unknown; on?: unknown }
    if (typeof root !== 'string' || typeof on !== 'boolean') throw new Error('Give { root, on }')
    if (!(await host.projects()).some((project) => project.root === root))
      throw new Error(`No Ultimate project at ${root}`)
    let port: number | undefined
    await updateCaddy(host.userHome, (previous, published) => {
      const serve = { ...previous.serve }
      if (on) {
        const taken = new Set([
          ...published,
          ...Object.entries(serve).flatMap(([other, entry]) =>
            other === root ? [] : [entry.port],
          ),
        ])
        const kept = serve[root]?.port
        port = PORT(kept) && !taken.has(kept) ? kept : nextPort(configOf(previous).port, taken)
        serve[root] = { port }
      } else delete serve[root]
      return { ...previous, serve }
    })
    return port ? { port } : {}
  }),
  service: implementAction(ServiceAction, async (args, { host }): Promise<{ next?: string }> => {
    const { root, run } = (args ?? {}) as { root?: unknown; run?: unknown }
    if (typeof root !== 'string' || (run !== 'start' && run !== 'stop' && run !== 'install'))
      throw new Error("Give { root, run: 'start' | 'stop' | 'install' }")
    if (scratch(host)) throw new Error('Previews do not start or stop services.')
    const project = (await host.projects()).find((entry) => entry.root === root)
    if (!project) throw new Error(`No Ultimate project at ${root}`)
    if (run === 'install') {
      const { stdout } = await exec(
        process.execPath,
        [join(host.ultimateRoot, 'scripts/setup-machine.ts'), '--project', root],
        { timeout: 60000 },
      )
      const next = stdout.split('\n').find((line) => line.includes('runs outside systemd'))
      return next ? { next } : {}
    }
    if (run === 'stop' && project.current)
      throw new Error('Stop this Ultimate from another one, or with systemctl.')
    if (run === 'start' && (project.current || project.running))
      throw new Error(`${project.name} already runs; stop it first.`)
    await exec('systemctl', ['--user', run, '--no-block', unitOf(project.home)], {
      timeout: 10000,
    })
    return {}
  }),
  install: implementAction(InstallAction, async (_args, { host }) => {
    const files = paths(host.userHome)
    const config = configOf(await settingsOf(host.userHome))
    const { dns } = config
    const os = { linux: 'linux', darwin: 'darwin' }[process.platform as string]
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch as string]
    if (!os || !arch) throw new Error(`No Caddy download for ${process.platform}/${process.arch}`)
    const url = new URL('https://caddyserver.com/api/download')
    url.search = new URLSearchParams({
      os,
      arch,
      ...(dns && { p: `github.com/caddy-dns/${dns}` }),
    }).toString()
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok)
      throw new Error(
        `Caddy download failed (${response.status})${dns ? `; is caddy-dns/${dns} a provider?` : ''}`,
      )
    await mkdir(files.dir, { recursive: true, mode: 0o700 })
    const temporary = `${files.binary}.${process.pid}.tmp`
    await writeFile(temporary, new Uint8Array(await response.arrayBuffer()))
    await chmod(temporary, 0o755)
    await withRegistry(files, host.userHome, async (registry) => {
      const current = configOf(await settingsOf(host.userHome))
      if (current.dns !== dns) {
        await rm(temporary, { force: true })
        throw new Error('The DNS provider changed during the download; install again.')
      }
      const token = dns ? await readSecret(host.userHome, TOKEN) : undefined
      const live = await running(files)
      if (live) await stop(files)
      await rename(temporary, files.binary).catch(async (error: unknown) => {
        await rm(temporary, { force: true })
        throw error
      })
      if (live && current.domain && (!dns || token)) await apply(files, current, registry, token)
    })
    const version = (await probe(files))?.version ?? 'unknown'
    await retries.get(host)?.()
    return { version }
  }),
}
export const userActions = ['configure', 'serve', 'install', 'service']
export const pollActions = ['overview', 'status']

export default function caddy(host: ExtensionHost) {
  const files = paths(host.userHome)
  const owner = `${process.pid}:${randomUUID()}`
  const temporary = scratch(host)
  let status: Status = { state: 'off' }
  let routed: string | undefined
  let remove: (() => void) | undefined
  let opening: Promise<void> | undefined
  let current: Promise<void> | undefined
  let closed = false
  const set = (next: Status) => {
    status = next
    statuses.set(host, next)
  }
  async function unroute(config: Config, token: string | undefined) {
    remove?.()
    remove = undefined
    if (!routed) return
    const name = routed
    routed = undefined
    await withRegistry(files, host.userHome, async (registry) => {
      if (registry.routes[name]?.owner === owner) delete registry.routes[name]
      if (config.domain && (await running(files))) await apply(files, config, registry, token)
    })
  }
  async function run() {
    if (closed) return
    try {
      const settings = await settingsOf(host.userHome)
      const config = configOf(settings)
      const token = config.dns ? await readSecret(host.userHome, TOKEN) : undefined
      const entry = settings.serve?.[host.projectRoot]
      if (!entry) {
        await unroute(config, token)
        return set({ state: 'off' })
      }
      if (temporary) return set({ state: 'off', hint: 'Previews are not served by Caddy.' })
      if (process.env.ULTIMATE_HOST === '0.0.0.0')
        return set({
          state: 'not-loopback',
          hint: 'This Ultimate listens on every interface (--host 0.0.0.0); Caddy serves only loopback ones.',
        })
      if (!config.domain || (!config.dns && !config.cert))
        return set({ state: 'unconfigured', hint: 'Set the domain and a DNS provider in Hosting.' })
      if (config.dns && !token)
        return set({ state: 'unconfigured', hint: `Add ${TOKEN} in Secrets.` })
      const binary = await probe(files, config.dns)
      if (!binary) return set({ state: 'not-installed', hint: 'Install Caddy in Hosting.' })
      if (binary.module === false)
        return set({
          state: 'missing-module',
          hint: `This Caddy lacks caddy-dns/${config.dns}; install it again in Hosting.`,
        })
      if (!PORT(entry.port)) {
        await unroute(config, token)
        return set({ state: 'off', hint: 'Tick this project again in Hosting to give it a port.' })
      }
      set({ state: 'starting' })
      const port = String(entry.port)
      const url = originOf(entry.port, config)
      const target = host.system().process.url
      await withRegistry(files, host.userHome, async (registry) => {
        const holder = registry.routes[port]
        if (holder && holder.root !== host.projectRoot)
          throw new Error(`Port ${port} is served for ${holder.root}`)
        if (routed && routed !== port) delete registry.routes[routed]
        registry.routes[port] = { root: host.projectRoot, target, owner }
        await apply(files, config, registry, token)
        routed = port
      })
      remove?.()
      remove = host.access.allow({ origin: url, verify: () => ({ login: 'reverse-proxy' }) })
      set({ state: 'ready', url })
    } catch (error) {
      set({
        state: 'error',
        hint: String(error instanceof Error ? error.message : error).slice(0, 500),
      })
      host.notice(`Caddy: ${status.hint}`)
    }
  }
  function begin() {
    current ??= run().finally(() => (current = undefined))
    return (opening = current)
  }
  host.onOpen(begin)
  retries.set(host, begin)
  host.onClose(async () => {
    closed = true
    await opening
    try {
      const settings = await settingsOf(host.userHome)
      const config = configOf(settings)
      await unroute(config, config.dns ? await readSecret(host.userHome, TOKEN) : undefined)
    } catch (error) {
      host.notice(`Caddy: could not remove this project's route: ${String(error)}`)
    }
    set({ state: 'off' })
  })
  host.want(TailscaleApi)
  const ours = (route: Route) => route.owner.split(':')[0] === String(process.pid)
  host.resource('caddy:published', () => {
    host.onClose(async () => {
      const config = configOf(await settingsOf(host.userHome))
      const token = config.dns ? await readSecret(host.userHome, TOKEN) : undefined
      await withRegistry(files, host.userHome, async (registry) => {
        const mine = Object.keys(registry.routes).filter(
          (key) => registry.routes[key].published && ours(registry.routes[key]),
        )
        if (!mine.length) return
        for (const key of mine) delete registry.routes[key]
        if (config.domain && (await running(files))) await apply(files, config, registry, token)
      })
    })
    return true
  })
  host.implement(CaddyApi, {
    async publish(port, target) {
      const settings = await settingsOf(host.userHome)
      const config = configOf(settings)
      if (temporary || !settings.serve?.[host.projectRoot] || !config.domain) return undefined
      if (!config.dns && !config.cert) return undefined
      const token = config.dns ? await readSecret(host.userHome, TOKEN) : undefined
      if (config.dns && !token) return undefined
      if (!(await probe(files, config.dns))) return undefined
      const key = String(port)
      await allocating(host.userHome, async () => {
        const serve = (await settingsOf(host.userHome)).serve ?? {}
        const reserved = Object.entries(serve).find(([, entry]) => entry.port === port)
        if (reserved) throw new Error(`Port ${port} is served for ${reserved[0]}`)
        await withRegistry(files, host.userHome, async (registry) => {
          const holder = registry.routes[key]
          if (holder && !(holder.published && ours(holder)))
            throw new Error(`Port ${port} is served for ${holder.root}`)
          registry.routes[key] = { root: host.projectRoot, target, owner, published: true }
          await apply(files, config, registry, token)
        })
      })
      return originOf(port, config)
    },
    async unpublish(port) {
      const config = configOf(await settingsOf(host.userHome))
      const token = config.dns ? await readSecret(host.userHome, TOKEN) : undefined
      await withRegistry(files, host.userHome, async (registry) => {
        const route = registry.routes[String(port)]
        if (!route?.published || !ours(route)) return
        delete registry.routes[String(port)]
        if (config.domain && (await running(files))) await apply(files, config, registry, token)
      })
    },
  })
  set(status)
  return defineExtension({ name: 'caddy' })
}

export const caddyfilePath = (userHome: string) => paths(userHome).caddyfile
export const readCaddyfile = (userHome: string) =>
  existsSync(caddyfilePath(userHome)) ? readFile(caddyfilePath(userHome), 'utf8') : undefined
