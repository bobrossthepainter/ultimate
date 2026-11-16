// A fresh recipe-list demo project and an untouched Ultimate preview on it. Run from the Ultimate checkout to preview:
//   node .ultimate/skills/preview-demo/demo.ts start [--port 4797] [--model provider/id]   (also resets)
//   node .ultimate/skills/preview-demo/demo.ts stop [--port 4797]
//   node .ultimate/skills/preview-demo/demo.ts project                                       (only print a fresh copy)
import { spawn, execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', default: '4797' },
    model: { type: 'string', default: 'openai-codex/gpt-6.1-sol' },
  },
  allowPositionals: true,
})
const fixture = join(import.meta.dirname, 'fixture')
const port = Number(values.port)
const state = join(tmpdir(), `ultimate-demo-${port}`)

/** Copies the fixture into `to` as a git repository with one commit. */
function project(to: string) {
  cpSync(fixture, to, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: to, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git(
    '-c',
    'user.name=demo',
    '-c',
    'user.email=demo@example.com',
    'commit',
    '-q',
    '-m',
    'Recipe list',
  )
  return to
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false // ESRCH: gone; EPERM cannot happen for our own children
  }
}

/** Stops the demo server on this port by its recorded process group, never by pattern, and removes its files. */
async function stop() {
  const file = join(state, 'pid')
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'))
    const caddy = join(state, 'caddy-port')
    if (existsSync(caddy)) {
      const { unpublishRoute } = await import(resolve(process.cwd(), 'extensions/caddy/server.ts'))
      await unpublishRoute(process.env.HOME, pid, Number(readFileSync(caddy, 'utf8')))
    }
    if (alive(pid)) process.kill(-pid, 'SIGTERM')
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((done) => setTimeout(done, 250))
    if (alive(pid)) process.kill(-pid, 'SIGKILL')
  }
  rmSync(state, { recursive: true, force: true })
}

async function start() {
  const checkout = process.cwd()
  if (!existsSync(join(checkout, 'server/main.ts')) || !existsSync(join(checkout, 'node_modules')))
    throw new Error('Run from an Ultimate checkout with node_modules (the worktree to preview)')
  // The live server's supervisor: the demo exits with it, and owner-run servers never touch the cloud backup.
  const liveHome = process.env.ULTIMATE_HOME
  if (!liveHome)
    throw new Error('Run from an Ultimate agent shell: ULTIMATE_HOME names the live server')
  const owner = JSON.parse(readFileSync(join(liveHome, 'ultimate.lock'), 'utf8')).pid as number
  await stop()
  const busy = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  )
  if (busy) throw new Error(`Port ${port} is taken by something else`)
  mkdirSync(state)
  const dir = project(join(state, 'project'))
  const home = join(state, 'home')
  const userHome = join(home, 'user')
  mkdirSync(home)
  // The same private user config a preview gets, so clicks in the demo never change the real ~/.ultimate.
  const { seedUserHome } = await import(resolve(checkout, 'extensions/instance/server.ts'))
  await seedUserHome(process.env.HOME, userHome)
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('ULTIMATE_')),
  )
  const log = openSync(join(state, 'server.log'), 'a')
  const launch = (origin?: string) => {
    const server = spawn(process.execPath, ['server/main.ts'], {
      cwd: checkout,
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...env,
        ULTIMATE_HOME: home,
        ULTIMATE_PROJECT: dir,
        ULTIMATE_USER_HOME: userHome,
        ULTIMATE_PORT: String(port),
        ULTIMATE_NO_OPEN: '1',
        ULTIMATE_INSTANCE_OWNER: String(owner),
        ULTIMATE_MODEL: values.model,
        ...(origin && { ULTIMATE_PROXY_ORIGIN: origin }),
      },
    })
    writeFileSync(join(state, 'pid'), String(server.pid))
    server.unref()
    return server
  }
  // Served by Caddy like `instance start` previews, from the top of their range down, owned by the demo's pid.
  const caddy = await import(resolve(checkout, 'extensions/caddy/server.ts'))
  const { CADDY_PREVIEW_PORTS } = await import(resolve(checkout, 'extensions/instance/server.ts'))
  let child: ReturnType<typeof spawn> | undefined
  let served: string | undefined
  for (const published of (CADDY_PREVIEW_PORTS as number[]).toReversed()) {
    const origin = await caddy.previewOrigin(
      process.env.HOME,
      process.env.ULTIMATE_PROJECT,
      published,
    )
    if (!origin) break
    child = launch(origin)
    try {
      served = await caddy.publishRoute(
        process.env.HOME,
        process.env.ULTIMATE_PROJECT,
        `${child.pid}:demo`,
        published,
        `http://127.0.0.1:${port}`,
      )
      if (served) writeFileSync(join(state, 'caddy-port'), String(published))
      break
    } catch (error) {
      if (String(error).includes(' is served for ')) {
        const pid = child.pid!
        process.kill(-pid, 'SIGKILL')
        for (let i = 0; i < 40 && alive(pid); i++)
          await new Promise((done) => setTimeout(done, 250))
        child = undefined
        continue
      }
      console.error(`Not served by Caddy: ${String(error)}`)
      break
    }
  }
  child ??= launch()
  for (let i = 0; i < 240; i++) {
    if (!alive(child.pid!)) break
    const ok = await fetch(`http://127.0.0.1:${port}/api/models`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) {
      console.log(
        `${served ? `caddy    ${served}\n` : ''}url      http://127.0.0.1:${port}\nproject  ${dir}\nhome     ${home}\nlog      ${join(state, 'server.log')}`,
      )
      return
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`Demo did not become ready; see ${join(state, 'server.log')}`)
}

const command = positionals[0]
if (command === 'start') await start()
else if (command === 'stop') await stop()
else if (command === 'project')
  console.log(project(join(mkdtempSync(join(tmpdir(), 'ultimate-demo-project-')), 'recipes')))
else throw new Error('Usage: demo.ts start|stop|project [--port N] [--model provider/id]')
