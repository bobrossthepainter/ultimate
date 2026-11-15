import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { alive } from '../lib/lock.ts'
import { meansNone } from '../lib/errors.ts'
import { projectHome } from '../lib/project-paths.ts'

export interface UnitOptions {
  clone: string
  project: string
  home: string
  node: string
  path: string
}

export const TEMPLATE = 'ultimate@.service'
export const LEGACY = 'ultimate.service'
export const instanceOf = (home: string) => `ultimate@${basename(home)}.service`
export const ALREADY_RUNNING = 3

export interface Unit {
  name: string
  content: string
}

interface Service {
  label: string
  cwd: string
  env: Record<string, string>
  args: string[]
}

function unit(description: string, service: string[]) {
  return [
    '[Unit]',
    `Description=${description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    ...service,
    'Restart=on-failure',
    'RestartSec=5',
    'KillSignal=SIGTERM',
    'KillMode=mixed',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

const systemdSpecialCharacters = /[\s"'\\%$]/

export function checkPaths(paths: Record<string, string>) {
  for (const [name, path] of Object.entries(paths))
    if (systemdSpecialCharacters.test(path))
      throw new Error(
        `${name} path ${JSON.stringify(path)} contains whitespace or one of " ' \\ % $, which systemd units treat specially; move it to a plain path.`,
      )
}

export function selfUnits(
  units: string[],
  env: { INVOCATION_ID?: string; ULTIMATE_SUPERVISED?: string; ULTIMATE_HOME?: string },
  invocation: (unit: string) => string,
  legacyHome?: string,
) {
  const own = env.ULTIMATE_SUPERVISED === '1' ? env.ULTIMATE_HOME : undefined
  return units.filter(
    (name) =>
      (!!own && (name === instanceOf(own) || (name === LEGACY && legacyHome === own))) ||
      (!!env.INVOCATION_ID && invocation(name) === env.INVOCATION_ID),
  )
}

const INSTANCE = /^[A-Za-z0-9_.:-]+$/

export function renderServiceEnv(project: string, port: number) {
  checkPaths({ project })
  return `ULTIMATE_PROJECT=${project}\nULTIMATE_PORT=${port}\n`
}

function portIn(file: string) {
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const port = Number(
    file.endsWith('.env')
      ? /^ULTIMATE_PORT=(\d+)$/m.exec(text)?.[1]
      : (JSON.parse(text) as { port?: number }).port,
  )
  return Number.isInteger(port) && port > 0 ? port : undefined
}

export async function servicePorts(
  homes: string[],
  projectsDir: string,
  free: (port: number) => Promise<boolean>,
) {
  const others = existsSync(projectsDir)
    ? readdirSync(projectsDir).map((name) => join(projectsDir, name))
    : []
  const taken = new Set(
    others.flatMap((home) =>
      [portIn(join(home, 'service.env')), portIn(join(home, 'ultimate.lock'))].filter(
        (port) => port !== undefined,
      ),
    ),
  )
  const ports: number[] = []
  for (const home of homes) {
    let port = portIn(join(home, 'service.env')) ?? portIn(join(home, 'ultimate.lock'))
    if (port === undefined) {
      port = 4747
      while (taken.has(port) || !(await free(port))) port++
      taken.add(port)
    }
    ports.push(port)
  }
  return ports
}

export const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const server = createServer()
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })

const marker = '__ULTIMATE_PATH__'
const interactiveLoginShellFlags = '-lic'

export function loginPath(
  current: string,
  shell = process.env.SHELL || userInfo().shell || '/bin/sh',
  run: (shell: string, args: string[]) => string = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }),
) {
  let login = ''
  try {
    login =
      run(shell, [interactiveLoginShellFlags, `printf '\n${marker}%s\n' "$PATH"`])
        .split('\n')
        .find((line) => line.startsWith(marker))
        ?.slice(marker.length) ?? ''
  } catch (error) {
    meansNone(error)
  }
  return [login, current].filter(Boolean).join(':')
}

export function servicePath(node: string, path: string, misread?: RegExp) {
  const persistentAbsoluteUserPaths = path
    .split(':')
    .filter(
      (entry) =>
        entry.startsWith('/') &&
        !entry.includes('/node_modules/') &&
        !entry.includes('/.tools/') &&
        !misread?.test(entry),
    )
  return [
    ...new Set([
      dirname(node),
      ...persistentAbsoluteUserPaths,
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]),
  ].join(':')
}

function services(options: UnitOptions, path: string): Service[] {
  const { clone, project, node } = options
  return [
    {
      label: 'com.ultimate.app',
      cwd: project,
      env: { PATH: path, ULTIMATE_NO_OPEN: '1' },
      args: [node, join(clone, 'bin/ultimate.ts')],
    },
  ]
}

export function renderUnits(options: Omit<UnitOptions, 'project'>): Unit[] {
  const { clone, home, node } = options
  checkPaths({ clone, home, node })
  const path = servicePath(node, options.path, systemdSpecialCharacters)
  return [
    {
      name: TEMPLATE,
      content: unit('Ultimate (%i)', [
        `WorkingDirectory=${clone}`,
        `EnvironmentFile=${join(home, '.ultimate/projects/%i/service.env')}`,
        `Environment=PATH=${path}`,
        'Environment=ULTIMATE_NO_OPEN=1',
        `ExecStart=${node} ${join(clone, 'bin/ultimate.ts')} \${ULTIMATE_PROJECT}`,
        `RestartPreventExitStatus=${ALREADY_RUNNING}`,
      ]),
    },
  ]
}

export const legacyProject = (content: string) => /^WorkingDirectory=(.+)$/m.exec(content)?.[1]

export interface Agent {
  label: string
  name: string
  content: string
}

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

const string = (value: string) => `<string>${xml(value)}</string>`

export const agentLog = (home: string, label: string) =>
  join(home, 'Library/Logs/ultimate', `${label}.log`)

export function renderAgents(options: UnitOptions): Agent[] {
  const path = servicePath(options.node, options.path)
  return services(options, path).map(({ label, cwd, env, args }) => {
    const log = agentLog(options.home, label)
    return {
      label,
      name: `${label}.plist`,
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>Label</key>',
        `  ${string(label)}`,
        '  <key>ProgramArguments</key>',
        '  <array>',
        ...args.map((arg) => `    ${string(arg)}`),
        '  </array>',
        '  <key>WorkingDirectory</key>',
        `  ${string(cwd)}`,
        '  <key>EnvironmentVariables</key>',
        '  <dict>',
        ...Object.entries(env).flatMap(([key, value]) => [
          `    <key>${xml(key)}</key>`,
          `    ${string(value)}`,
        ]),
        '  </dict>',
        '  <key>RunAtLoad</key>',
        '  <true/>',
        '  <key>KeepAlive</key>',
        '  <dict>',
        '    <key>SuccessfulExit</key>',
        '    <false/>',
        '  </dict>',
        '  <key>StandardOutPath</key>',
        `  ${string(log)}`,
        '  <key>StandardErrorPath</key>',
        `  ${string(log)}`,
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    }
  })
}

export interface AgentState {
  label: string
  file: string
  state: 'new' | 'replaced' | 'unchanged'
}

export function loadAgents(
  agents: AgentState[],
  uid: number,
  env: { XPC_SERVICE_NAME?: string; ULTIMATE_SUPERVISED?: string },
  launchctl: (args: string[]) => number,
  log: (line: string) => void,
) {
  const domain = `gui/${uid}`
  for (const { label, file, state } of agents) {
    const target = `${domain}/${label}`
    if (state === 'unchanged') {
      if (launchctl(['print', target]) !== 0) launchctl(['bootstrap', domain, file])
      continue
    }
    const wouldRestartOwnAgent =
      state === 'replaced' &&
      ((env.ULTIMATE_SUPERVISED === '1' && label === 'com.ultimate.app') ||
        env.XPC_SERVICE_NAME === label)
    if (wouldRestartOwnAgent) {
      log(`${label} changed: restart it yourself.`)
      continue
    }
    launchctl(['bootout', target])
    if (launchctl(['bootstrap', domain, file]) !== 0)
      throw new Error(`launchctl bootstrap ${domain} ${file} failed.`)
  }
}

async function main() {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    console.error(
      `pnpm setup:machine supports Linux (systemd) and macOS (launchd), not ${process.platform}.`,
    )
    process.exit(1)
  }
  const { values } = parseArgs({
    options: {
      project: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean' },
    },
  })
  const dry = values['dry-run'] === true
  const home = homedir()
  const clone = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const projects = (values.project ?? [clone]).map((project) => realpathSync(resolve(project)))
  const options = {
    clone,
    project: projects[0],
    home,
    node: process.execPath,
    path: loginPath(process.env.PATH ?? ''),
  }

  const mkdir = (dir: string) => {
    if (existsSync(dir)) return
    console.log(`$ mkdir -p ${dir}`)
    if (!dry) mkdirSync(dir, { recursive: true })
  }
  const write = (dir: string, files: { name: string; content: string }[]) =>
    files.map(({ name, content }) => {
      const file = join(dir, name)
      const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined
      const state = current === content ? 'unchanged' : current === undefined ? 'new' : 'replaced'
      if (state === 'unchanged') {
        console.log(`${file}: unchanged`)
        if (dry) console.log(content)
      } else {
        console.log(`${file}: ${state}\n${content}`)
        if (!dry) writeFileSync(file, content)
      }
      return { name, file, state } as const
    })

  if (process.platform === 'darwin') {
    if (projects.length > 1) throw new Error('On macOS one project runs as a launchd agent.')
    const agents = renderAgents(options)
    const dir = join(home, 'Library/LaunchAgents')
    mkdir(dir)
    mkdir(join(home, 'Library/Logs/ultimate'))
    const written = write(dir, agents)
    loadAgents(
      agents.map(({ label }, index) => ({ label, ...written[index] })),
      process.getuid!(),
      process.env,
      (args) => {
        const readOnlyLoadedStateQuery = args[0] === 'print'
        if (readOnlyLoadedStateQuery)
          return spawnSync('launchctl', args, { stdio: 'ignore' }).status ?? 1
        console.log(`$ launchctl ${args.join(' ')}`)
        if (dry) return 0
        return spawnSync('launchctl', args, { stdio: 'inherit' }).status ?? 1
      },
      console.log,
    )
    console.log('The agent runs while you are logged in.')
    if (dry) console.log('Dry run: nothing changed.')
    return
  }

  const run = (command: string, args: string[]) => {
    console.log(`$ ${command} ${args.join(' ')}`)
    if (!dry) execFileSync(command, args, { stdio: 'inherit' })
  }
  const dir = join(home, '.config/systemd/user')
  const legacy = join(dir, LEGACY)
  const written = existsSync(legacy) && legacyProject(readFileSync(legacy, 'utf8'))
  const migrated = written && realpathSync(written)
  if (migrated && !projects.includes(migrated)) projects.push(migrated)
  const homes = projects.map((project) => projectHome(project, home))
  for (const project of homes)
    if (!INSTANCE.test(basename(project)))
      throw new Error(`${project} needs escaping as a systemd instance name; rename its folder.`)
  const ports = await servicePorts(homes, join(home, '.ultimate/projects'), portFree)
  mkdir(dir)
  const [template] = write(dir, renderUnits(options))
  const envs = homes.map((project, index) => {
    mkdir(project)
    return write(project, [
      { name: 'service.env', content: renderServiceEnv(projects[index], ports[index]) },
    ])[0]
  })
  const instances = homes.map(instanceOf)
  const inside = selfUnits(
    [LEGACY, ...instances],
    process.env,
    (name) => query(['show', name, '-p', 'InvocationID']),
    migrated ? projectHome(migrated, home) : undefined,
  )
  if (migrated) {
    if (inside.includes(LEGACY))
      console.log(
        `${LEGACY} is replaced by ${instanceOf(projectHome(migrated, home))}; switch yourself: systemctl --user stop ${LEGACY}, then systemctl --user start ${instanceOf(projectHome(migrated, home))}.`,
      )
    else run('systemctl', ['--user', 'stop', LEGACY])
    run('systemctl', ['--user', 'disable', LEGACY])
    console.log(`$ rm ${legacy}`)
    if (!dry) rmSync(legacy)
  }
  run('systemctl', ['--user', 'daemon-reload'])
  run('systemctl', ['--user', 'enable', ...instances])
  instances.forEach((name, index) => {
    const changed = template.state === 'replaced' || envs[index].state === 'replaced'
    if (!active(name) && runsByHand(homes[index]))
      console.log(
        `${projects[index]} runs outside systemd now: stop it, then systemctl --user start ${name}.`,
      )
    else if (inside.includes(name)) {
      if (changed) console.log(`${name} changed: systemctl --user restart ${name} yourself.`)
    } else run('systemctl', ['--user', changed ? 'restart' : 'start', name])
  })
  const user = userInfo().username
  const linger = execFileSync('loginctl', ['show-user', user, '-p', 'Linger', '--value'], {
    encoding: 'utf8',
  }).trim()
  if (linger === 'yes') console.log(`Linger is already enabled for ${user}.`)
  else run('loginctl', ['enable-linger', user])
  if (dry) console.log('Dry run: nothing changed.')
}

function query(args: string[]) {
  return execFileSync('systemctl', ['--user', ...args, '--value'], { encoding: 'utf8' }).trim()
}

const active = (name: string) =>
  spawnSync('systemctl', ['--user', 'is-active', '--quiet', name]).status === 0

function runsByHand(home: string) {
  const lock = join(home, 'ultimate.lock')
  return existsSync(lock) && alive((JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid)
}

if (import.meta.main) await main()
