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
 * Runs on the target: `cd` to the directory, then start the command through `env` (which sets the variables for the
 * command alone, so the wrapper's own `setsid` and `sleep` keep the login PATH) as its own session and process group.
 * Its input is the SSH channel, which nothing writes to until the local side closes it: EOF means stop, and the whole
 * group gets TERM, then KILL a second later. The wrapper exits only once nothing of the group is left, so the local
 * ssh, and whoever waits for it, ends after the remote cleanup, never before.
 */
const wrapper = `cd "$1" || exit 126
shift
exec 3<&0
setsid env -- "$@" </dev/null 3<&- &
child=$!
( while read -r _; do :; done; kill -TERM -$child; sleep 1; kill -KILL -$child ) <&3 >/dev/null 2>&1 &
watch=$!
exec 3<&-
wait $child
code=$?
kill $watch 2>/dev/null
if kill -0 -$child 2>/dev/null; then
  kill -TERM -$child
  n=0
  while kill -0 -$child 2>/dev/null && [ $n -lt 10 ]; do sleep 0.1; n=$((n + 1)); done
  kill -KILL -$child 2>/dev/null
  while kill -0 -$child 2>/dev/null; do sleep 0.1; done
fi
exit $code`

/**
 * Locally, ssh runs in its own session, outside the group a caller signals (the ssh client exits at once on TERM, even
 * an ignored one), with a FIFO as its input whose only writer is this shell. TERM, INT or HUP close the writer; so does
 * this shell's death by KILL. Either way ssh sends EOF and the target stops the command (see `wrapper`). This shell
 * exits with ssh's code once ssh exits, which is after the remote group is gone, unless KILL ended it first. The trap
 * comes first and both ends are open before ssh starts: a signal before that runs nothing remote, and any later one
 * closes the writer (#7522 review).
 */
const hold = `stop=
trap 'stop=1' TERM INT HUP
d=$(mktemp -d) && mkfifo "$d/in" || exit 255
exec 5<>"$d/in" 3>"$d/in" 4<"$d/in" 5<&-
rm -r "$d"
trap 'exec 3>&- 4<&-' TERM INT HUP
[ -z "$stop" ] || exit 143
setsid -w ssh "$@" <&4 3>&- 4<&- &
ssh=$!
exec 4<&-
wait $ssh
code=$?
while kill -0 $ssh 2>/dev/null; do wait $ssh; code=$?; done
exit $code`

const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * The variables `env` sets differently from this process: what the caller added for the command. Callers pass this
 * process's environment plus their own variables; the rest (PATH, HOME, ...) is this machine's and must not replace
 * the target's own, so only the difference crosses. Removing a variable is not passed on.
 *
 * Git's `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` only work together: the agent's bash adds
 * its commit hooks after any this process inherited, so when one of them differs, all of them cross. Without that a
 * commit on the target failed with "missing config key GIT_CONFIG_KEY_0" (#7522).
 */
function added(env: NodeJS.ProcessEnv | undefined) {
  if (!env) return []
  const gitConfig = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/
  const changed = (name: string) => process.env[name] !== env[name]
  const wholeGitConfig = Object.keys(env).some((name) => gitConfig.test(name) && changed(name))
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        value !== undefined && (changed(name) || (wholeGitConfig && gitConfig.test(name))),
    )
    .map(([name, value]) => {
      // Names reach `export` on the target; one that is not a shell name would be parsed as something else.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`ssh-exec cannot pass the variable ${JSON.stringify(name)}`)
      return `${name}=${value}`
    })
}

/** `env` would read a program name with `=` as one more variable. */
function checked(file: string) {
  if (file.includes('='))
    throw new Error(`ssh-exec cannot run a program named ${JSON.stringify(file)}`)
  return file
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
    .concat([cwd, ...added(env), checked(file), ...args].map(quote))
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
