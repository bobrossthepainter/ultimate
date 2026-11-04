import { networkInterfaces } from 'node:os'
import { request } from 'node:http'
import { expect, it } from 'vitest'
import { attach, fixture } from './supervisor-helpers.ts'
import { post, until } from '../helpers.ts'

function networkUrl(url: string) {
  const network = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && !entry.internal && entry.family === 'IPv4')
  if (!network) throw new Error('This test needs a non-loopback IPv4 interface')
  return `http://${network.address}:${new URL(url).port}`
}

function status(url: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { headers, method, agent: false }, (response) => {
      resolve(response.statusCode)
      response.destroy()
    })
    req.on('error', reject)
    req.end()
  })
}

it('keeps network access off by default', async () => {
  const running = await fixture()
  const lan = networkUrl(running.url)
  expect((await fetch(running.url + '/api/models')).status).toBe(200)
  expect(await status(running.url + '/api/models', { host: new URL(lan).host })).toBe(403)
  await expect(fetch(lan + '/api/models')).rejects.toThrow('fetch failed')
}, 60000)

it('serves direct IPv4 network access only when opted in, retaining host and origin checks across a core swap', async () => {
  const running = await fixture(['--host', '0.0.0.0'])
  const lan = networkUrl(running.url)
  expect(running.output()).toContain('Listening on all IPv4 interfaces without authentication')
  expect(running.output()).toContain(lan)
  for (const path of ['/', '/api/models', '/api/events']) {
    const response = await fetch(lan + path, { headers: { origin: lan } })
    expect(response.status).toBe(200)
    await response.body?.cancel()
  }
  const rejected: Record<string, string>[] = [
    { host: 'evil.example' },
    { host: 'tais.bb-1.cosmick8s.cc:4747' },
    { origin: 'https://evil.example' },
    { origin: lan, 'sec-fetch-site': 'cross-site' },
    { 'x-forwarded-for': '192.168.1.2' },
  ]
  for (const headers of rejected) expect(await status(lan + '/api/models', headers)).toBe(403)
  const stream = await attach(running.url)
  expect((await post(lan, '/api/restart')).status).toBe(202)
  await until(() => stream.system().process.generation === 2)
  // The old core closes connections while the replacement takes over.
  await until(() =>
    status(lan + '/api/models', {}).then(
      (code) => code === 200,
      () => false,
    ),
  )
  expect(await status(running.url + '/api/models', {})).toBe(200)
}, 60000)

it('admits an explicitly allowed hostname, preserving origin checks across a core swap', async () => {
  const origin = 'http://tais.bb-1.cosmick8s.cc:4747'
  const running = await fixture(['--host', '0.0.0.0', '--allowed-origin', origin])
  const lan = networkUrl(running.url)
  // Connect locally but send the browser's real Host and Origin, without relying on external DNS.
  const headers = { host: new URL(origin).host, origin }
  for (const path of ['/', '/api/models', '/api/events'])
    expect(await status(lan + path, headers)).toBe(200)
  const rejected: Record<string, string>[] = [
    { ...headers, host: 'other.example:4747' },
    { ...headers, host: 'tais.bb-1.cosmick8s.cc:4748' },
    { ...headers, origin: 'http://other.example:4747' },
    { ...headers, origin: 'http://tais.bb-1.cosmick8s.cc:4748' },
    { ...headers, 'x-forwarded-for': '192.168.1.2' },
    { ...headers, 'sec-fetch-site': 'cross-site' },
  ]
  for (const denied of rejected) expect(await status(lan + '/api/models', denied)).toBe(403)
  const stream = await attach(running.url)
  expect(await status(lan + '/api/restart', headers, 'POST')).toBe(202)
  await until(() => stream.system().process.generation === 2)
  // A swap can close an in-flight request while the old core releases storage.
  await until(() =>
    status(lan + '/api/models', headers).then(
      (code) => code === 200,
      () => false,
    ),
  )
}, 60000)

it('admits a TLS reverse proxy origin on the loopback listener for HTTP, SSE and a core swap', async () => {
  const origin = 'https://tais.bb-1.cosmick8s.cc:8443'
  const running = await fixture(['--proxy-origin', origin])
  // What nginx sends with `proxy_set_header Host $http_host` and the browser's own Origin.
  const headers = {
    host: new URL(origin).host,
    origin,
    'x-forwarded-proto': 'https',
    'x-forwarded-port': '8443',
    'x-forwarded-for': '192.168.1.2',
  }
  expect(running.output()).toContain(`Reverse-proxy access`)
  for (const path of ['/', '/api/models', '/api/events'])
    expect(await status(running.url + path, headers)).toBe(200)
  const rejected: Record<string, string>[] = [
    { ...headers, host: 'other.example:8443' },
    { ...headers, host: 'tais.bb-1.cosmick8s.cc:8444' },
    { ...headers, origin: 'http://tais.bb-1.cosmick8s.cc:8443' },
    { ...headers, origin: 'https://tais.bb-1.cosmick8s.cc:8444' },
    { ...headers, 'sec-fetch-site': 'cross-site' },
  ]
  for (const denied of rejected) expect(await status(running.url + '/api/models', denied)).toBe(403)
  const stream = await attach(running.url)
  expect(await status(running.url + '/api/restart', headers, 'POST')).toBe(202)
  await until(() => stream.system().process.generation === 2)
  // A swap can close an in-flight request while the old core releases storage.
  await until(() =>
    status(running.url + '/api/models', headers).then(
      (code) => code === 200,
      () => false,
    ),
  )
  expect((await fetch(running.url + '/api/models')).status).toBe(200)
}, 60000)
