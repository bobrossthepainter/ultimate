// Installs Ultimate as a service. On Linux each project is an instance of the systemd user template ultimate@.service,
// named after its home in ~/.ultimate/projects/, with linger, so it starts at boot without a login; on macOS one
// project is a launchd agent in ~/Library/LaunchAgents, which runs while the user is logged in.
// Usage: pnpm setup:machine [--project <dir>]... [--dry-run]. See "Cloud backups" in extensions/cloud/README.md.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { rmSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { alive } from '../server/lock.ts'
import { projectHome } from '../server/project.ts'

export interface UnitOptions {
  /** The Ultimate clone that holds bin/ultimate.ts. */
  clone: string
  /** The project the launchd agent opens. */
  project: string
  home: string
  node: string
  /** The user's PATH (`loginPath`), kept after node so the agent finds the same tools as in a terminal. */
  path: string
}

/** The template every project's service is an instance of. */
export const TEMPLATE = 'ultimate@.service'
/** The single-project unit of earlier versions, replaced by the project's instance. */
export const LEGACY = 'ultimate.service'
/** A project's instance: named after its home folder, `ultimate@my-app-1a2b3c4d.service`. */
export const instanceOf = (home: string) => `ultimate@${basename(home)}.service`
/** Exit code of bin/ultimate.ts when the project already runs; the unit does not retry it. */
export const ALREADY_RUNNING = 3

export interface Unit {
  name: string
  content: string
}

/** The launchd agent's service. */
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
    'TimeoutStopSec=30',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** Whitespace and the characters systemd treats specially in unit values: quotes, escapes, specifiers, variables. */
const special = /[\s"'\\%$]/

/** Paths go into units unescaped, so one systemd would read differently is refused rather than escaped. */
export function checkPaths(paths: Record<string, string>) {
  for (const [name, path] of Object.entries(paths))
    if (special.test(path))
      throw new Error(
        `${name} path ${JSON.stringify(path)} contains whitespace or one of " ' \\ % $, which systemd units treat specially; move it to a plain path.`,
      )
}

/**
 * The units this script runs inside, which it must not restart or stop: the one whose InvocationID is the process's
 * INVOCATION_ID, and under Ultimate's supervisor the legacy unit and its own project's instance.
 */
export function selfUnits(
  units: string[],
  env: { INVOCATION_ID?: string; ULTIMATE_SUPERVISED?: string; ULTIMATE_HOME?: string },
  invocation: (unit: string) => string,
) {
  const supervised = env.ULTIMATE_SUPERVISED === '1'
  return units.filter(
    (name) =>
      (supervised &&
        (name === LEGACY || (!!env.ULTIMATE_HOME && name === instanceOf(env.ULTIMATE_HOME)))) ||
      (!!env.INVOCATION_ID && invocation(name) === env.INVOCATION_ID),
  )
}

/** Characters systemd allows in a unit's instance name without escaping. */
const INSTANCE = /^[A-Za-z0-9_.:-]+$/

/** A project's `service.env`, the instance's EnvironmentFile: which project it opens, and on which fixed port. */
export function renderServiceEnv(project: string, port: number) {
  checkPaths({ project })
  return `ULTIMATE_PROJECT=${project}\nULTIMATE_PORT=${port}\n`
}

/** The port in a `service.env` or `ultimate.lock`, when it names one. */
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

/**
 * Each project's fixed port: the one its service already has, else the one it runs on now, else the first port from
 * 4747 up that no other project of this machine has or runs on.
 */
export function servicePorts(homes: string[], projectsDir: string) {
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
  return homes.map((home) => {
    const own = portIn(join(home, 'service.env')) ?? portIn(join(home, 'ultimate.lock'))
    if (own !== undefined) return own
    let port = 4747
    while (taken.has(port)) port++
    taken.add(port)
    return port
  })
}

const marker = '__ULTIMATE_PATH__'

/**
 * The PATH of the user's interactive login shell, where `~/.local/bin`, version managers' shims (mise, asdf) and
 * `PNPM_HOME` are added, followed by `current`'s entries. The script's own PATH alone is not enough: run from a
 * service, over ssh or by an agent it can be the bare `/usr/bin:/bin`, and the agent's `claude`, `gh` and `pnpm` would
 * be missing from the units. A shell that fails or prints no PATH leaves `current`.
 */
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
    // Interactive too: many setups (mise activate, PNPM_HOME) extend PATH only in the rc file.
    login =
      run(shell, ['-lic', `printf '\n${marker}%s\n' "$PATH"`])
        .split('\n')
        .find((line) => line.startsWith(marker))
        ?.slice(marker.length) ?? ''
  } catch {
    // A broken rc file must not stop the setup: the script's own PATH still goes into the units.
  }
  return [login, current].filter(Boolean).join(':')
}

/**
 * The services' PATH: node's folder, the user's absolute entries, then the system folders. pnpm run prepends
 * node_modules/.bin folders and its own version-pinned folder (.tools/@pnpm+exe/<version>), which disappears when pnpm
 * updates itself; a service must depend on neither. `misread` drops entries the service format cannot hold as is.
 */
export function servicePath(node: string, path: string, misread?: RegExp) {
  const user = path
    .split(':')
    .filter(
      (entry) =>
        entry.startsWith('/') &&
        !entry.includes('/node_modules/') &&
        !entry.includes('/.tools/') &&
        !misread?.test(entry),
    )
  return [...new Set([dirname(node), ...user, '/usr/local/bin', '/usr/bin', '/bin'])].join(':')
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

/**
 * Renders the template unit; pure, so the side effects stay in main. Throws for a path systemd would misread. Each
 * instance reads its project and port from `<home>/.ultimate/projects/<instance>/service.env`. Exit 3 means the project
 * already runs (by hand, or another instance): retrying it would loop every RestartSec forever.
 */
export function renderUnits(options: Omit<UnitOptions, 'project'>): Unit[] {
  const { clone, home, node } = options
  checkPaths({ clone, home, node })
  // An entry systemd would misread is left out rather than escaped.
  const path = servicePath(node, options.path, special)
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

/** The project the legacy unit opens: its WorkingDirectory. */
export const legacyProject = (content: string) => /^WorkingDirectory=(.+)$/m.exec(content)?.[1]

export interface Agent {
  label: string
  /** The plist file name in ~/Library/LaunchAgents. */
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

/** The log file launchd writes an agent's stdout and stderr to. */
export const agentLog = (home: string, label: string) =>
  join(home, 'Library/Logs/ultimate', `${label}.log`)

/**
 * Renders the launchd agents; pure, so the side effects stay in main. Plists escape every value, so no path is
 * refused. KeepAlive restarts an agent only after a failed exit, as Restart=on-failure does: bin/ultimate.ts exits 0
 * when asked to stop, and an agent that keeps coming back after a deliberate stop would fight the user.
 */
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

/**
 * Loads the agents into the user's GUI domain. A new or replaced agent is booted out and bootstrapped again, which
 * restarts it on the new plist; an unchanged one is bootstrapped only when not loaded. The replaced agent this
 * script runs inside is left alone: launchd sets XPC_SERVICE_NAME to the job's label, and under Ultimate's supervisor
 * it is com.ultimate.app. `launchctl` runs one command and returns its exit status.
 */
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
    const inside =
      state === 'replaced' &&
      ((env.ULTIMATE_SUPERVISED === '1' && label === 'com.ultimate.app') ||
        env.XPC_SERVICE_NAME === label)
    if (inside) {
      log(`${label} changed: restart it yourself.`)
      continue
    }
    // Fails when the agent is not loaded yet, which is just what bootout should leave behind.
    launchctl(['bootout', target])
    if (launchctl(['bootstrap', domain, file]) !== 0)
      throw new Error(`launchctl bootstrap ${domain} ${file} failed.`)
  }
}

function main() {
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
  // The real path, as bin/ultimate.ts opens it and projectHome hashes it.
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
  /** Writes each changed file and says whether it is new, replaced or unchanged. */
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
        // print only asks whether an agent is loaded, so it runs on a dry run too.
        if (args[0] === 'print')
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
  // The legacy unit's project becomes an instance too, so the migration keeps it running as a service.
  const migrated = existsSync(legacy) && legacyProject(readFileSync(legacy, 'utf8'))
  if (migrated && !projects.includes(migrated)) projects.push(migrated)
  const homes = projects.map((project) => projectHome(project, home))
  for (const project of homes)
    if (!INSTANCE.test(basename(project)))
      throw new Error(`${project} needs escaping as a systemd instance name; rename its folder.`)
  const ports = servicePorts(homes, join(home, '.ultimate/projects'))
  mkdir(dir)
  const [template] = write(dir, renderUnits(options))
  const envs = homes.map((project, index) => {
    mkdir(project)
    return write(project, [
      { name: 'service.env', content: renderServiceEnv(projects[index], ports[index]) },
    ])[0]
  })
  const instances = homes.map(instanceOf)
  // Stopping or restarting the unit this script runs inside would kill the script with it.
  const inside = selfUnits([LEGACY, ...instances], process.env, (name) =>
    query(['show', name, '-p', 'InvocationID']),
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
    // A project running by hand holds its lock: the instance would exit 3 at once.
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

/** Whether a live process holds the project's lock (`ultimate.lock` names its pid). */
function runsByHand(home: string) {
  const lock = join(home, 'ultimate.lock')
  return existsSync(lock) && alive((JSON.parse(readFileSync(lock, 'utf8')) as { pid: number }).pid)
}

if (import.meta.main) main()
