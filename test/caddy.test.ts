import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import caddy, { actions, caddyfilePath } from '../extensions/caddy/server.ts'
import type { Status } from '../extensions/caddy/refs.ts'
import type { CaddyService } from '../extensions/caddy/api.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { createAccess } from '../server/request-security.ts'
import { projectHome } from '../server/project.ts'
import { temp } from './helpers.ts'

const closes: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0)) await close()
  vi.unstubAllEnvs()
})

/** A user home with a stub Caddy binary, a fake admin socket recording each loaded config, and the DNS-01 setup. */
async function fixture() {
  // Directly under /tmp: a Unix socket path is limited to 107 bytes, which a nested test temp dir can exceed.
  const home = await temp('caddy-', '/tmp')
  const dir = join(home, '.ultimate/caddy')
  await mkdir(dir, { recursive: true })
  const binary = join(home, 'caddy')
  await writeFile(
    binary,
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === 'version') console.log('v2.0.0-test h1:stub');
else if (args[0] === 'list-modules') console.log('http.handlers.reverse_proxy\\ndns.providers.cloudflare');
// The fake admin socket below stands in for the started Caddy.
else if (args[0] === 'start') require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'starts'))}, 'start\\n');
else process.exit(1);
`,
  )
  await chmod(binary, 0o755)
  vi.stubEnv('CADDY_COMMAND', binary)
  const loads: string[] = []
  const admin: Server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => {
      if (request.url === '/load') loads.push(body)
      response.end(request.url === '/config/' ? '{}' : '')
    })
  })
  await new Promise<void>((resolve) => admin.listen(join(dir, 'admin.sock'), resolve))
  closes.push(() => new Promise((resolve) => admin.close(() => resolve())))
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({
      caddy: {
        domain: 'ultimate.example.com',
        dns: 'cloudflare',
        serve: { '/project/a': { port: 9443 } },
      },
    }),
  )
  await writeFile(
    join(home, '.ultimate/secrets.json'),
    JSON.stringify({
      secrets: { CADDY_DNS_API_TOKEN: { value: 'secret-token', updatedAt: '2026-01-01' } },
    }),
    { mode: 0o600 },
  )
  return { home, loads }
}

async function instance(home: string, projectRoot = '/project/a', port = 4801) {
  const openers: (() => Promise<void>)[] = []
  const cleanups: (() => Promise<void>)[] = []
  const notices: string[] = []
  const access = createAccess()
  const host = {
    userHome: home,
    home: projectHome(projectRoot, home),
    projectRoot,
    projects: async () => [
      {
        root: projectRoot,
        name: 'a',
        running: { pid: process.pid, url: `http://127.0.0.1:${port}` },
      },
    ],
    access,
    notice: (message: string) => notices.push(message),
    system: () => ({ process: { url: `http://127.0.0.1:${port}` } }),
    onOpen: (fn: () => Promise<void>) => openers.push(fn),
    onClose: (fn: () => Promise<void>) => cleanups.push(fn),
    want: () => undefined,
    implement: (_api: unknown, value: CaddyService) => (service = value),
    resource: <T>(_key: string, create: () => T) => create(),
  } as unknown as ExtensionHost
  let service: CaddyService | undefined
  caddy(host)
  await Promise.all(openers.map((fn) => fn()))
  const close = async () => {
    for (const fn of cleanups.splice(0)) await fn()
  }
  closes.unshift(close)
  const status = () =>
    actions.status(null, { host } as Parameters<typeof actions.status>[1]) as Status
  return { host, access, notices, close, status, service: service! }
}

it('routes a ticked project through Caddy and admits its origin, without the token in any config', async () => {
  const { home, loads } = await fixture()
  const server = await instance(home)

  expect(server.notices).toEqual([])
  expect(server.status()).toEqual({ state: 'ready', url: 'https://ultimate.example.com:9443' })
  expect(server.access.origins()).toEqual(['https://ultimate.example.com:9443'])
  const written = await readFile(caddyfilePath(home), 'utf8')
  expect(written).toContain('ultimate.example.com:9443 {')
  expect(written).toContain('dns cloudflare {env.CADDY_DNS_API_TOKEN}')
  // The LAN resolver answered SERVFAIL for _acme-challenge, so no certificate was ever issued.
  expect(written).toContain('resolvers 1.1.1.1 8.8.8.8')
  expect(written).toContain('reverse_proxy 127.0.0.1:4801')
  expect(loads.at(-1)).toBe(written)
  expect([written, ...loads].join('\n')).not.toContain('secret-token')

  await server.close()
  expect(server.access.origins()).toEqual([])
  expect(loads.at(-1)).not.toContain(':9443 {')
})

it("publishes another extension's loopback service on its own port while the server runs", async () => {
  const { home, loads } = await fixture()
  const server = await instance(home)
  expect(await server.service.publish(9480, 'http://127.0.0.1:19432')).toBe(
    'https://ultimate.example.com:9480',
  )
  expect(loads.at(-1)).toContain('ultimate.example.com:9480 {')
  expect(loads.at(-1)).toContain('reverse_proxy 127.0.0.1:19432')
  // The project's own route stays, and its port is refused to a published service.
  expect(loads.at(-1)).toContain('ultimate.example.com:9443 {')
  await expect(server.service.publish(9443, 'http://127.0.0.1:19433')).rejects.toThrow(
    'Port 9443 is served for /project/a',
  )
  await server.service.unpublish(9480)
  expect(loads.at(-1)).not.toContain(':9480 {')
  expect(loads.at(-1)).toContain('ultimate.example.com:9443 {')

  // A stopped project keeps its ticked port: no published service takes it.
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({
      caddy: {
        domain: 'ultimate.example.com',
        dns: 'cloudflare',
        serve: { '/project/a': { port: 9443 }, '/project/stopped': { port: 9481 } },
      },
    }),
  )
  await expect(server.service.publish(9481, 'http://127.0.0.1:19433')).rejects.toThrow(
    'Port 9481 is served for /project/stopped',
  )
  // Shutdown drops what this process published, after the services are gone.
  await server.service.publish(9480, 'http://127.0.0.1:19432')
  await server.close()
  expect(loads.at(-1)).not.toContain(':9480 {')
})

it('gives each ticked project the next free port, and keeps it when ticked again', async () => {
  const { home } = await fixture()
  const server = await instance(home)
  const projects = async () => [
    { root: '/project/a', name: 'a' },
    { root: '/project/b', name: 'b' },
  ]
  const ctx = { host: { ...server.host, userHome: home, projects } } as Parameters<
    typeof actions.serve
  >[1]
  expect(await actions.serve({ root: '/project/b', on: true }, ctx)).toEqual({ port: 9444 })
  expect(await actions.serve({ root: '/project/a', on: true }, ctx)).toEqual({ port: 9443 })
  expect(await actions.serve({ root: '/project/b', on: false }, ctx)).toEqual({})
  expect(await actions.serve({ root: '/project/b', on: true }, ctx)).toEqual({ port: 9444 })
})

it('routes a port at once to the project that took it, while the unticked one still runs', async () => {
  const { home } = await fixture()
  await instance(home)
  // a is unticked and b takes 9443 before a's server has removed its route.
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({
      caddy: {
        domain: 'ultimate.example.com',
        dns: 'cloudflare',
        serve: { '/project/b': { port: 9443 } },
      },
    }),
  )
  const other = await instance(home, '/project/b', 4802)
  expect(other.status()).toEqual({ state: 'ready', url: 'https://ultimate.example.com:9443' })
  expect(await readFile(caddyfilePath(home), 'utf8')).toContain('reverse_proxy 127.0.0.1:4802')
})

it('refuses a port another live project holds', async () => {
  const { home } = await fixture()
  await instance(home)
  await writeFile(
    join(home, '.ultimate/settings.json'),
    JSON.stringify({
      caddy: {
        domain: 'ultimate.example.com',
        dns: 'cloudflare',
        serve: { '/project/a': { port: 9443 }, '/project/b': { port: 9443 } },
      },
    }),
  )
  const other = await instance(home, '/project/b', 4802)
  expect(other.status()).toMatchObject({
    state: 'error',
    hint: 'Port 9443 is served for /project/a',
  })
  expect(other.access.origins()).toEqual([])
})
