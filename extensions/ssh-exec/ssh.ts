import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { join } from 'node:path'
import { spawnGroup } from '../../lib/process-group.ts'
import { execFile, spawn } from '../../lib/spawn.ts'
import type { ExecProtocol, ExecTarget } from '../exec/api.ts'

/** One `ssh-exec.targets` entry, as the settings give it. */
export type Target = {
  id: string
  root: string
  files: 'shared'
  host: string
  port: number
  user: string
  identityFile: string
  knownHostsFile: string
}

const absolute = (value: unknown) => typeof value === 'string' && value.startsWith('/')
const text = (value: unknown) => typeof value === 'string' && value !== '' && !value.startsWith('-')

/** The targets in `ssh-exec` settings, every field checked: settings are a hand-editable file. */
export function targetsOf(settings: unknown): Target[] {
  const list = (settings as { targets?: unknown } | undefined)?.targets ?? []
  if (!Array.isArray(list)) throw new Error('ssh-exec.targets must be an array')
  const ids = new Set<string>()
  return list.map((entry: Record<string, unknown>, index) => {
    const fail = (field: string, rule: string) =>
      new Error(`ssh-exec.targets[${index}].${field} ${rule}`)
    if (entry?.files === 'remote')
      throw fail(
        'files',
        "is 'remote', which is not supported: only 'shared' (the same files at the same paths)",
      )
    if (entry?.files !== 'shared') throw fail('files', "must be 'shared'")
    if (!text(entry.id) || ids.has(entry.id as string)) throw fail('id', 'must be a unique name')
    ids.add(entry.id as string)
    for (const field of ['root', 'identityFile', 'knownHostsFile'])
      if (!absolute(entry[field])) throw fail(field, 'must be an absolute path')
    for (const field of ['host', 'user'])
      if (!text(entry[field])) throw fail(field, 'must be a name')
    const port = entry.port ?? 22
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
      throw fail('port', 'must be a port number')
    return {
      id: entry.id as string,
      root: (entry.root as string).replace(/(.)\/+$/, '$1'),
      files: 'shared',
      host: entry.host as string,
      port: port as number,
      user: entry.user as string,
      identityFile: entry.identityFile as string,
      knownHostsFile: entry.knownHostsFile as string,
    }
  })
}

export const address = (target: Target) => `${target.user}@${target.host}:${target.port}`

/**
 * ssh's options for `target`: no config files, no prompts, the host key pinned by the target's known_hosts alone (an
 * unknown or changed key is refused, never learned), and one multiplexed connection per target under `sockets`.
 */
export const sshArgs = (target: Target, sockets: string) => [
  '-F',
  '/dev/null',
  '-T',
  '-e',
  'none',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  `UserKnownHostsFile=${target.knownHostsFile}`,
  '-o',
  'GlobalKnownHostsFile=/dev/null',
  '-o',
  'UpdateHostKeys=no',
  '-o',
  'CheckHostIP=no',
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  `IdentityFile=${target.identityFile}`,
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
  '-o',
  'ControlMaster=auto',
  '-o',
  `ControlPath=${join(sockets, target.id)}`,
  '-o',
  'ControlPersist=600',
  '-o',
  'LogLevel=ERROR',
  '-l',
  target.user,
  '-p',
  String(target.port),
  '--',
  target.host,
]

/**
 * Runs on the target: `cd` to the directory, export the variables, then start the command as its own session and
 * process group. Its input is the SSH channel, which nothing writes to: EOF means the local ssh is gone (killed,
 * aborted, timed out), and the whole group gets TERM, then KILL 3 s later. A group the command leaves behind when it
 * exits is stopped the same way, as `spawnGroup` does locally.
 */
const wrapper = `cd "$1" || exit 126
shift
while [ "$1" != -- ]; do export "$1"; shift; done
shift
exec 3<&0
setsid "$@" </dev/null 3<&- &
child=$!
( while read -r _; do :; done; kill -TERM -$child; sleep 3; kill -KILL -$child ) <&3 >/dev/null 2>&1 &
watch=$!
exec 3<&-
wait $child
code=$?
kill $watch
kill -TERM -$child 2>/dev/null && { (sleep 3; kill -KILL -$child) </dev/null >/dev/null 2>&1 & }
exit $code`

/**
 * Locally, ssh runs with a private FIFO as its input, opened read-write so it never sees EOF: execFile, spawnGroup and
 * Pi's environment close or ignore a command's input, which would end the remote side at once.
 */
const hold = 'd=$(mktemp -d) && mkfifo "$d/in" && exec 0<>"$d/in" && rm -r "$d" && exec ssh "$@"'

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/** The variables `env` sets differently from this process: what the caller added for the command. */
function added(env: NodeJS.ProcessEnv | undefined) {
  if (!env) return []
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && process.env[name] !== value)
    .map(([name, value]) => {
      // Names reach `export` on the target; one that is not a shell name would be parsed as something else.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`ssh-exec cannot pass the variable ${JSON.stringify(name)}`)
      return `${name}=${value}`
    })
}

/**
 * The local program and arguments that run `file args` in `cwd` on `target` with the variables `env` adds. The remote
 * login shell parses one command line, so every word is single-quoted: nothing in a path, an argument or a value is
 * ever interpreted.
 */
export function command(
  target: Target,
  sockets: string,
  cwd: string,
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): [string, string[]] {
  const remote = ['exec', '/bin/sh', '-c', quote(wrapper), 'sh']
    .concat([cwd, ...added(env), '--', file, ...args].map(quote))
    .join(' ')
  return ['/bin/sh', ['-c', hold, 'sh', ...sshArgs(target, sockets), remote]]
}

/**
 * The `ssh` protocol over targets whose files this machine shares: commands run on the target, the agent's file
 * system stays local. `exited` hears every exit code of a remote command (255 is ssh's own failure).
 */
export function sshProtocol(
  sockets: string,
  exited: (target: Target, code: number | null) => void,
): ExecProtocol {
  const configOf = (target: ExecTarget) => target.config as Target
  return {
    async run(target, cwd, file, args, options = {}) {
      const config = configOf(target)
      const [program, words] = command(config, sockets, cwd, file, args, options.env)
      try {
        const result = await execFile(program, words, { ...options, cwd, env: process.env })
        exited(config, 0)
        return result
      } catch (error) {
        const code = (error as { code?: unknown }).code
        exited(config, typeof code === 'number' ? code : null)
        throw error
      }
    },
    start(target, cwd, file, args, options = {}) {
      const config = configOf(target)
      const [program, words] = command(config, sockets, cwd, file, args, options.env)
      const group = spawnGroup(program, words, { ...options, cwd, env: process.env })
      group.child.once('exit', (code) => exited(config, code))
      return group
    },
    env(target, cwd): ExecutionEnv {
      const config = configOf(target)
      const remote = ((
        file: string,
        args: readonly string[] = [],
        options: Parameters<typeof spawn>[2] = {},
      ) => {
        const [program, words] = command(
          config,
          sockets,
          options.cwd?.toString() ?? cwd,
          file,
          args,
          options.env,
        )
        const child = spawn(program, words, { ...options, env: process.env })
        child.once('exit', (code) => exited(config, code))
        return child
      }) as typeof spawn
      return new NodeExecutionEnv({ cwd, spawn: remote })
    },
  }
}

/** Connect to `target` (or reuse its connection) and run `true`: undefined when it is reachable, else ssh's reason. */
export async function probe(target: Target, sockets: string) {
  try {
    await execFile('ssh', [...sshArgs(target, sockets), 'true'], { timeout: 20000 })
    return undefined
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message: string }
    return (stderr?.trim() || message).split('\n').slice(-3).join(' ')
  }
}

/** Stop `target`'s shared connection from taking new sessions; it ends once the ones still running end. */
export const release = (target: Target, sockets: string) =>
  execFile('ssh', [...sshArgs(target, sockets).slice(0, -2), '-O', 'stop', '--', target.host], {
    timeout: 5000,
  })
